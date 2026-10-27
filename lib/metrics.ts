// Metrics: engagement extraction, per-platform averages, and multipliers.
// Pure math lives here so tests can pin the brief's rule: each post is
// scored as a multiplier against its platform's average.
import { randomUUID } from "node:crypto";
import { getDb, nowIso } from "./db";
import { loadKeys } from "./keys";
import { zernioAnalyticsDelta, zernioPosts } from "./zernio";

export type Engagement = {
  likes: number | null;
  comments: number | null;
  shares: number | null;
  views: number | null;
};

export type MetricPost = {
  id: string;
  platform: string;
  post_url: string | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  views: number | null;
  posted_at: string | null;
  collected_at: string;
  is_reply: number;
};

export type Averages = {
  count: number;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  views: number | null;
};

export type ScoredPost = MetricPost & {
  multipliers: {
    likes: number | null;
    comments: number | null;
    shares: number | null;
    views: number | null;
  };
};

const EMPTY: Engagement = { likes: null, comments: null, shares: null, views: null };

function normKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z]/g, "");
}

const LIKE_KEYS = new Set(["likes", "like", "likecount", "favorites", "favourites", "diggcount"]);
const COMMENT_KEYS = new Set(["comments", "comment", "commentcount", "replies", "replycount"]);
const SHARE_KEYS = new Set(["shares", "share", "sharecount", "reposts", "repost", "repostcount", "retweets", "retweetcount"]);
const VIEW_KEYS = new Set(["views", "view", "viewcount", "plays", "playcount", "videoviews"]);

function walk(value: unknown, depth: number, out: Engagement): void {
  if (depth <= 0 || value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 20)) walk(item, depth - 1, out);
    return;
  }
  for (const [key, val] of Object.entries(value)) {
    if (typeof val === "number" && Number.isFinite(val)) {
      const k = normKey(key);
      if (LIKE_KEYS.has(k) && out.likes === null) out.likes = Math.round(val);
      else if (COMMENT_KEYS.has(k) && out.comments === null) out.comments = Math.round(val);
      else if (SHARE_KEYS.has(k) && out.shares === null) out.shares = Math.round(val);
      else if (VIEW_KEYS.has(k) && out.views === null) out.views = Math.round(val);
    } else if (val !== null && typeof val === "object") {
      walk(val, depth - 1, out);
    }
  }
}

// Best-effort engagement pull from any provider's raw JSON. Unknown or
// non-numeric shapes yield nulls, never guesses.
export function extractEngagement(raw: unknown): Engagement {
  const out: Engagement = { ...EMPTY };
  walk(raw, 4, out);
  return out;
}

function mean(values: Array<number | null>): number | null {
  const present = values.filter((v): v is number => typeof v === "number");
  if (present.length === 0) return null;
  return present.reduce((a, b) => a + b, 0) / present.length;
}

function multiplier(value: number | null, avg: number | null): number | null {
  if (value === null || avg === null || avg === 0) return null;
  return Math.round((value / avg) * 100) / 100;
}

export function computeAverages(posts: MetricPost[]): Averages {
  return {
    count: posts.length,
    likes: mean(posts.map((p) => p.likes)),
    comments: mean(posts.map((p) => p.comments)),
    shares: mean(posts.map((p) => p.shares)),
    views: mean(posts.map((p) => p.views)),
  };
}

export function scorePosts(posts: MetricPost[], averages: Averages): ScoredPost[] {
  return posts.map((post) => ({
    ...post,
    multipliers: {
      likes: multiplier(post.likes, averages.likes),
      comments: multiplier(post.comments, averages.comments),
      shares: multiplier(post.shares, averages.shares),
      views: multiplier(post.views, averages.views),
    },
  }));
}

export function platformForSource(source: string): string {
  if (source.startsWith("x_")) return "x";
  if (source.startsWith("tiktok_")) return "tiktok";
  if (source.startsWith("instagram_")) return "instagram";
  if (source.startsWith("youtube_")) return "youtube";
  return "other";
}

function pickString(obj: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value) return value;
  }
  return null;
}

function truncateRaw(value: unknown): string {
  try {
    const text = JSON.stringify(value);
    return text.length > 20000 ? `${text.slice(0, 20000)}…[truncated]` : text;
  } catch {
    return "{}";
  }
}

function upsertAssetMetric(
  assetId: string,
  platform: string,
  postUrl: string | null,
  eng: Engagement,
  raw: unknown,
): void {
  const db = getDb();
  const existing = db
    .prepare(`SELECT id FROM post_metrics WHERE asset_id = ?`)
    .get(assetId) as { id: string } | undefined;
  if (existing) {
    db.prepare(
      `UPDATE post_metrics SET likes = ?, comments = ?, shares = ?, views = ?,
       collected_at = ?, raw = ? WHERE id = ?`,
    ).run(eng.likes, eng.comments, eng.shares, eng.views, nowIso(), truncateRaw(raw), existing.id);
  } else {
    db.prepare(
      `INSERT INTO post_metrics (id, asset_id, platform, post_url, likes, comments, shares, views, collected_at, raw)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      randomUUID(), assetId, platform, postUrl,
      eng.likes, eng.comments, eng.shares, eng.views, nowIso(), truncateRaw(raw),
    );
  }
}

export function syncFromAssets(): number {
  const db = getDb();
  const assets = db
    .prepare(`SELECT id, source, source_url, metadata FROM assets`)
    .all() as Array<{ id: string; source: string; source_url: string | null; metadata: string }>;
  let count = 0;
  for (const asset of assets) {
    let meta: Record<string, unknown> = {};
    try {
      meta = JSON.parse(asset.metadata) as Record<string, unknown>;
    } catch {
      continue;
    }
    const raw = (meta.raw ?? meta) as unknown;
    const eng = extractEngagement(raw);
    if (eng.likes === null && eng.comments === null && eng.shares === null && eng.views === null) {
      continue;
    }
    const url =
      asset.source_url ??
      (typeof raw === "object" && raw !== null
        ? pickString(raw as Record<string, unknown>, "url", "permalink", "link")
        : null);
    upsertAssetMetric(asset.id, platformForSource(asset.source), url, eng, raw);
    count++;
  }
  return count;
}

function getCursor(key: string): string | null {
  const row = getDb().prepare(`SELECT value FROM sync_state WHERE key = ?`).get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

function setCursor(key: string, value: string): void {
  getDb()
    .prepare(
      `INSERT INTO sync_state (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .run(key, value, nowIso());
}

function listEntries(payload: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(payload)) return payload.filter((e): e is Record<string, unknown> => typeof e === "object" && e !== null);
  if (typeof payload === "object" && payload !== null) {
    const obj = payload as Record<string, unknown>;
    for (const key of ["entries", "items", "results", "posts", "data"]) {
      const value = obj[key];
      if (Array.isArray(value)) {
        return value.filter((e): e is Record<string, unknown> => typeof e === "object" && e !== null);
      }
    }
  }
  return [];
}

export type MetricsSyncResult = {
  fromAssets: number;
  fromZernio: number;
  errors: string[];
};

export async function runMetricsSync(): Promise<MetricsSyncResult> {
  const errors: string[] = [];
  let fromAssets = 0;
  let fromZernio = 0;
  try {
    fromAssets = syncFromAssets();
  } catch (error) {
    errors.push(`assets: ${(error as Error).message}`);
  }
  const zernioKey = loadKeys().zernio;
  if (zernioKey) {
    try {
      fromZernio = await syncFromZernioAsync(zernioKey);
    } catch (error) {
      errors.push(`zernio: ${(error as Error).message}`);
    }
  }
  return { fromAssets, fromZernio, errors };
}

async function syncFromZernioAsync(apiKey: string): Promise<number> {
  const db = getDb();
  const insert = db.prepare(
    `INSERT INTO post_metrics (id, platform, post_url, likes, comments, shares, views, posted_at, collected_at, raw)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  let count = 0;
  const seen = new Set<string>();
  const ingest = (payload: unknown) => {
    for (const entry of listEntries(payload)) {
      const url = pickString(entry, "permalink", "url", "postUrl", "link");
      const dedupe = url ?? JSON.stringify(entry).slice(0, 200);
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);
      const metrics = (entry.metrics ?? entry.stats ?? entry) as unknown;
      const eng = extractEngagement(metrics);
      if (eng.likes === null && eng.comments === null && eng.shares === null && eng.views === null) {
        continue;
      }
      insert.run(
        randomUUID(),
        (pickString(entry, "platform", "network") ?? "other").toLowerCase(),
        url,
        eng.likes, eng.comments, eng.shares, eng.views,
        pickString(entry, "publishedAt", "postedAt", "createdAt"),
        nowIso(),
        truncateRaw(entry),
      );
      count++;
    }
  };
  const cursor = getCursor("zernio_analytics");
  try {
    const delta = (await zernioAnalyticsDelta(apiKey, cursor)) as Record<string, unknown>;
    ingest(delta);
    const next =
      (delta.nextCursor as string | undefined) ?? (delta.cursor as string | undefined);
    if (typeof next === "string" && next) setCursor("zernio_analytics", next);
  } catch (error) {
    throw new Error(`analytics delta: ${(error as Error).message}`);
  }
  try {
    ingest(await zernioPosts(apiKey));
  } catch {
    // Post list is a bonus source; delta already tried. Swallow quietly.
  }
  return count;
}

export function listMetrics(platform?: string): MetricPost[] {
  const db = getDb();
  const cols = `m.id, m.platform, m.post_url, m.likes, m.comments, m.shares, m.views,
       m.posted_at, m.collected_at, COALESCE(a.is_reply, 0) AS is_reply
       FROM post_metrics m LEFT JOIN assets a ON a.id = m.asset_id`;
  if (platform) {
    return db
      .prepare(`SELECT ${cols} WHERE m.platform = ? ORDER BY m.collected_at DESC LIMIT 500`)
      .all(platform) as MetricPost[];
  }
  return db
    .prepare(`SELECT ${cols} ORDER BY m.collected_at DESC LIMIT 500`)
    .all() as MetricPost[];
}

export function listPlatforms(): string[] {
  const rows = getDb()
    .prepare(`SELECT DISTINCT platform FROM post_metrics ORDER BY platform`)
    .all() as Array<{ platform: string }>;
  return rows.map((r) => r.platform);
}
