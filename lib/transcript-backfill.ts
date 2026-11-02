// Video speech-transcript backfill: per-video Monid transcription for
// assets whose listings only carry captions. Naturally resumable — an asset
// leaves the queue the moment transcribed_at is set.
import type { DatabaseSync } from "node:sqlite";
import { getDb, nowIso } from "./db";
import { monidRunAndWait } from "./monid";
import { loadKeys } from "./keys";
import { canonicalYoutubeUrl, monidPayloadError } from "./ingest";

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

function extractText(obj: Record<string, unknown>): string | null {
  for (const key of ["transcript", "text", "fullText", "caption"]) {
    if (typeof obj[key] === "string" && (obj[key] as string).trim()) {
      return (obj[key] as string).trim();
    }
  }
  for (const key of ["segments", "sentences", "chunks"]) {
    const arr = obj[key];
    if (Array.isArray(arr)) {
      const text = arr
        .map((s) =>
          typeof s === "string" ? s : s && typeof s === "object" ? String((s as Record<string, unknown>)["text"] ?? "") : "",
        )
        .filter(Boolean)
        .join(" ")
        .trim();
      if (text) return text;
    }
  }
  return null;
}

export function parseTranscript(payload: unknown): { text: string } | { notFound: true } | null {
  if (typeof payload !== "object" || payload === null) return null;
  const p = payload as Record<string, unknown>;
  if (p["found"] === false) return { notFound: true };
  const data =
    p["data"] && typeof p["data"] === "object" ? (p["data"] as Record<string, unknown>) : p;
  const direct = extractText(data);
  if (direct) return { text: direct };
  // Instagram shape: { found, data: { items: [{ text, segments, … }] } }.
  const items = data["items"];
  if (Array.isArray(items)) {
    for (const item of items) {
      if (item && typeof item === "object") {
        const text = extractText(item as Record<string, unknown>);
        if (text) return { text };
      }
    }
  }
  return null;
}

// Photo posts are not transcribable — skip them before Monid bills the call.
// TikTok photo-mode URLs are unambiguous; Instagram photo evidence comes from
// the listing's stored raw markers (only when NO video marker is present, so
// carousels holding video still go through).
export function isPhotoUrl(source: string, url: string): boolean {
  return /tiktok/i.test(source) && /tiktok\.com\/@[^/]+\/photo\//i.test(url);
}

const PHOTO_TYPES = new Set([
  "feed",
  "carousel_container",
  "carousel",
  "album",
  "photo",
  "image",
  "picture",
]);

export function isPhotoRaw(raw: unknown): boolean {
  if (typeof raw !== "object" || raw === null) return false;
  const r = raw as Record<string, unknown>;
  const declared = [
    String(r["productType"] ?? r["product_type"] ?? "").toLowerCase(),
    String(r["mediaType"] ?? r["media_type"] ?? "").toLowerCase(),
  ];
  if (!declared.some((t) => t && PHOTO_TYPES.has(t))) return false;
  if (typeof r["videoUrl"] === "string" || typeof r["video_url"] === "string") return false;
  if (typeof r["durationSeconds"] === "number" || typeof r["duration"] === "number") return false;
  return true;
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
  skipReasons: Record<string, number>;
};

function readMeta(db: DatabaseSync, id: string): Record<string, unknown> {
  try {
    const row = db.prepare(`SELECT metadata FROM assets WHERE id = ?`).get(id) as {
      metadata: string;
    };
    const parsed: unknown = JSON.parse(row.metadata || "{}");
    if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
  } catch {
    /* treat as empty */
  }
  return {};
}

function markSkipped(db: DatabaseSync, id: string, reason: string): void {
  const meta = readMeta(db, id);
  meta["transcript_skipped"] = reason;
  db.prepare(`UPDATE assets SET transcribed_at = ?, metadata = ? WHERE id = ?`).run(
    nowIso(),
    JSON.stringify(meta),
    id,
  );
}

// Clean-empty Monid responses (COMPLETED, billable, no text) mean the video
// has no speech. One could be transient; two is a pattern — stop billing it.
export function noteEmptyResult(db: DatabaseSync, id: string): number {
  const meta = readMeta(db, id);
  const hits = (typeof meta["transcript_empty_hits"] === "number" ? meta["transcript_empty_hits"] : 0) + 1;
  meta["transcript_empty_hits"] = hits;
  db.prepare(`UPDATE assets SET metadata = ? WHERE id = ?`).run(JSON.stringify(meta), id);
  return hits;
}

export const DEFAULT_TRANSCRIBE_CONCURRENCY = 6;
export const MAX_TRANSCRIBE_CONCURRENCY = 12;

// Bounded worker pool. Index claiming is atomic (single-threaded event loop),
// so every item runs exactly once across lanes. Per-item errors belong to fn;
// a throw here rejects the pool.
export async function runPool<T>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<void>,
): Promise<void> {
  const lanes = Math.max(
    1,
    Math.min(Math.floor(concurrency) || 1, Math.max(items.length, 1)),
  );
  let next = 0;
  async function lane(): Promise<void> {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: lanes }, () => lane()));
}

export async function runTranscriptBackfill(
  limit = 500,
  onProgress?: (done: number, total: number, spent: number) => void,
  opts?: { concurrency?: number },
): Promise<TranscriptBackfillResult> {
  const apiKey = loadKeys().monid;
  if (!apiKey) throw new Error("save a Monid key in Settings first");
  const db = getDb();
  const { total } = eligibleCount();
  const out: TranscriptBackfillResult = {
    done: 0,
    failed: 0,
    skipped: 0,
    spent: 0,
    failures: [],
    skipReasons: {},
  };
  const bumpSkipped = (reason: string): void => {
    out.skipped++;
    out.skipReasons[reason] = (out.skipReasons[reason] ?? 0) + 1;
  };
  const concurrency = Math.max(
    1,
    Math.min(
      Math.floor(opts?.concurrency ?? DEFAULT_TRANSCRIBE_CONCURRENCY),
      MAX_TRANSCRIBE_CONCURRENCY,
    ),
  );
  // Snapshot upfront: transcribed_at persists per asset, so reruns resume
  // without reprocessing, and lanes never contend over the queue.
  const queue = eligibleAssets(Math.min(limit, 2000));
  let processed = 0;

  async function processOne(asset: TranscriptEligible): Promise<void> {
    try {
      const def = endpointFor(asset.source);
      if (!def) {
        markSkipped(db, asset.id, "unsupported source");
        bumpSkipped("unsupported");
        return;
      }
      if (isPhotoUrl(asset.source, asset.source_url)) {
        markSkipped(db, asset.id, "photo post");
        bumpSkipped("photo");
        return;
      }
      const meta = readMeta(db, asset.id);
      const raw =
        meta["raw"] && typeof meta["raw"] === "object"
          ? meta["raw"]
          : (meta[`raw_${asset.source}`] as unknown);
      if (isPhotoRaw(raw)) {
        markSkipped(db, asset.id, "photo post");
        bumpSkipped("photo");
        return;
      }
      const targetUrl = /youtube/i.test(asset.source)
        ? canonicalYoutubeUrl(asset.source_url)
        : asset.source_url;
      const result = await monidRunAndWait(
        apiKey,
        "anyapi",
        def.endpoint,
        { body: { url: targetUrl, route: def.route } },
        { timeoutMs: 300000 },
      );
      if (result.status !== "COMPLETED") throw new Error(`monid run ${result.runId}: ${result.status}`);
      const payload = result.output ?? result.providerResponse;
      const payloadError = monidPayloadError(payload, "video");
      if (payloadError) throw new Error(payloadError);
      const cost = result.cost as { value?: unknown } | undefined;
      if (typeof cost?.value === "number") out.spent += cost.value;
      const parsed = parseTranscript(payload);
      if (!parsed) {
        if (noteEmptyResult(db, asset.id) >= 2) {
          markSkipped(db, asset.id, "no speech detected");
          bumpSkipped("no speech");
          return;
        }
        throw new Error("no transcript in Monid response");
      }
      if ("notFound" in parsed) {
        markSkipped(db, asset.id, "not found");
        bumpSkipped("not found");
        return;
      }
      const row = db.prepare(`SELECT transcript FROM assets WHERE id = ?`).get(asset.id) as {
        transcript: string;
      };
      const existing = (row.transcript ?? "").trim();
      const combined = existing ? `${existing}\n\n[Speech transcript]\n${parsed.text}` : parsed.text;
      db.prepare(`UPDATE assets SET transcript = ?, transcribed_at = ? WHERE id = ?`).run(
        combined.slice(0, 120000),
        nowIso(),
        asset.id,
      );
      out.done++;
    } catch (error) {
      out.failed++;
      if (out.failures.length < 50) {
        out.failures.push({
          asset: asset.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  await runPool(queue, concurrency, async (asset) => {
    await processOne(asset);
    processed++;
    if (onProgress) onProgress(processed, total, out.spent);
  });
  return out;
}
