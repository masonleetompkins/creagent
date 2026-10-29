// Content analysis: unanalyzed assets -> voice profile + vault + pillars.
import { randomUUID } from "node:crypto";
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
{"voice": "2-4 sentences describing how they write and speak: tone, rhythm, vocabulary, quirks",
"pillars": [{"name": "short pillar name", "description": "one sentence on what this pillar covers"}],
"qa": [{"q": "a question their audience would ask", "a": "the creator's likely answer in their voice"}],
"principles": ["a belief or rule that guides their content"],
"quotes": ["a quotable line in their voice, invented or paraphrased from the content"]}
Aim for 3-6 pillars, 4-8 Q&A pairs, 3-6 principles, 3-6 quotes.`;

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
      max_output_tokens: 4000,
    },
    { timeout: 120000 },
  );
  if (onProgress) onProgress(0, picked.length, "Writing pillars + vault…");
  const parsed = extractJson(resp.output_text);

  const pillars = Array.isArray(parsed.pillars) ? parsed.pillars : [];
  const qa = Array.isArray(parsed.qa) ? parsed.qa : [];
  const principles = asStringArray(parsed.principles);
  const quotes = asStringArray(parsed.quotes);
  const voice = typeof parsed.voice === "string" ? parsed.voice : "";

  // Upsert pillars by case-insensitive name.
  const findPillar = db.prepare(
    `SELECT id FROM pillars WHERE lower(name) = lower(?) LIMIT 1`,
  );
  const updatePillar = db.prepare(`UPDATE pillars SET description = ? WHERE id = ?`);
  const insertPillar = db.prepare(
    `INSERT INTO pillars (id, name, description, created_at) VALUES (?, ?, ?, ?)`,
  );
  let pillarCount = 0;
  for (const p of pillars) {
    if (!p || typeof p !== "object") continue;
    const { name, description } = p as { name?: unknown; description?: unknown };
    if (typeof name !== "string" || !name.trim()) continue;
    const desc = typeof description === "string" ? description : "";
    const existing = findPillar.get(name.trim()) as { id: string } | undefined;
    if (existing) {
      updatePillar.run(desc, existing.id);
    } else {
      insertPillar.run(randomUUID(), name.trim(), desc, nowIso());
    }
    pillarCount++;
  }

  // Build vault docs, then embed + insert in one batch.
  const docs: Array<{ type: string; title: string | null; body: string }> = [];
  if (voice.trim()) docs.push({ type: "voice", title: "Voice profile", body: voice });
  for (const p of pillars) {
    if (!p || typeof p !== "object") continue;
    const { name, description } = p as { name?: unknown; description?: unknown };
    if (typeof name !== "string" || !name.trim()) continue;
    docs.push({
      type: "pillar",
      title: name.trim(),
      body: `${name.trim()}: ${typeof description === "string" ? description : ""}`,
    });
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
  for (let i = 0; i < docs.length; i++) {
    insertDoc.run(
      randomUUID(),
      docs[i].type,
      docs[i].title,
      docs[i].body,
      vectorToBlob(vectors[i]),
      nowIso(),
    );
  }

  const mark = db.prepare(`UPDATE assets SET analyzed_at = ? WHERE id = ?`);
  const ts = nowIso();
  for (const row of picked) mark.run(ts, row.id);

  if (onProgress) onProgress(picked.length, picked.length, "Done");
  return { assetsAnalyzed: picked.length, pillars: pillarCount, vaultDocs: docs.length };
}
