// Video speech-transcript backfill: per-video Monid transcription for
// assets whose listings only carry captions. Naturally resumable — an asset
// leaves the queue the moment transcribed_at is set.
import { getDb, nowIso } from "./db";
import { monidRunAndWait } from "./monid";
import { loadKeys } from "./keys";
import { monidPayloadError } from "./ingest";

type Endpoint = { endpoint: string; route: string; lo: number; hi: number };

const ENDPOINTS: { match: RegExp; def: Endpoint }[] = [
  { match: /tiktok/i, def: { endpoint: "/tiktok.video_transcript_full", route: "octopus", lo: 0.002, hi: 0.02 } },
  { match: /youtube/i, def: { endpoint: "/youtube.video_transcript_full", route: "badger", lo: 0.003, hi: 0.01 } },
  { match: /instagram/i, def: { endpoint: "/instagram.reel_transcript", route: "anyapi", lo: 0.002, hi: 0.02 } },
];

export function endpointFor(source: string): Endpoint | null {
  const hit = ENDPOINTS.find((e) => e.match.test(source));
  return hit ? hit.def : null;
}

export function parseTranscript(payload: unknown): { text: string } | { notFound: true } | null {
  if (typeof payload !== "object" || payload === null) return null;
  const p = payload as Record<string, unknown>;
  if (p["found"] === false) return { notFound: true };
  const data =
    p["data"] && typeof p["data"] === "object" ? (p["data"] as Record<string, unknown>) : p;
  for (const key of ["transcript", "text", "fullText", "caption"]) {
    if (typeof data[key] === "string" && (data[key] as string).trim()) {
      return { text: (data[key] as string).trim() };
    }
  }
  for (const key of ["segments", "sentences", "chunks"]) {
    const arr = data[key];
    if (Array.isArray(arr)) {
      const text = arr
        .map((s) =>
          typeof s === "string" ? s : s && typeof s === "object" ? String((s as Record<string, unknown>)["text"] ?? "") : "",
        )
        .filter(Boolean)
        .join(" ")
        .trim();
      if (text) return { text };
    }
  }
  return null;
}

export type TranscriptEligible = { id: string; source: string; source_url: string };

export function eligibleAssets(limit: number): TranscriptEligible[] {
  return getDb()
    .prepare(
      `SELECT id, source, source_url FROM assets
       WHERE is_video = 1 AND transcribed_at IS NULL AND source_url IS NOT NULL
       ORDER BY COALESCE(posted_at, created_at) DESC LIMIT ?`,
    )
    .all(Math.max(1, Math.min(limit, 2000))) as TranscriptEligible[];
}

export function eligibleCount(): { total: number; bySource: { source: string; n: number }[] } {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT source, COUNT(*) AS n FROM assets
       WHERE is_video = 1 AND transcribed_at IS NULL AND source_url IS NOT NULL
       GROUP BY source ORDER BY n DESC`,
    )
    .all() as { source: string; n: number }[];
  const bySource = rows.map((r) => ({ source: String(r.source), n: Number(r.n) }));
  return { total: bySource.reduce((n, r) => n + r.n, 0), bySource };
}

export function costEstimate(): { total: number; lo: number; hi: number } {
  const { total, bySource } = eligibleCount();
  let lo = 0;
  let hi = 0;
  for (const row of bySource) {
    const def = endpointFor(row.source);
    if (!def) continue;
    lo += row.n * def.lo;
    hi += row.n * def.hi;
  }
  return { total, lo, hi };
}

export type TranscriptBackfillResult = {
  done: number;
  failed: number;
  skipped: number;
  spent: number;
  failures: { asset: string; error: string }[];
};

export async function runTranscriptBackfill(
  limit = 500,
  onProgress?: (done: number, total: number, spent: number) => void,
): Promise<TranscriptBackfillResult> {
  const apiKey = loadKeys().monid;
  if (!apiKey) throw new Error("save a Monid key in Settings first");
  const db = getDb();
  const { total } = eligibleCount();
  const out: TranscriptBackfillResult = { done: 0, failed: 0, skipped: 0, spent: 0, failures: [] };
  let processed = 0;
  for (;;) {
    const batch = eligibleAssets(Math.min(50, limit - processed));
    if (batch.length === 0 || processed >= limit) break;
    for (const asset of batch) {
      processed++;
      try {
        const def = endpointFor(asset.source);
        if (!def) {
          out.skipped++;
          db.prepare(`UPDATE assets SET transcribed_at = ? WHERE id = ?`).run(nowIso(), asset.id);
          continue;
        }
        const result = await monidRunAndWait(
          apiKey,
          "anyapi",
          def.endpoint,
          { body: { url: asset.source_url, route: def.route } },
          { timeoutMs: 300000 },
        );
        if (result.status !== "COMPLETED") throw new Error(`monid run ${result.runId}: ${result.status}`);
        const payload = result.output ?? result.providerResponse;
        const payloadError = monidPayloadError(payload);
        if (payloadError) throw new Error(payloadError);
        const cost = result.cost as { value?: unknown } | undefined;
        if (typeof cost?.value === "number") out.spent += cost.value;
        const parsed = parseTranscript(payload);
        if (!parsed) throw new Error("no transcript in Monid response");
        if ("notFound" in parsed) {
          out.skipped++;
          db.prepare(`UPDATE assets SET transcribed_at = ? WHERE id = ?`).run(nowIso(), asset.id);
          continue;
        }
        const row = db.prepare(`SELECT transcript FROM assets WHERE id = ?`).get(asset.id) as {
          transcript: string;
        };
        const existing = (row.transcript ?? "").trim();
        const combined = existing ? `${existing}\n\n[Speech transcript]\n${parsed.text}` : parsed.text;
        db.prepare(`UPDATE assets SET transcript = ?, transcribed_at = ? WHERE id = ?`).run(
          combined.slice(0, 60000),
          nowIso(),
          asset.id,
        );
        out.done++;
      } catch (error) {
        out.failed++;
        out.failures.push({
          asset: asset.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      if (onProgress) onProgress(processed, total, out.spent);
    }
  }
  return out;
}
