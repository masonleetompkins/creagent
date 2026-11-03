// Content analysis: unanalyzed assets -> voice profile + vault + pillars.
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { getDb, nowIso, withTransaction } from "./db";
import { embedMany, vectorToBlob } from "./embeddings";
import { loadKeys } from "./keys";
import { getMetaClient, metaTextModel } from "./meta";
import { autoConfirmTopPillars, pillarStats, refreshMultipliers } from "./metrics";

const MAX_ASSETS = 100;
const MAX_ASSET_CHARS = 8000;
const MAX_TOTAL_CHARS = 80000;
// Digested assets cost this much budget; digests are clamped to it.
export const DIGEST_CHARS = 3000;
// Hard input clamp for the digest call itself (~50k tokens, well in-window).
const DIGEST_INPUT_CLAMP = 200000;

export type AssetRow = {
  id: string;
  source: string;
  title: string | null;
  transcript: string | null;
};

// Split picked rows into direct inclusions vs. long transcripts that need a
// dedicated digest pass. Pure over row lengths so it can be unit-tested.
export function planCorpus(rows: AssetRow[]): { direct: AssetRow[]; digest: AssetRow[] } {
  const direct: AssetRow[] = [];
  const digest: AssetRow[] = [];
  let total = 0;
  for (const row of rows) {
    const len = (row.transcript ?? "").length;
    const cost = len > MAX_ASSET_CHARS ? DIGEST_CHARS : len;
    if (total + cost > MAX_TOTAL_CHARS) break;
    total += cost;
    (len > MAX_ASSET_CHARS ? digest : direct).push(row);
  }
  return { direct, digest };
}

const DIGEST_SYSTEM = `You distill a long transcript for a creator-analysis pipeline. Read the TRANSCRIPT and output plain compact text (no preamble, no markdown headers) under 2500 characters covering, in order: (1) the ideas and arguments made, in the order raised; (2) key stories, examples, and stances; (3) 2-4 short verbatim lines worth quoting; (4) 2-3 short verbatim excerpts showing how they speak. Never invent content; compress, don't summarize away specifics.`;

export async function digestLongTranscript(
  client: ReturnType<typeof getMetaClient>,
  title: string,
  transcript: string,
): Promise<string> {
  const resp = await client.responses.create(
    {
      model: metaTextModel(),
      input: `${DIGEST_SYSTEM}\n\nTITLE: ${title}\n\nTRANSCRIPT:\n${transcript.slice(0, DIGEST_INPUT_CLAMP)}`,
      max_output_tokens: 1200,
      reasoning: { effort: "low" },
    },
    { timeout: 180000 },
  );
  return resp.output_text.trim().slice(0, DIGEST_CHARS);
}

type DigestCache = { chars: number; digest: string };

// Digests are cached on the asset so regenerates don't re-bill them.
export function readDigestCache(db: DatabaseSync, id: string, chars: number): string | null {
  try {
    const row = db.prepare(`SELECT metadata FROM assets WHERE id = ?`).get(id) as {
      metadata: string;
    };
    const meta = JSON.parse(row.metadata || "{}") as { transcript_digest?: DigestCache };
    const cached = meta.transcript_digest;
    if (cached && cached.chars === chars && cached.digest) return cached.digest;
  } catch {
    /* no usable cache */
  }
  return null;
}

export function buildCorpus(picked: AssetRow[], digests: Map<string, string>): string {
  return picked
    .map((row, i) => {
      const text = row.transcript ?? "";
      const d = digests.get(row.id);
      if (d) {
        const k = Math.max(1, Math.round(text.length / 1000));
        return `[${i + 1}] (${row.source}) ${row.title ?? ""}\n[DIGEST of ~${k}k chars]\n${d}`;
      }
      return `[${i + 1}] (${row.source}) ${row.title ?? ""}\n${text.slice(0, MAX_ASSET_CHARS)}`;
    })
    .join("\n\n---\n\n");
}

export function writeDigestCache(db: DatabaseSync, id: string, chars: number, digest: string): void {
  let meta: Record<string, unknown> = {};
  try {
    const row = db.prepare(`SELECT metadata FROM assets WHERE id = ?`).get(id) as {
      metadata: string;
    };
    const parsed: unknown = JSON.parse(row.metadata || "{}");
    if (parsed && typeof parsed === "object") meta = parsed as Record<string, unknown>;
  } catch {
    /* start fresh */
  }
  meta["transcript_digest"] = { chars, digest } satisfies DigestCache;
  db.prepare(`UPDATE assets SET metadata = ? WHERE id = ?`).run(JSON.stringify(meta), id);
}

export type AnalysisResult = {
  assetsAnalyzed: number;
  pillars: number;
  vaultDocs: number;
};

const CONSOLIDATE_SYSTEM = `You consolidate a content creator's content pillars. There are too many overlapping suggestions; merge the CANDIDATES into 10-12 canonical pillars.

Each candidate has: name, posts (linked post count), recent (posts in the last 6 months), mult (average views multiplier vs their own typical views, 1.0 = average).

Rules:
- Every canonical pillar must be specific enough to repeat weekly, but broad enough to hold many posts.
- Bias HARD toward the last 6 months: candidates with zero recent posts fold into the closest fit, never survive alone.
- Favor high multipliers: a pillar at 1.5x or more deserves to survive or lend its name.
- Merge near-duplicates aggressively (same topic, different words).
- Respond with ONLY a JSON object (no prose, no code fences):
{"pillars": [{"name": "canonical name", "description": "one sentence", "voice_notes": "how their voice shifts for this pillar", "absorbs": ["exact candidate names folded into this one"]}]}
- Every candidate name must appear exactly once across all absorbs lists. To keep a candidate as-is, use its name with absorbs containing just itself.`;

export type ConsolidationEntry = {
  name: string;
  description: string;
  voiceNotes: string;
  absorbs: string[];
};

export type ConsolidationResult = {
  merged: number;
  canonical: number;
  unmapped: string[];
  // Names auto-confirmed into the 5 slots, rank order. Empty when the caller
  // is the pure transactional apply (it never touches confirmed flags).
  confirmed: string[];
};

// Re-point every pillar link (posts, slots, templates) from one pillar to another.
function repointPillar(fromId: string, toId: string): void {
  const db = getDb();
  for (const table of ["assets", "queue_slots", "queue_templates"] as const) {
    db.prepare(`UPDATE ${table} SET pillar_id = ? WHERE pillar_id = ?`).run(toId, fromId);
  }
}

function writePillarVaultDoc(name: string, description: string, voiceNotes: string): void {
  const db = getDb();
  db.prepare(`DELETE FROM vault_docs WHERE doc_type = 'pillar' AND lower(title) = lower(?)`).run(
    name,
  );
  db.prepare(
    `INSERT INTO vault_docs (id, doc_type, title, body, created_at) VALUES (?, 'pillar', ?, ?, ?)`,
  ).run(
    randomUUID(),
    name,
    `${name}: ${description}${voiceNotes ? `\nVoice: ${voiceNotes}` : ""}`,
    nowIso(),
  );
}

// Deterministic pre-pass: an unconfirmed suggestion matching a CONFIRMED
// pillar's name folds into it without asking the model. Returns merged count.
export function mergeNameMatchesIntoConfirmed(): number {
  const db = getDb();
  const confirmed = db.prepare(`SELECT id, name FROM pillars WHERE confirmed = 1`).all() as Array<{
    id: string;
    name: string;
  }>;
  if (confirmed.length === 0) return 0;
  const byName = new Map(confirmed.map((c) => [c.name.trim().toLowerCase(), c.id]));
  const suggestions = db
    .prepare(`SELECT id, name FROM pillars WHERE confirmed = 0 OR confirmed IS NULL`)
    .all() as Array<{ id: string; name: string }>;
  let merged = 0;
  for (const s of suggestions) {
    const target = byName.get(s.name.trim().toLowerCase());
    if (!target || target === s.id) continue;
    repointPillar(s.id, target);
    db.prepare(`DELETE FROM vault_docs WHERE doc_type = 'pillar' AND lower(title) = lower(?)`).run(
      s.name,
    );
    db.prepare(`DELETE FROM pillars WHERE id = ?`).run(s.id);
    merged++;
  }
  return merged;
}

// Normalized identity for pillar names: same words in any order/case.
// "ELI5 Mental Models" ≡ "Mental Models ELI5" but ≠ "Mental Models Made Simple".
export function pillarKey(name: string): string {
  return name
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .sort()
    .join(" ");
}

// Survivor = most linked posts, tie-break earliest linked post. Pure read.
export function chooseSurvivor(ids: string[]): string {
  const db = getDb();
  const counts = db.prepare(
    `SELECT pillar_id, COUNT(*) AS n, MIN(COALESCE(posted_at, created_at)) AS first
     FROM assets WHERE pillar_id IS NOT NULL GROUP BY pillar_id`,
  ).all() as Array<{ pillar_id: string; n: number; first: string | null }>;
  const byId = new Map(counts.map((c) => [c.pillar_id, c]));
  return [...ids].sort((a, b) => {
    const an = byId.get(a)?.n ?? 0;
    const bn = byId.get(b)?.n ?? 0;
    if (bn !== an) return bn - an;
    return (byId.get(a)?.first ?? "").localeCompare(byId.get(b)?.first ?? "");
  })[0];
}

// Deterministic pre-pass: collapse reorder/case duplicates without the model
// ("ELI5 Mental Models" + "Mental Models ELI5"). Groups containing a confirmed
// pillar fold into it; otherwise the richest member survives under its own name.
export function mergeTokenDuplicates(): number {
  const db = getDb();
  const pillars = db.prepare(`SELECT id, name, confirmed FROM pillars`).all() as Array<{
    id: string;
    name: string;
    confirmed: number;
  }>;
  const groups = new Map<string, typeof pillars>();
  for (const p of pillars) {
    const key = pillarKey(p.name);
    if (!key) continue;
    const group = groups.get(key) ?? [];
    group.push(p);
    groups.set(key, group);
  }
  let merged = 0;
  withTransaction(() => {
    for (const group of groups.values()) {
      if (group.length < 2) continue;
      const confirmed = group.find((p) => p.confirmed);
      const survivorId = confirmed ? confirmed.id : chooseSurvivor(group.map((p) => p.id));
      for (const loser of group) {
        if (loser.id === survivorId) continue;
        repointPillar(loser.id, survivorId);
        db.prepare(
          `DELETE FROM vault_docs WHERE doc_type = 'pillar' AND lower(title) = lower(?)`,
        ).run(loser.name);
        db.prepare(`DELETE FROM pillars WHERE id = ?`).run(loser.id);
        merged++;
      }
    }
  });
  return merged;
}

// The model sometimes returns status incomplete (output budget spent on
// reasoning) with zero text — treat as unusable before parsing.
export function outputUsable(resp: { status?: unknown; output_text?: unknown }): boolean {
  if (resp.status === "incomplete") return false;
  return typeof resp.output_text === "string" && resp.output_text.trim().length > 0;
}

// Apply a consolidation plan transactionally. Only unconfirmed pillars move;
// confirmed pillars and unmapped names are never touched.
export function applyConsolidation(entries: ConsolidationEntry[]): ConsolidationResult {
  const db = getDb();
  const existing = db
    .prepare(`SELECT id, name, confirmed FROM pillars`)
    .all() as Array<{ id: string; name: string; confirmed: number }>;
  const byName = new Map(existing.map((p) => [p.name.trim().toLowerCase(), p]));
  const claimed = new Set<string>();
  const unmapped: string[] = [];
  let merged = 0;
  let canonical = 0;
  withTransaction(() => {
    for (const entry of entries) {
      if (!entry.name.trim() || entry.absorbs.length === 0) continue;
      // Resolve absorbs to live unconfirmed pillars; skip claimed/dropped names.
      const members = [];
      for (const name of entry.absorbs) {
        const hit = byName.get(name.trim().toLowerCase());
        if (!hit) {
          unmapped.push(name);
          continue;
        }
        if (hit.confirmed || claimed.has(hit.id)) continue;
        members.push(hit);
      }
      // The canonical name itself counts as an absorb target.
      const selfHit = byName.get(entry.name.trim().toLowerCase());
      if (selfHit && !selfHit.confirmed && !claimed.has(selfHit.id) && !members.includes(selfHit)) {
        members.push(selfHit);
      }
      if (members.length === 0) continue;
      for (const m of members) claimed.add(m.id);
      const survivorId = chooseSurvivor(members.map((m) => m.id));
      const survivor = members.find((m) => m.id === survivorId) ?? members[0];
      db.prepare(`UPDATE pillars SET name = ?, description = ?, voice_notes = ? WHERE id = ?`).run(
        entry.name.trim(),
        entry.description,
        entry.voiceNotes,
        survivor.id,
      );
      for (const loser of members.filter((m) => m.id !== survivor.id)) {
        repointPillar(loser.id, survivor.id);
        db.prepare(
          `DELETE FROM vault_docs WHERE doc_type = 'pillar' AND lower(title) = lower(?)`,
        ).run(loser.name);
        db.prepare(`DELETE FROM pillars WHERE id = ?`).run(loser.id);
        merged++;
      }
      db.prepare(
        `DELETE FROM vault_docs WHERE doc_type = 'pillar' AND lower(title) = lower(?)`,
      ).run(survivor.name);
      writePillarVaultDoc(entry.name.trim(), entry.description, entry.voiceNotes);
      canonical++;
    }
  });
  return { merged, canonical, unmapped, confirmed: [] };
}

// Embed pillar vault docs written without vectors (consolidation apply is
// sync; this runs after, on the live path only).
export async function embedMissingPillarDocs(): Promise<number> {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT id, title, body FROM vault_docs WHERE doc_type = 'pillar' AND embedding IS NULL`,
    )
    .all() as Array<{ id: string; title: string | null; body: string }>;
  if (rows.length === 0) return 0;
  const vectors = await embedMany(rows.map((r) => `${r.title ?? ""}\n${r.body}`));
  const update = db.prepare(`UPDATE vault_docs SET embedding = ? WHERE id = ?`);
  rows.forEach((row, i) => update.run(vectorToBlob(vectors[i]), row.id));
  return rows.length;
}

export function chunkArray<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size));
  return chunks;
}

// Muse-spark reasons hard on grouping tasks: a 600-candidate call burns the
// whole output budget on reasoning and returns nothing. Small calls with low
// reasoning effort are the reliable shape — consolidation therefore runs in
// chunks of at most CONSOLIDATE_CHUNK, then re-passes over the intermediates.
const CONSOLIDATE_CHUNK = 150;

type ConsolidationCandidate = { name: string; posts: number; recent: number; mult: number | null };

async function requestConsolidation(
  client: ReturnType<typeof getMetaClient>,
  candidates: ConsolidationCandidate[],
  label: string,
  onProgress?: (stage: string) => void,
): Promise<ConsolidationEntry[]> {
  const input = `${CONSOLIDATE_SYSTEM}\n\nCANDIDATES:\n${JSON.stringify(candidates)}`;
  let resp = await client.responses.create(
    {
      model: metaTextModel(),
      input,
      max_output_tokens: 24000,
      reasoning: { effort: "low" },
    },
    { timeout: 240000 },
  );
  if (!outputUsable(resp)) {
    if (onProgress) onProgress(`Retrying ${label}…`);
    resp = await client.responses.create(
      {
        model: metaTextModel(),
        input: `${input}\n\nYour previous response was empty. Return ONLY the JSON object, no other text.`,
        max_output_tokens: 24000,
        reasoning: { effort: "low" },
      },
      { timeout: 240000 },
    );
    if (!outputUsable(resp)) {
      throw new Error(
        `consolidation model returned no usable output (status: ${String((resp as { status?: unknown }).status ?? "unknown")})`,
      );
    }
  }
  const parsed = extractJson(resp.output_text, `consolidation ${label}`);
  const rawEntries = Array.isArray(parsed.pillars) ? parsed.pillars : [];
  const entries: ConsolidationEntry[] = [];
  for (const e of rawEntries) {
    if (!e || typeof e !== "object") continue;
    const { name, description, voice_notes, absorbs } = e as Record<string, unknown>;
    if (typeof name !== "string" || !name.trim()) continue;
    entries.push({
      name: name.trim(),
      description: typeof description === "string" ? description : "",
      voiceNotes: typeof voice_notes === "string" ? voice_notes : "",
      absorbs: asStringArray(absorbs),
    });
  }
  return entries;
}

function listSuggestionCandidates(): ConsolidationCandidate[] {
  const db = getDb();
  const suggestions = db
    .prepare(
      `SELECT name FROM pillars WHERE confirmed = 0 OR confirmed IS NULL ORDER BY name ASC`,
    )
    .all() as Array<{ name: string }>;
  const stats = pillarStats();
  const idByName = new Map(
    (
      db.prepare(`SELECT id, name FROM pillars`).all() as Array<{ id: string; name: string }>
    ).map((p) => [p.name.trim().toLowerCase(), p.id]),
  );
  return suggestions.map((s) => {
    const st = stats[idByName.get(s.name.trim().toLowerCase()) ?? ""];
    return {
      name: s.name,
      posts: st?.posts ?? 0,
      recent: st?.recent ?? 0,
      mult: st?.multiplier ?? null,
    };
  });
}

function countSuggestions(): number {
  const db = getDb();
  return (
    db
      .prepare(`SELECT COUNT(*) AS n FROM pillars WHERE confirmed = 0 OR confirmed IS NULL`)
      .get() as { n: number }
  ).n;
}

export async function consolidatePillars(
  onProgress?: (stage: string) => void,
): Promise<ConsolidationResult> {
  const metaKey = loadKeys().meta;
  if (!metaKey) throw new Error("save a Meta key in Settings first");
  const client = getMetaClient(metaKey);
  let merged = mergeTokenDuplicates() + mergeNameMatchesIntoConfirmed();
  const unmapped: string[] = [];
  for (let pass = 0; pass < 5; pass++) {
    const candidates = listSuggestionCandidates();
    if (candidates.length <= 15) {
      if (onProgress) onProgress("Embedding pillar docs…");
      await embedMissingPillarDocs();
      if (onProgress) onProgress("Ranking pillars…");
      const confirmed = autoConfirmTopPillars();
      return {
        merged,
        canonical: candidates.length,
        unmapped: unmapped.slice(0, 50),
        confirmed,
      };
    }
    const chunks = chunkArray(candidates, CONSOLIDATE_CHUNK);
    for (let i = 0; i < chunks.length; i++) {
      const label =
        chunks.length === 1
          ? `consolidation of ${chunks[i].length} pillars`
          : `consolidation chunk ${i + 1}/${chunks.length} (${chunks[i].length} pillars)`;
      if (onProgress) {
        onProgress(
          chunks.length === 1
            ? `Consolidating ${chunks[i].length} pillars…`
            : `Consolidating chunk ${i + 1}/${chunks.length}…`,
        );
      }
      const entries = await requestConsolidation(client, chunks[i], label, onProgress);
      const applied = applyConsolidation(entries);
      merged += applied.merged;
      unmapped.push(...applied.unmapped);
    }
    merged += mergeTokenDuplicates();
  }
  if (onProgress) onProgress("Embedding pillar docs…");
  await embedMissingPillarDocs();
  if (onProgress) onProgress("Ranking pillars…");
  const confirmed = autoConfirmTopPillars();
  return { merged, canonical: countSuggestions(), unmapped: unmapped.slice(0, 50), confirmed };
}

const SYSTEM = `You analyze a content creator's posts and videos. Study the CONTENT below and respond with ONLY a JSON object (no prose, no code fences) shaped exactly like:
{"voice": {"summary": "2-3 sentences: who they sound like on the page",
"diction": "vocabulary notes: word choices, slang, jargon level, signature words and phrases they repeat",
"syntax": "sentence patterns: typical lengths, fragments, lists, rhythm, punctuation habits",
"tone": "tone and register, including how it shifts between casual posts and professional ones",
"structure": "structural habits: how they open (hooks), how they close, how they use calls to action",
"formatting": "formatting rules: emoji use, hashtags, capitalization, line breaks, thread style",
"topics": "what they talk about and the stances they take",
"donts": ["something they never do in their writing"],
"examples": ["a short real or paraphrased line that nails their voice"]},
"pillars": [{"name": "short pillar name", "description": "one sentence on what this pillar covers", "voice_notes": "how their voice shifts for this pillar: angles, references, energy"}],
"qa": [{"q": "a question their audience would ask", "a": "the creator's likely answer in their voice"}],
"principles": ["a belief or rule that guides their content"],
"quotes": ["a quotable line in their voice, invented or paraphrased from the content"],
"assignments": {"1": "exact pillar name from your pillars list for post 1"}}
Aim for 3-6 pillars, 4-8 Q&A pairs, 3-6 principles, 3-6 quotes, 2-4 donts, 2-4 examples. Assign EVERY numbered entry to exactly one pillar in assignments, using the exact pillar name. Every voice field must be specific enough for a ghostwriter to imitate: name real habits, not generic praise. Entries marked [DIGEST of ~Nk chars] are faithful condensations of longer pieces — treat their ideas and quotes as real content.`;

// Extract the first complete top-level JSON object, tolerating fenced
// blocks, leading prose, and trailing commentary. The old greedy-regex
// fallback swallowed trailing garbage (including stray braces) into the
// parse and killed whole runs on valid output.
export function extractJson(text: string, label = "model"): Record<string, unknown> {
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    /* fall through to the scan */
  }
  const candidates: string[] = [];
  let i = 0;
  while (i < text.length) {
    const start = text.indexOf("{", i);
    if (start === -1) break;
    let depth = 0;
    let inStr = false;
    let esc = false;
    let end = -1;
    for (let j = start; j < text.length; j++) {
      const ch = text[j];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === "\\") esc = true;
        else if (ch === '"') inStr = false;
      } else if (ch === '"') {
        inStr = true;
      } else if (ch === "{") {
        depth++;
      } else if (ch === "}") {
        depth--;
        if (depth === 0) {
          end = j;
          break;
        }
      }
    }
    if (end === -1) break;
    candidates.push(text.slice(start, end + 1));
    i = end + 1;
  }
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate) as Record<string, unknown>;
    } catch {
      /* try the next balanced block */
    }
  }
  console.log(`extractJson[${label}] failed on model output head: ${text.slice(0, 500)}`);
  const tail = text.trim().slice(-80);
  const truncNote =
    text.includes("{") && /[{[":,\w]\s*$/.test(tail)
      ? ` (truncated? tail: ${JSON.stringify(tail)})`
      : "";
  throw new Error(
    candidates.length > 0
      ? `${label}: model returned malformed JSON${truncNote}`
      : `${label}: model returned no parseable JSON object (${text.trim().length} chars of text)${truncNote}`,
  );
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string" && v.trim().length > 0);
}

function asNonEmpty(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export type VoiceProfile = {
  summary: string;
  diction: string;
  syntax: string;
  tone: string;
  structure: string;
  formatting: string;
  topics: string;
  donts: string[];
  examples: string[];
};

const EMPTY_VOICE: VoiceProfile = {
  summary: "",
  diction: "",
  syntax: "",
  tone: "",
  structure: "",
  formatting: "",
  topics: "",
  donts: [],
  examples: [],
};

// Tolerates the legacy shape (voice as a bare string) as summary-only.
export function extractVoiceProfile(parsed: Record<string, unknown>): VoiceProfile {
  const v = parsed["voice"];
  if (typeof v === "string") return { ...EMPTY_VOICE, summary: v.trim() };
  const o = v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  return {
    summary: asNonEmpty(o["summary"]),
    diction: asNonEmpty(o["diction"]),
    syntax: asNonEmpty(o["syntax"]),
    tone: asNonEmpty(o["tone"]),
    structure: asNonEmpty(o["structure"]),
    formatting: asNonEmpty(o["formatting"]),
    topics: asNonEmpty(o["topics"]),
    donts: asStringArray(o["donts"]),
    examples: asStringArray(o["examples"]),
  };
}

export function buildVoiceMarkdown(
  voice: VoiceProfile,
  pillars: { name: string; voiceNotes: string }[],
): string {
  const lines = ["# Voice profile", ""];
  const sections: [string, string][] = [
    ["Summary", voice.summary],
    ["Diction & vocabulary", voice.diction],
    ["Syntax & rhythm", voice.syntax],
    ["Tone & register", voice.tone],
    ["Structure (hooks, openers, closers, CTAs)", voice.structure],
    ["Formatting (emoji, hashtags, caps, line breaks)", voice.formatting],
    ["Topics & stances", voice.topics],
  ];
  for (const [head, body] of sections) {
    if (!body) continue;
    lines.push(`## ${head}`, "", body, "");
  }
  if (voice.donts.length > 0) {
    lines.push("## Never do", "", ...voice.donts.map((d) => `- ${d}`), "");
  }
  const notes = pillars.filter((p) => p.voiceNotes);
  if (notes.length > 0) {
    lines.push("## Per-pillar voice", "");
    for (const p of notes) lines.push(`### ${p.name}`, "", p.voiceNotes, "");
  }
  if (voice.examples.length > 0) {
    lines.push("## Example lines", "", ...voice.examples.map((e) => `- "${e}"`), "");
  }
  return `${lines.join("\n").trim()}\n`;
}

export type PillarUpsert = { name: string; description: string; voiceNotes: string };

// Resolve the model's {"1": "Pillar Name"} assignments to pillar ids.
// Unknown names and out-of-range indexes are dropped, never fatal.
export function mapAssignments(
  raw: unknown,
  count: number,
  nameToId: Map<string, string>,
): Map<number, string> {
  const out = new Map<number, string>();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [key, value] of Object.entries(raw)) {
    const index = Number(key);
    if (!Number.isInteger(index) || index < 1 || index > count) continue;
    if (typeof value !== "string") continue;
    const id = nameToId.get(value.trim().toLowerCase());
    if (id) out.set(index, id);
  }
  return out;
}

// Merge rule: new pillars insert as suggestions; unconfirmed ones refresh;
// confirmed pillars keep the user's description and only gain voice notes
// when they have none.
export function upsertPillar(
  db: DatabaseSync,
  p: PillarUpsert,
): { id: string; confirmed: number; description: string; voiceNotes: string } {
  const existing = db
    .prepare(
      `SELECT id, description, voice_notes, confirmed FROM pillars
       WHERE lower(name) = lower(?) LIMIT 1`,
    )
    .get(p.name.trim()) as
    | { id: string; description: string; voice_notes: string; confirmed: number }
    | undefined;
  if (!existing) {
    const id = randomUUID();
    db.prepare(
      `INSERT INTO pillars (id, name, description, voice_notes, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(id, p.name.trim(), p.description, p.voiceNotes, nowIso());
    return { id, confirmed: 0, description: p.description, voiceNotes: p.voiceNotes };
  }
  if (existing.confirmed) {
    if (!existing.voice_notes && p.voiceNotes) {
      db.prepare(`UPDATE pillars SET voice_notes = ? WHERE id = ?`).run(p.voiceNotes, existing.id);
      return {
        id: existing.id,
        confirmed: existing.confirmed,
        description: existing.description,
        voiceNotes: p.voiceNotes,
      };
    }
    return {
      id: existing.id,
      confirmed: existing.confirmed,
      description: existing.description,
      voiceNotes: existing.voice_notes,
    };
  }
  db.prepare(`UPDATE pillars SET description = ?, voice_notes = ? WHERE id = ?`).run(
    p.description,
    p.voiceNotes,
    existing.id,
  );
  return { id: existing.id, confirmed: 0, description: p.description, voiceNotes: p.voiceNotes };
}

export type AnalysisProgress = (done: number, total: number, stage: string) => void;

export function countUnanalyzed(): number {
  const row = getDb().prepare(`SELECT COUNT(*) AS n FROM assets WHERE analyzed_at IS NULL`).get() as {
    n: number;
  };
  return Number(row.n);
}

export async function runAnalysis(
  limit = MAX_ASSETS,
  onProgress?: AnalysisProgress,
): Promise<AnalysisResult> {
  const metaKey = loadKeys().meta;
  if (!metaKey) throw new Error("save a Meta key in Settings first");
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT id, source, title, transcript FROM assets
       WHERE analyzed_at IS NULL ORDER BY created_at DESC LIMIT ?`,
    )
    .all(Math.max(1, Math.min(limit, MAX_ASSETS))) as AssetRow[];
  if (rows.length === 0) return { assetsAnalyzed: 0, pillars: 0, vaultDocs: 0 };

  const { direct, digest } = planCorpus(rows);
  const picked = [...direct, ...digest];
  if (picked.length === 0) return { assetsAnalyzed: 0, pillars: 0, vaultDocs: 0 };
  const client = getMetaClient(metaKey);
  // Long transcripts get a dedicated digest pass so nothing is silently cut;
  // a failed digest falls back to head truncation rather than failing the batch.
  const digests = new Map<string, string>();
  if (digest.length > 0) {
    if (onProgress) {
      onProgress(
        0,
        picked.length,
        `Distilling ${digest.length} long transcript${digest.length === 1 ? "" : "s"}…`,
      );
    }
    for (const row of digest) {
      const text = row.transcript ?? "";
      const cached = readDigestCache(db, row.id, text.length);
      if (cached) {
        digests.set(row.id, cached);
        continue;
      }
      try {
        const d = await digestLongTranscript(client, row.title ?? "", text);
        const usable = d.trim() ? d : text.slice(0, MAX_ASSET_CHARS);
        writeDigestCache(db, row.id, text.length, usable);
        digests.set(row.id, usable);
      } catch (error) {
        console.log(
          `digest failed for ${row.id}: ${(error as Error).message} — using head truncation`,
        );
      }
    }
  }
  let active: AssetRow[] = picked;
  let corpus = buildCorpus(active, digests);
  if (onProgress) onProgress(0, picked.length, `Analyzing ${picked.length} posts…`);
  let resp = await client.responses.create(
    {
      model: metaTextModel(),
      input: `${SYSTEM}\n\nCONTENT:\n${corpus}`,
      max_output_tokens: 24000,
    },
    { timeout: 240000 },
  );
  // Escalation: an empty/incomplete answer usually means the output budget
  // went to reasoning — retry once on half the batch. The dropped half stays
  // unanalyzed and flows into the next batch, so nothing is lost.
  if (!outputUsable(resp) && active.length > 1) {
    if (onProgress) onProgress(0, picked.length, "Retrying with a smaller batch…");
    active = active.slice(0, Math.max(1, Math.ceil(active.length / 2)));
    corpus = buildCorpus(active, digests);
    resp = await client.responses.create(
      {
        model: metaTextModel(),
        input: `${SYSTEM}\n\nCONTENT:\n${corpus}\n\nYour previous response was empty. Return ONLY the JSON object, no other text.`,
        max_output_tokens: 24000,
      },
      { timeout: 240000 },
    );
  }
  if (!outputUsable(resp)) {
    throw new Error(
      `analysis model returned no usable output (status: ${String((resp as { status?: unknown }).status ?? "unknown")})`,
    );
  }
  if (onProgress) onProgress(0, active.length, "Writing pillars + vault…");
  const parsed = extractJson(resp.output_text, "analysis");

  const rawPillars = Array.isArray(parsed.pillars) ? parsed.pillars : [];
  const qa = Array.isArray(parsed.qa) ? parsed.qa : [];
  const principles = asStringArray(parsed.principles);
  const quotes = asStringArray(parsed.quotes);
  const voice = extractVoiceProfile(parsed);

  let pillarCount = 0;
  const pillarNotes: { name: string; voiceNotes: string }[] = [];
  const pillarBodies: { title: string; body: string }[] = [];
  const nameToId = new Map<string, string>();
  for (const p of rawPillars) {
    if (!p || typeof p !== "object") continue;
    const { name, description, voice_notes } = p as {
      name?: unknown;
      description?: unknown;
      voice_notes?: unknown;
    };
    if (typeof name !== "string" || !name.trim()) continue;
    const final = upsertPillar(db, {
      name: name.trim(),
      description: typeof description === "string" ? description : "",
      voiceNotes: typeof voice_notes === "string" ? voice_notes : "",
    });
    nameToId.set(name.trim().toLowerCase(), final.id);
    pillarCount++;
    pillarNotes.push({ name: name.trim(), voiceNotes: final.voiceNotes });
    pillarBodies.push({
      title: name.trim(),
      body: `${name.trim()}: ${final.description}${final.voiceNotes ? `\nVoice: ${final.voiceNotes}` : ""}`,
    });
  }
  // Pillar vault docs mirror the pillars table (upsert by title).
  const deletePillarDoc = db.prepare(
    `DELETE FROM vault_docs WHERE doc_type = 'pillar' AND lower(title) = lower(?)`,
  );

  // Build vault docs, then embed + insert in one batch. Batches pick newest
  // first, so the first batch's voice (newest posts) wins and later batches
  // leave it alone.
  const docs: Array<{ type: string; title: string | null; body: string }> = [];
  const hasVoice = db
    .prepare(`SELECT id FROM vault_docs WHERE doc_type = 'voice' LIMIT 1`)
    .get();
  if (!hasVoice && voice.summary) {
    docs.push({
      type: "voice",
      title: "Voice profile",
      body: buildVoiceMarkdown(voice, pillarNotes),
    });
  }
  for (const p of pillarBodies) {
    deletePillarDoc.run(p.title);
    docs.push({ type: "pillar", title: p.title, body: p.body });
  }
  for (const item of qa) {
    if (!item || typeof item !== "object") continue;
    const { q, a } = item as { q?: unknown; a?: unknown };
    if (typeof q !== "string" || typeof a !== "string") continue;
    if (!q.trim() || !a.trim()) continue;
    docs.push({ type: "qa", title: q.trim(), body: `Q: ${q.trim()}\nA: ${a.trim()}` });
  }
  for (const principle of principles) {
    docs.push({ type: "principle", title: null, body: principle });
  }
  for (const quote of quotes) {
    docs.push({ type: "quote", title: null, body: quote });
  }

  const vectors = await embedMany(docs.map((d) => `${d.title ?? ""}\n${d.body}`));
  const insertDoc = db.prepare(
    `INSERT INTO vault_docs (id, doc_type, title, body, embedding, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const dupeCheck = db.prepare(
    `SELECT id FROM vault_docs WHERE doc_type = ? AND body = ? LIMIT 1`,
  );
  let vaultDocs = 0;
  for (let i = 0; i < docs.length; i++) {
    if (dupeCheck.get(docs[i].type, docs[i].body)) continue;
    insertDoc.run(
      randomUUID(),
      docs[i].type,
      docs[i].title,
      docs[i].body,
      vectorToBlob(vectors[i]),
      nowIso(),
    );
    vaultDocs++;
  }

  const mark = db.prepare(`UPDATE assets SET analyzed_at = ? WHERE id = ?`);
  const ts = nowIso();
  for (const row of active) mark.run(ts, row.id);

  // Link every post to its pillar, then score every post against its
  // platform's average.
  const links = mapAssignments(parsed.assignments, active.length, nameToId);
  if (links.size > 0) {
    const link = db.prepare(`UPDATE assets SET pillar_id = ? WHERE id = ?`);
    for (const [index, pillarId] of links) {
      const row = active[index - 1];
      if (row) link.run(pillarId, row.id);
    }
  }
  if (onProgress) onProgress(active.length, active.length, "Scoring posts…");
  refreshMultipliers();

  if (onProgress) onProgress(active.length, active.length, "Done");
  return { assetsAnalyzed: active.length, pillars: pillarCount, vaultDocs };
}

// Full brain rebuild: wipe derived docs and re-analyze every asset.
// Pillars are never deleted (queue templates link them by id) — re-analysis
// refreshes unconfirmed ones by name and confirmed ones keep user edits.
export function resetBrain(): void {
  const db = getDb();
  db.prepare(`DELETE FROM vault_docs`).run();
  db.prepare(`UPDATE assets SET analyzed_at = NULL`).run();
}

export async function runBrainRegenerate(
  onProgress?: AnalysisProgress,
): Promise<{
  analyzed: number;
  batches: number;
  merged: number;
  canonical: number;
  confirmed: string[];
  degraded?: string;
}> {
  resetBrain();
  const total = countUnanalyzed();
  let analyzed = 0;
  let batches = 0;
  if (onProgress) onProgress(0, total, "Starting…");
  for (let i = 0; i < 100; i++) {
    const res = await runAnalysis(MAX_ASSETS, (done, batchTotal, stage) => {
      if (!onProgress) return;
      const seen = Math.max(total, analyzed + batchTotal);
      onProgress(Math.min(analyzed + done, seen), seen, stage);
    });
    analyzed += res.assetsAnalyzed;
    batches++;
    if (onProgress) {
      onProgress(
        analyzed,
        Math.max(total, analyzed),
        res.assetsAnalyzed === 0 ? "Done" : `Batch ${batches} · ${analyzed} analyzed`,
      );
    }
    if (res.assetsAnalyzed === 0) break;
  }
  if (onProgress) onProgress(analyzed, Math.max(total, analyzed), "Consolidating pillars…");
  try {
    const consolidated = await consolidatePillars((stage) => {
      if (onProgress) onProgress(analyzed, Math.max(total, analyzed), stage);
    });
    if (onProgress) onProgress(analyzed, Math.max(total, analyzed), "Done");
    return {
      analyzed,
      batches,
      merged: consolidated.merged,
      canonical: consolidated.canonical,
      confirmed: consolidated.confirmed,
    };
  } catch (error) {
    // The analysis batches already committed — don't roll the whole job into a
    // failure over consolidation. The deterministic merges inside
    // consolidatePillars ran first; report degraded and let the user retry
    // consolidation standalone.
    const db = getDb();
    const remaining = (
      db.prepare(`SELECT COUNT(*) AS n FROM pillars WHERE confirmed = 0 OR confirmed IS NULL`).get() as {
        n: number;
      }
    ).n;
    const message = (error as Error).message;
    if (onProgress) {
      onProgress(analyzed, Math.max(total, analyzed), `Done (consolidation skipped: ${message})`);
    }
    return { analyzed, batches, merged: 0, canonical: remaining, confirmed: [], degraded: message };
  }
}
