// Content ingest: Monid endpoint registry, response normalization, asset writes.
import { randomUUID } from "node:crypto";
import { getDb, nowIso } from "./db";
import { loadKeys } from "./keys";
import { monidRunAndWait } from "./monid";

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

export function isIngestSource(value: string): value is IngestSource {
  return value in INGEST_SOURCES;
}

function isObj(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
  };
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
  costs: unknown[];
};

const MAX_PAGES = 5;

export async function runIngest(
  source: IngestSource,
  value: string,
  onProgress?: (assets: number) => Promise<void> | void,
): Promise<IngestResult> {
  const def = INGEST_SOURCES[source];
  const apiKey = loadKeys().monid;
  if (!apiKey) throw new Error("save a Monid key in Settings first");
  const db = getDb();
  const insert = db.prepare(
    `INSERT INTO assets (id, source, source_url, kind, title, transcript, metadata, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  let cursor: string | null = null;
  let assets = 0;
  let pages = 0;
  const costs: unknown[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const body: Record<string, string> =
      def.inputKind === "handle"
        ? { handle: value.replace(/^@/, "").trim() }
        : { url: value.trim() };
    if (!body.handle && !body.url) throw new Error("ingest input is empty");
    if (cursor) body.cursor = cursor;
    const result = await monidRunAndWait(apiKey, def.provider, def.endpoint, {
      body,
    });
    if (result.status !== "COMPLETED") {
      throw new Error(`monid run ${result.runId}: ${result.status}`);
    }
    costs.push(result.cost);
    const payload = runPayload(result);
    const items = findItems(payload);
    for (const item of items) {
      const asset = itemToAsset(item);
      insert.run(
        randomUUID(),
        source,
        asset.sourceUrl,
        source,
        asset.title,
        asset.transcript,
        JSON.stringify({ runId: result.runId, raw: truncateRaw(item, 4) }),
        nowIso(),
      );
      assets++;
    }
    pages++;
    if (onProgress) await onProgress(assets);
    cursor = def.inputKind === "handle" ? findCursor(payload) : null;
    if (!cursor) break;
  }
  return { assets, pages, costs };
}
