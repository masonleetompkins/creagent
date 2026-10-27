// Content ingest: Monid endpoint registry, response normalization, asset writes.
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { getDb, nowIso } from "./db";
import { loadKeys } from "./keys";
import { monidRunAndWait } from "./monid";
import { zernioAccountPosts, zernioAccounts } from "./zernio";

export const INGEST_SOURCES = {
  x_posts: {
    label: "X posts by handle",
    provider: "anyapi",
    endpoint: "/twitter.user_posts",
    inputKind: "handle",
    placeholder: "username (no @)",
  },
  tiktok_videos: {
    label: "TikTok videos by handle",
    provider: "anyapi",
    endpoint: "/tiktok.profile_videos",
    inputKind: "handle",
    placeholder: "username (no @)",
  },
  instagram_posts: {
    label: "Instagram posts by handle",
    provider: "anyapi",
    endpoint: "/instagram.user_posts",
    inputKind: "handle",
    placeholder: "username (no @)",
  },
  youtube_transcript: {
    label: "YouTube transcript by URL",
    provider: "anyapi",
    endpoint: "/youtube.video_transcript_full",
    inputKind: "url",
    placeholder: "https://www.youtube.com/watch?v=…",
  },
  instagram_reel: {
    label: "Instagram reel transcript by URL",
    provider: "anyapi",
    endpoint: "/instagram.reel_transcript",
    inputKind: "url",
    placeholder: "https://www.instagram.com/reel/…",
  },
} as const;

export type IngestSource = keyof typeof INGEST_SOURCES;

// Monid upstream routes by reliability (from /v1/inspect uptime stats).
// The default route fails silently too often, so we pin the best route and
// fall back automatically instead of reporting a bogus "0 new".
const MONID_ROUTES: Record<IngestSource, string[]> = {
  x_posts: ["lynx", "capybara"],
  tiktok_videos: ["giraffe", "fox"],
  instagram_posts: ["lynx", "fox"],
  youtube_transcript: ["badger", "octopus"],
  instagram_reel: ["anyapi"],
};

// Monid marks runs COMPLETED even when the provider failed or the handle
// doesn't exist — the failure hides inside the payload. Detect it so the
// UI reports a failed target instead of a green "0 new".
export function monidPayloadError(payload: unknown): string | null {
  if (!isObj(payload)) return null;
  if (payload["found"] === false) {
    return `handle not found (${String(payload["reason"] ?? "not_found")}) — check the spelling`;
  }
  const http = payload["httpStatus"];
  if (typeof http === "number" && http >= 400) {
    const err = payload["error"];
    const msg = isObj(err) ? String(err["error"] ?? err["message"] ?? "") : String(err ?? "");
    return `Monid provider error (HTTP ${http}${msg ? `: ${msg}` : ""})`;
  }
  return null;
}

export function isIngestSource(value: string): value is IngestSource {
  return value in INGEST_SOURCES;
}

function isObj(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Canonical post URL for cross-source dedupe: Monid and Zernio often report
// the same post with different wrappers (http/https, query params, m. host).
export function normalizeUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  if (!/^https?:\/\//i.test(trimmed)) return trimmed.toLowerCase();
  try {
    const parsed = new URL(trimmed);
    let host = parsed.hostname.toLowerCase().replace(/^(m|mobile|www)\./, "");
    if (host === "twitter.com") host = "x.com";
    const path = parsed.pathname.replace(/\/+$/, "");
    return `${host}${path}`;
  } catch {
    return trimmed
      .toLowerCase()
      .replace(/^[a-z]+:\/\/(m|mobile|www)\./, "")
      .replace(/[?#].*$/, "")
      .replace(/\/+$/, "");
  }
}

// Reply detection for X/Threads (and any source using the same markers):
// referenced_tweets with replied_to, in_reply_to_*/parent_* ids, or an
// explicit reply post type.
export function detectReply(item: Record<string, unknown>): boolean {
  const refs = item["referenced_tweets"];
  if (
    Array.isArray(refs) &&
    refs.some(
      (r) => isObj(r) && /reply|replied/i.test(String(r["type"] ?? "")),
    )
  ) {
    return true;
  }
  for (const key of [
    "in_reply_to_status_id",
    "in_reply_to_status_id_str",
    "in_reply_to_id",
    "in_reply_to",
    "parent_id",
    "parent_post_id",
    "reply_to",
  ]) {
    const v = item[key];
    if (v === null || v === undefined) continue;
    const s = String(v).trim();
    if (s !== "" && s !== "0") return true;
  }
  const t = String(
    item["post_type"] ?? item["type"] ?? item["kind"] ?? "",
  ).toLowerCase();
  return t === "reply" || t === "comment" || t === "response";
}

function pick(item: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = item[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return "";
}

function itemToAsset(item: Record<string, unknown>): {
  title: string;
  transcript: string;
  sourceUrl: string | null;
  postedAt: string | null;
} {
  const text = pick(
    item,
    "transcript",
    "full_text",
    "text",
    "caption",
    "content",
    "description",
  );
  const title =
    pick(item, "title", "name") || text.slice(0, 80) || "(untitled)";
  const url = pick(item, "url", "link", "permalink", "video_url", "post_url");
  return {
    title: title.slice(0, 300),
    transcript: text.slice(0, 20000),
    sourceUrl: url || null,
    postedAt: parsePostedAt(item),
  };
}

const DATE_KEYS = [
  "created_at",
  "createdAt",
  "createdUtc",
  "created_utc",
  "createdTime",
  "created_time",
  "createTime",
  "create_time",
  "published_at",
  "publishedAt",
  "publishTime",
  "publish_time",
  "date",
  "timestamp",
  "taken_at",
  "takenAt",
  "upload_date",
  "uploadDate",
];

export function parsePostedAt(item: Record<string, unknown>): string | null {
  for (const key of DATE_KEYS) {
    const value = item[key];
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      // Heuristic: seconds (< 1e12) vs milliseconds.
      const ms = value < 1e12 ? value * 1000 : value;
      const d = new Date(ms);
      if (!Number.isNaN(d.getTime())) return d.toISOString();
    }
    if (typeof value === "string" && value.trim()) {
      const num = Number(value);
      if (Number.isFinite(num) && num > 0 && /^\d+(\.\d+)?$/.test(value.trim())) {
        const ms = num < 1e12 ? num * 1000 : num;
        const d = new Date(ms);
        if (!Number.isNaN(d.getTime())) return d.toISOString();
        continue;
      }
      const d = new Date(value);
      if (!Number.isNaN(d.getTime())) return d.toISOString();
    }
  }
  return null;
}

const ITEM_KEYS = ["items", "results", "posts", "videos", "tweets", "data"];

function findItems(resp: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(resp)) return resp.filter(isObj);
  if (isObj(resp)) {
    for (const key of ITEM_KEYS) {
      const value = resp[key];
      if (Array.isArray(value)) return value.filter(isObj);
    }
    // Common envelope: {data: {tweets: [...], nextCursor}} — recurse once.
    const data = resp["data"];
    if (isObj(data)) {
      for (const key of ITEM_KEYS) {
        const value = data[key];
        if (Array.isArray(value)) return value.filter(isObj);
      }
    }
    if (
      typeof resp.transcript === "string" ||
      typeof resp.text === "string"
    ) {
      return [resp];
    }
  }
  return [];
}

function findCursor(resp: unknown): string | null {
  const scan = (obj: Record<string, unknown>): string | null => {
    for (const key of ["nextCursor", "next_cursor", "cursor"]) {
      const value = obj[key];
      if (typeof value === "string" && value) return value;
    }
    return null;
  };
  if (!isObj(resp)) return null;
  return scan(resp) ?? (isObj(resp["data"]) ? scan(resp["data"]) : null);
}

// Live runs put the payload on top-level `output`; fall back to providerResponse.
export function runPayload(result: { output?: unknown; providerResponse?: unknown }): unknown {
  return result.output ?? result.providerResponse;
}

function truncateRaw(value: unknown, depth: number): unknown {
  if (typeof value === "string") {
    return value.length > 2000 ? `${value.slice(0, 2000)}…[truncated]` : value;
  }
  if (Array.isArray(value)) {
    if (depth <= 0) return "[array]";
    return value.slice(0, 50).map((v) => truncateRaw(v, depth - 1));
  }
  if (isObj(value)) {
    if (depth <= 0) return "[object]";
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value).slice(0, 60)) {
      out[k] = truncateRaw(v, depth - 1);
    }
    return out;
  }
  return value;
}

export type IngestResult = {
  assets: number;
  pages: number;
  skipped: number;
  duplicates: number;
  costs: unknown[];
};

type AssetInput = {
  source: string;
  sourceUrl: string | null;
  title: string;
  transcript: string;
  metadata: Record<string, unknown>;
  postedAt: string | null;
  isReply: boolean;
};

// Insert or combine: when the same post arrives from a second provider (or a
// second run), fold the new fields into the one existing entry instead of
// duplicating it. Returns "inserted" or "merged".
export function storeAsset(db: DatabaseSync, row: AssetInput): "inserted" | "merged" {
  const norm = row.sourceUrl ? normalizeUrl(row.sourceUrl) : "";
  type Existing = {
    id: string;
    title: string;
    transcript: string;
    posted_at: string | null;
    metadata: string;
    is_reply: number;
  };
  const existing = (
    row.sourceUrl
      ? db
          .prepare(
            `SELECT id, title, transcript, posted_at, metadata, is_reply FROM assets
             WHERE source_url = ? OR url_norm = ? LIMIT 1`,
          )
          .get(row.sourceUrl, norm || "\0")
      : undefined
  ) as Existing | undefined;
  if (!existing) {
    db.prepare(
      `INSERT INTO assets (id, source, source_url, url_norm, kind, title, transcript, metadata, posted_at, is_reply, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      randomUUID(),
      row.source,
      row.sourceUrl,
      norm || null,
      row.source,
      row.title,
      row.transcript,
      JSON.stringify({ ...row.metadata, sources: [row.source] }),
      row.postedAt,
      row.isReply ? 1 : 0,
      nowIso(),
    );
    return "inserted";
  }
  let meta: Record<string, unknown> = {};
  try {
    meta = JSON.parse(existing.metadata) as Record<string, unknown>;
  } catch {
    /* keep incoming */
  }
  const sources = new Set<string>([
    ...((meta["sources"] as string[] | undefined) ?? []),
    row.source,
  ]);
  const mergedMeta: Record<string, unknown> = {
    ...meta,
    sources: [...sources],
    [`raw_${row.source}`]: row.metadata["raw"],
  };
  db.prepare(
    `UPDATE assets SET title = ?, transcript = ?, posted_at = ?, metadata = ?, is_reply = ? WHERE id = ?`,
  ).run(
    existing.title || row.title,
    existing.transcript || row.transcript,
    existing.posted_at ?? row.postedAt,
    JSON.stringify(mergedMeta),
    existing.is_reply || row.isReply ? 1 : 0,
    existing.id,
  );
  return "merged";
}

export type IngestWindow = { since?: string; until?: string };

const MAX_PAGES = 5;

export async function runIngest(
  source: IngestSource,
  value: string,
  onProgress?: (assets: number) => Promise<void> | void,
  window?: IngestWindow,
  maxPages = MAX_PAGES,
): Promise<IngestResult> {
  const def = INGEST_SOURCES[source];
  const apiKey = loadKeys().monid;
  if (!apiKey) throw new Error("save a Monid key in Settings first");
  const sinceMs = window?.since ? Date.parse(window.since) : Number.NaN;
  const untilMs = window?.until ? Date.parse(window.until) : Number.NaN;
  const db = getDb();
  let cursor: string | null = null;
  let assets = 0;
  let pages = 0;
  let skipped = 0;
  let duplicates = 0;
  const costs: unknown[] = [];
  for (let page = 0; page < Math.max(1, Math.min(maxPages, 50)); page++) {
    const body: Record<string, string> =
      def.inputKind === "handle"
        ? { handle: value.replace(/^@/, "").trim() }
        : { url: value.trim() };
    if (!body.handle && !body.url) throw new Error("ingest input is empty");
    if (cursor) body.cursor = cursor;
    let result: Awaited<ReturnType<typeof monidRunAndWait>> | null = null;
    let lastError: string | null = null;
    for (const route of MONID_ROUTES[source]) {
      const attempt = await monidRunAndWait(apiKey, def.provider, def.endpoint, {
        body: { ...body, route },
      });
      costs.push({ route, cost: attempt.cost });
      if (attempt.status !== "COMPLETED") {
        lastError = `monid run ${attempt.runId}: ${attempt.status}`;
        continue;
      }
      const payloadError = monidPayloadError(runPayload(attempt));
      if (!payloadError) {
        result = attempt;
        break;
      }
      lastError = payloadError;
      if (/not found/i.test(payloadError)) break;
    }
    if (!result) throw new Error(lastError ?? "monid returned no usable payload");
    const payload = runPayload(result);
    const items = findItems(payload);
    let pageDated = 0;
    let pageOlderThanSince = 0;
    for (const item of items) {
      const asset = itemToAsset(item);
      if (asset.postedAt) {
        const ms = Date.parse(asset.postedAt);
        pageDated++;
        if (!Number.isNaN(sinceMs) && ms < sinceMs) pageOlderThanSince++;
        if (
          (!Number.isNaN(sinceMs) && ms < sinceMs) ||
          (!Number.isNaN(untilMs) && ms > untilMs)
        ) {
          skipped++;
          continue;
        }
      }
      const stored = storeAsset(db, {
        source,
        sourceUrl: asset.sourceUrl,
        title: asset.title,
        transcript: asset.transcript,
        metadata: { runId: result.runId, raw: truncateRaw(item, 4) },
        postedAt: asset.postedAt,
        isReply: detectReply(item),
      });
      if (stored === "merged") duplicates++;
      else assets++;
    }
    pages++;
    if (onProgress) await onProgress(assets);
    // Handle feeds arrive newest-first: once a whole page predates the
    // window, deeper pages only cost money.
    if (!Number.isNaN(sinceMs) && pageDated > 0 && pageOlderThanSince === pageDated) break;
    cursor = def.inputKind === "handle" ? findCursor(payload) : null;
    if (!cursor) break;
  }
  return { assets, pages, skipped, duplicates, costs };
}

export type ZernioIngestResult = {
  assets: number;
  skipped: number;
  duplicates: number;
  accounts: number;
};

// Pull posts for connected Zernio accounts. Free (no per-call cost);
// window + dedupe behave like Monid ingest.
export async function runZernioIngest(
  accountIds: string[],
  window?: IngestWindow,
  onProgress?: (assets: number) => Promise<void> | void,
): Promise<ZernioIngestResult> {
  const apiKey = loadKeys().zernio;
  if (!apiKey) throw new Error("save a Zernio key in Settings first");
  if (accountIds.length === 0) throw new Error("no Zernio accounts selected");
  const sinceMs = window?.since ? Date.parse(window.since) : Number.NaN;
  const untilMs = window?.until ? Date.parse(window.until) : Number.NaN;
  const accounts = await zernioAccounts(apiKey);
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const db = getDb();
  let assets = 0;
  let skipped = 0;
  let duplicates = 0;
  let done = 0;
  for (const accountId of accountIds) {
    const account = byId.get(accountId);
    if (!account) {
      skipped++;
      continue;
    }
    const source = `zernio_${account.platform}`;
    const posts = await zernioAccountPosts(apiKey, accountId);
    for (const post of posts) {
      const text =
        pick(post, "message", "text", "caption", "content", "description") || "";
      const title = (pick(post, "title", "name") || text.slice(0, 80) || "(untitled)").slice(0, 300);
      const providerId = pick(post, "id", "_id", "postId");
      const url =
        pick(post, "permalink", "url", "link", "post_url") ||
        (providerId ? `zernio:${account.platform}:${providerId}` : "");
      const postedAt = parsePostedAt(post);
      if (postedAt) {
        const ms = Date.parse(postedAt);
        if (
          (!Number.isNaN(sinceMs) && ms < sinceMs) ||
          (!Number.isNaN(untilMs) && ms > untilMs)
        ) {
          skipped++;
          continue;
        }
      }
      const stored = storeAsset(db, {
        source,
        sourceUrl: url || null,
        title,
        transcript: text.slice(0, 20000),
        metadata: { accountId, platform: account.platform, raw: truncateRaw(post, 4) },
        postedAt,
        isReply: detectReply(post),
      });
      if (stored === "merged") duplicates++;
      else assets++;
    }
    done++;
    if (onProgress) await onProgress(assets);
  }
  return { assets, skipped, duplicates, accounts: done };
}
