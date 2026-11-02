// Content analysis: unanalyzed assets -> voice profile + vault + pillars.
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { getDb, nowIso } from "./db";
import { embedMany, vectorToBlob } from "./embeddings";
import { loadKeys } from "./keys";
import { getMetaClient, metaTextModel } from "./meta";

const MAX_ASSETS = 40;
const MAX_ASSET_CHARS = 4000;
const MAX_TOTAL_CHARS = 50000;

type AssetRow = {
  id: string;
  source: string;
  title: string | null;
  transcript: string | null;
};

export type AnalysisResult = {
  assetsAnalyzed: number;
  pillars: number;
  vaultDocs: number;
};

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
"quotes": ["a quotable line in their voice, invented or paraphrased from the content"]}
Aim for 3-6 pillars, 4-8 Q&A pairs, 3-6 principles, 3-6 quotes, 2-4 donts, 2-4 examples. Every voice field must be specific enough for a ghostwriter to imitate: name real habits, not generic praise.`;

function extractJson(text: string): Record<string, unknown> {
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    const match =
      text.match(/```json\s*([\s\S]*?)```/) ?? text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("model did not return JSON");
    return JSON.parse(match[1] ?? match[0]) as Record<string, unknown>;
  }
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

  let total = 0;
  const picked: AssetRow[] = [];
  for (const row of rows) {
    const len = Math.min((row.transcript ?? "").length, MAX_ASSET_CHARS);
    if (total + len > MAX_TOTAL_CHARS) break;
    total += len;
    picked.push(row);
  }
  const corpus = picked
    .map(
      (row, i) =>
        `[${i + 1}] (${row.source}) ${row.title ?? ""}\n${(row.transcript ?? "").slice(0, MAX_ASSET_CHARS)}`,
    )
    .join("\n\n---\n\n");

  if (onProgress) onProgress(0, picked.length, `Analyzing ${picked.length} posts…`);
  const client = getMetaClient(metaKey);
  const resp = await client.responses.create(
    {
      model: metaTextModel(),
      input: `${SYSTEM}\n\nCONTENT:\n${corpus}`,
      max_output_tokens: 8000,
    },
    { timeout: 180000 },
  );
  if (onProgress) onProgress(0, picked.length, "Writing pillars + vault…");
  const parsed = extractJson(resp.output_text);

  const rawPillars = Array.isArray(parsed.pillars) ? parsed.pillars : [];
  const qa = Array.isArray(parsed.qa) ? parsed.qa : [];
  const principles = asStringArray(parsed.principles);
  const quotes = asStringArray(parsed.quotes);
  const voice = extractVoiceProfile(parsed);

  let pillarCount = 0;
  const pillarNotes: { name: string; voiceNotes: string }[] = [];
  const pillarBodies: { title: string; body: string }[] = [];
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
  for (const row of picked) mark.run(ts, row.id);

  if (onProgress) onProgress(picked.length, picked.length, "Done");
  return { assetsAnalyzed: picked.length, pillars: pillarCount, vaultDocs };
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
): Promise<{ analyzed: number; batches: number }> {
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
  return { analyzed, batches };
}
