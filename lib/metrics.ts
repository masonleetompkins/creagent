// Metrics: engagement extraction, per-platform averages, and multipliers.
// Pure math lives here so tests can pin the brief's rule: each post is
// scored as a multiplier against its platform's average.
import { randomUUID } from "node:crypto";
import { getDb, nowIso, withTransaction } from "./db";

export type Engagement = {
  likes: number | null;
  comments: number | null;
  shares: number | null;
  views: number | null;
  reach: number | null;
  saves: number | null;
};

export type MetricPost = {
  id: string;
  platform: string;
  post_url: string | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  views: number | null;
  reach?: number | null;
  saves?: number | null;
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

const EMPTY: Engagement = {
  likes: null,
  comments: null,
  shares: null,
  views: null,
  reach: null,
  saves: null,
};

function normKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z]/g, "");
}

const LIKE_KEYS = new Set(["likes", "like", "likecount", "reactions", "reactioncount", "diggcount"]);
const COMMENT_KEYS = new Set(["comments", "comment", "commentcount", "replies", "replycount"]);
const SHARE_KEYS = new Set(["shares", "share", "sharecount", "reposts", "repost", "repostcount", "retweets", "retweetcount"]);
const VIEW_KEYS = new Set(["views", "view", "viewcount", "plays", "playcount", "videoviews"]);
const REACH_KEYS = new Set(["reach", "reachcount"]);
// "favorites" means saves on modern providers (TikTok favorites); legacy
// Twitter used it for likes but no current provider emits that shape.
const SAVE_KEYS = new Set(["saves", "save", "savecount", "bookmarks", "bookmark", "favorites", "favourites"]);

function assignMetric(out: Engagement, key: string, val: number): void {
  const k = normKey(key);
  if (LIKE_KEYS.has(k) && out.likes === null) out.likes = Math.round(val);
  else if (COMMENT_KEYS.has(k) && out.comments === null) out.comments = Math.round(val);
  else if (SHARE_KEYS.has(k) && out.shares === null) out.shares = Math.round(val);
  else if (VIEW_KEYS.has(k) && out.views === null) out.views = Math.round(val);
  else if (REACH_KEYS.has(k) && out.reach === null) out.reach = Math.round(val);
  else if (SAVE_KEYS.has(k) && out.saves === null) out.saves = Math.round(val);
}

// Plain numbers plus pure numeric strings ("1780", never "1,780 views").
function toNumber(val: unknown): number | null {
  if (typeof val === "number" && Number.isFinite(val)) return val;
  if (typeof val === "string" && /^-?\d+(\.\d+)?$/.test(val.trim())) {
    const n = Number(val);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function walk(value: unknown, depth: number, out: Engagement): void {
  if (depth <= 0 || value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 20)) walk(item, depth - 1, out);
    return;
  }
  for (const [key, val] of Object.entries(value)) {
    const num = toNumber(val);
    if (num !== null) {
      assignMetric(out, key, num);
    } else if (val !== null && typeof val === "object" && !Array.isArray(val)) {
      // {metric: {value: N}} shapes (TikHub analytics): attribute the inner
      // value to the parent metric key before the generic recursion.
      const inner = toNumber((val as Record<string, unknown>)["value"]);
      if (inner !== null) assignMetric(out, key, inner);
      walk(val, depth - 1, out);
    } else if (val !== null && typeof val === "object") {
      walk(val, depth - 1, out);
    }
  }
}

// Merge two readings of the same post. Engagement counters are lifetime
// cumulative, so per-field max keeps the freshest truth without ever
// letting one provider's zero wipe another's data. Null = unreported.
export function mergeEngagement(a: Engagement, b: Engagement): Engagement {
  const max = (x: number | null, y: number | null): number | null => {
    if (x === null) return y;
    if (y === null) return x;
    return Math.max(x, y);
  };
  return {
    likes: max(a.likes, b.likes),
    comments: max(a.comments, b.comments),
    shares: max(a.shares, b.shares),
    views: max(a.views, b.views),
    reach: max(a.reach, b.reach),
    saves: max(a.saves, b.saves),
  };
}

// True when nothing was actually reported — all null, or all zeros (an
// unsynced analytics entry). Callers skip row creation in that case.
export function engagementEmpty(eng: Engagement): boolean {
  return Object.values(eng).every((v) => v === null || v === 0);
}

// Best-effort engagement pull from any provider's raw JSON. Unknown or
// non-numeric shapes yield nulls, never guesses. Zero views also yields
// null: no served post has zero views, so 0 means the provider didn't
// report (Monid emits 0 for missing) — scoring it as real would tank posts.
export function extractEngagement(raw: unknown): Engagement {
  const out: Engagement = { ...EMPTY };
  walk(raw, 4, out);
  if (out.views === 0) out.views = null;
  return out;
}

// Median, not mean: a creator's own viral hits would otherwise inflate the
// bar every post is measured against. Even counts average the middle two,
// which keeps two-post fixtures identical to the old mean.
function median(values: Array<number | null>): number | null {
  const present = values
    .filter((v): v is number => typeof v === "number")
    .sort((a, b) => a - b);
  if (present.length === 0) return null;
  const mid = Math.floor(present.length / 2);
  return present.length % 2 === 1 ? present[mid] : (present[mid - 1] + present[mid]) / 2;
}

function multiplier(value: number | null, avg: number | null): number | null {
  if (value === null || avg === null || avg === 0) return null;
  return Math.round((value / avg) * 100) / 100;
}

// Named "averages" for the UI's colloquial sense; every value is a median,
// so a creator's own viral hits can't inflate their own baseline.
export function computeAverages(posts: MetricPost[]): Averages {
  return {
    count: posts.length,
    likes: median(posts.map((p) => p.likes)),
    comments: median(posts.map((p) => p.comments)),
    shares: median(posts.map((p) => p.shares)),
    views: median(posts.map((p) => p.views)),
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
  if (source.startsWith("x_") || source === "zernio_twitter") return "x";
  if (source.startsWith("tiktok_") || source === "zernio_tiktok") return "tiktok";
  if (source.startsWith("instagram_") || source === "zernio_instagram") return "instagram";
  if (source.startsWith("youtube_") || source === "zernio_youtube") return "youtube";
  if (source === "zernio_threads") return "threads";
  if (source === "zernio_linkedin" || source.startsWith("linkedin_")) return "linkedin";
  return "other";
}

// Rows ingested before a source was mapped keep a stale platform. Recompute
// from each linked asset's source; idempotent, safe to run every refresh.
export function backfillMetricPlatforms(): number {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT m.id, m.platform, a.source FROM post_metrics m
       JOIN assets a ON a.id = m.asset_id WHERE m.asset_id IS NOT NULL`,
    )
    .all() as Array<{ id: string; platform: string; source: string }>;
  const update = db.prepare(`UPDATE post_metrics SET platform = ? WHERE id = ?`);
  let fixed = 0;
  for (const row of rows) {
    const want = platformForSource(row.source);
    if (want !== row.platform) {
      update.run(want, row.id);
      fixed++;
    }
  }
  return fixed;
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

// Merge a fresh engagement reading into an asset's metric row (creating it
// when missing). Max-merge: providers report the same lifetime counters,
// so the highest reading per field wins and zeros never wipe real data.
export function upsertMetricForAsset(
  assetId: string,
  platform: string,
  postUrl: string | null,
  eng: Engagement,
  raw: unknown,
): void {
  const db = getDb();
  const existing = db
    .prepare(`SELECT id, likes, comments, shares, views, reach, saves FROM post_metrics WHERE asset_id = ?`)
    .get(assetId) as (Engagement & { id: string }) | undefined;
  if (existing) {
    const merged = mergeEngagement(existing, eng);
    db.prepare(
      `UPDATE post_metrics SET likes = ?, comments = ?, shares = ?, views = ?,
       reach = ?, saves = ?, collected_at = ?, raw = ? WHERE id = ?`,
    ).run(
      merged.likes, merged.comments, merged.shares, merged.views,
      merged.reach, merged.saves, nowIso(), truncateRaw(raw), existing.id,
    );
  } else {
    db.prepare(
      `INSERT INTO post_metrics (id, asset_id, platform, post_url, likes, comments, shares, views, reach, saves, collected_at, raw)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      randomUUID(), assetId, platform, postUrl,
      eng.likes, eng.comments, eng.shares, eng.views,
      eng.reach, eng.saves, nowIso(), truncateRaw(raw),
    );
  }
}

function upsertAssetMetric(
  assetId: string,
  platform: string,
  postUrl: string | null,
  eng: Engagement,
  raw: unknown,
): void {
  upsertMetricForAsset(assetId, platform, postUrl, eng, raw);
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
    if (
      eng.likes === null && eng.comments === null && eng.shares === null &&
      eng.views === null && eng.reach === null && eng.saves === null
    ) {
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

export type MetricsSyncResult = {
  fromAssets: number;
  refreshed: number;
  confirmed: string[];
  errors: string[];
};

// Reconcile metrics from stored asset metadata, rescore every post, and
// re-rank the confirmed pillar slots. (Zernio's leg moved to
// runZernioAnalyticsBackfill in ingest.ts, which the sync_metrics job runs
// first; the old delta/posts endpoints returned nothing.)
export async function runMetricsSync(): Promise<MetricsSyncResult> {
  const errors: string[] = [];
  let fromAssets = 0;
  try {
    fromAssets = syncFromAssets();
  } catch (error) {
    errors.push(`assets: ${(error as Error).message}`);
  }
  let refreshed = 0;
  let confirmed: string[] = [];
  try {
    refreshed = refreshMultipliers();
    confirmed = autoConfirmTopPillars();
  } catch (error) {
    errors.push(`rescore: ${(error as Error).message}`);
  }
  return { fromAssets, refreshed, confirmed, errors };
}

export function listMetrics(platform?: string): MetricPost[] {
  const db = getDb();
  const cols = `m.id, m.platform, m.post_url, m.likes, m.comments, m.shares, m.views,
       m.reach, m.saves, m.posted_at, m.collected_at, COALESCE(a.is_reply, 0) AS is_reply
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

// Platforms whose views are structurally unavailable (LinkedIn exposes no
// public view counts anywhere) score on likes instead — an explicit,
// labeled exception to views-only scoring. Everywhere else, likes-only
// posts go NULL rather than scoring on a lesser metric.
const LIKES_BASIS_PLATFORMS = new Set(["linkedin"]);

// Score every linked asset against its platform's median and store it.
// Basis is views, except LIKES_BASIS_PLATFORMS which use likes. The median
// uses non-replies reporting the basis metric only (replies perform on a
// different curve); replies are still scored against that bar. Idempotent —
// rerun whenever metrics change.
export function refreshMultipliers(): number {
  syncFromAssets();
  backfillMetricPlatforms();
  const db = getDb();
  const platforms = db.prepare(`SELECT DISTINCT platform FROM post_metrics`).all() as Array<{
    platform: string;
  }>;
  const update = db.prepare(`UPDATE assets SET multiplier = ? WHERE id = ?`);
  let updated = 0;
  for (const { platform } of platforms) {
    const useLikes = LIKES_BASIS_PLATFORMS.has(platform);
    const rows = db
      .prepare(
        `SELECT m.asset_id, m.likes, m.views, COALESCE(a.is_reply, 0) AS is_reply
         FROM post_metrics m LEFT JOIN assets a ON a.id = m.asset_id
         WHERE m.platform = ?`,
      )
      .all(platform) as Array<{
      asset_id: string | null;
      likes: number | null;
      views: number | null;
      is_reply: number;
    }>;
    const med = median(
      rows.filter((r) => !r.is_reply).map((r) => (useLikes ? r.likes : r.views)),
    );
    for (const row of rows) {
      if (!row.asset_id) continue;
      const value = useLikes ? row.likes : row.views;
      const scored =
        value !== null && med !== null && med > 0
          ? Math.round((value / med) * 100) / 100
          : null;
      update.run(scored, row.asset_id);
      updated++;
    }
  }
  return updated;
}

export type PillarPlatformStat = { posts: number; multiplier: number | null };

export type PillarStat = {
  posts: number;
  recent: number;
  // Headline badge: the primary platform's average (most linked posts),
  // so a cross-platform pillar reads as its dominant surface. Falls back
  // to the overall non-reply average when the primary platform is unscored.
  multiplier: number | null;
  byPlatform: Record<string, PillarPlatformStat>;
};

// Per-pillar post counts (all-time + last ~6 months) and per-platform
// average stored multipliers. Replies are excluded from every average
// (they perform on a different curve) but still count as linked posts,
// and NULL multipliers never drag an average.
export function pillarStats(): Record<string, PillarStat> {
  const sixmo = new Date(Date.now() - 182 * 24 * 3600 * 1000).toISOString();
  const rows = getDb()
    .prepare(
      `SELECT pillar_id, source, is_reply, multiplier, COALESCE(posted_at, created_at) AS ts
       FROM assets WHERE pillar_id IS NOT NULL`,
    )
    .all() as Array<{
    pillar_id: string;
    source: string;
    is_reply: number;
    multiplier: number | null;
    ts: string;
  }>;
  const avg = (mults: Array<number | null>): number | null => {
    const scored = mults.filter((m): m is number => typeof m === "number");
    if (scored.length === 0) return null;
    return Math.round((scored.reduce((a, b) => a + b, 0) / scored.length) * 100) / 100;
  };
  const byPillar = new Map<string, typeof rows>();
  for (const row of rows) {
    const group = byPillar.get(row.pillar_id) ?? [];
    group.push(row);
    byPillar.set(row.pillar_id, group);
  }
  const out: Record<string, PillarStat> = {};
  for (const [pillarId, group] of byPillar) {
    const byPlatform: Record<string, PillarPlatformStat> = {};
    for (const row of group) {
      const platform = platformForSource(row.source);
      const stat = byPlatform[platform] ?? { posts: 0, multiplier: null };
      stat.posts++;
      byPlatform[platform] = stat;
    }
    for (const platform of Object.keys(byPlatform)) {
      byPlatform[platform].multiplier = avg(
        group
          .filter((r) => !r.is_reply && platformForSource(r.source) === platform)
          .map((r) => r.multiplier),
      );
    }
    const primary = Object.entries(byPlatform).sort(
      (a, b) => b[1].posts - a[1].posts || a[0].localeCompare(b[0]),
    )[0]?.[0];
    out[pillarId] = {
      posts: group.length,
      recent: group.filter((r) => r.ts >= sixmo).length,
      multiplier:
        (primary ? byPlatform[primary].multiplier : null) ??
        avg(group.filter((r) => !r.is_reply).map((r) => r.multiplier)),
      byPlatform,
    };
  }
  return out;
}

// Fill the 5 confirmed slots with the highest-multiple pillars, rank order.
// Every other pillar is released back to suggestions (rows and user edits
// are untouched — only the flag flips). Returns confirmed names in rank
// order. Runs at the end of consolidation; manual swaps last until the
// next consolidate/regenerate re-ranks.
export function autoConfirmTopPillars(limit = 5): string[] {
  const db = getDb();
  const stats = pillarStats();
  const pillars = db.prepare(`SELECT id, name FROM pillars`).all() as Array<{
    id: string;
    name: string;
  }>;
  const ranked = pillars
    .map((p) => ({
      id: p.id,
      name: p.name,
      mult: stats[p.id]?.multiplier ?? null,
      posts: stats[p.id]?.posts ?? 0,
    }))
    .sort(
      (a, b) =>
        (b.mult ?? -1) - (a.mult ?? -1) || b.posts - a.posts || a.name.localeCompare(b.name),
    );
  const winners = new Set(ranked.slice(0, limit).map((p) => p.id));
  const setFlag = db.prepare(`UPDATE pillars SET confirmed = ? WHERE id = ?`);
  withTransaction(() => {
    for (const p of ranked) setFlag.run(winners.has(p.id) ? 1 : 0, p.id);
  });
  return ranked.filter((p) => winners.has(p.id)).map((p) => p.name);
}
