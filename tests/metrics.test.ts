import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  computeAverages,
  extractEngagement,
  platformForSource,
  scorePosts,
  type MetricPost,
} from "../lib/metrics";

function post(partial: Partial<MetricPost>): MetricPost {
  return {
    id: "test",
    platform: "x",
    post_url: null,
    likes: null,
    comments: null,
    shares: null,
    views: null,
    posted_at: null,
    collected_at: "2026-10-26T00:00:00.000Z",
    is_reply: 0,
    ...partial,
  };
}

describe("extractEngagement", () => {
  it("reads twitter-style snake_case counters", () => {
    assert.deepEqual(extractEngagement({ like_count: 10, view_count: 100 }), {
      likes: 10,
      comments: null,
      shares: null,
      views: 100,
      reach: null,
      saves: null,
    });
  });

  it("reads tiktok-style plain counters", () => {
    assert.deepEqual(
      extractEngagement({ likes: 5, comments: 2, shares: 1, views: 50 }),
      { likes: 5, comments: 2, shares: 1, views: 50, reach: null, saves: null },
    );
  });

  it("finds counters nested under stats/metrics objects", () => {
    assert.deepEqual(extractEngagement({ stats: { likes: 7 } }), {
      likes: 7,
      comments: null,
      shares: null,
      views: null,
      reach: null,
      saves: null,
    });
  });

  it("fails closed on garbage: nulls, never guesses", () => {
    assert.deepEqual(extractEngagement({ likes: "lots", views: null }), {
      likes: null,
      comments: null,
      shares: null,
      views: null,
      reach: null,
      saves: null,
    });
    assert.deepEqual(extractEngagement(null), {
      likes: null,
      comments: null,
      shares: null,
      views: null,
      reach: null,
      saves: null,
    });
  });
});

describe("averages and multipliers", () => {
  it("averages only posts that reported each metric", () => {
    const avg = computeAverages([
      post({ likes: 10, views: 100 }),
      post({ likes: 30 }),
    ]);
    assert.equal(avg.count, 2);
    assert.equal(avg.likes, 20);
    assert.equal(avg.views, 100);
    assert.equal(avg.comments, null);
  });

  it("scores each post as a multiplier against the average", () => {
    const posts = [post({ id: "a", likes: 10 }), post({ id: "b", likes: 30 })];
    const avg = computeAverages(posts);
    const [a, b] = scorePosts(posts, avg);
    assert.equal(a.multipliers.likes, 0.5);
    assert.equal(b.multipliers.likes, 1.5);
  });

  it("yields null multipliers when the average is zero or missing", () => {
    const posts = [post({ id: "a", likes: 0 }), post({ id: "b", likes: 0 })];
    const [a] = scorePosts(posts, computeAverages(posts));
    assert.equal(a.multipliers.likes, null);
    const [c] = scorePosts([post({ id: "c" })], computeAverages([post({})]));
    assert.equal(c.multipliers.views, null);
  });
});

describe("platformForSource", () => {
  it("maps ingest sources to platforms", () => {
    assert.equal(platformForSource("x_posts"), "x");
    assert.equal(platformForSource("tiktok_videos"), "tiktok");
    assert.equal(platformForSource("instagram_posts"), "instagram");
    assert.equal(platformForSource("youtube_transcript"), "youtube");
    assert.equal(platformForSource("zernio_twitter"), "x");
    assert.equal(platformForSource("zernio_tiktok"), "tiktok");
    assert.equal(platformForSource("zernio_instagram"), "instagram");
    assert.equal(platformForSource("zernio_youtube"), "youtube");
    assert.equal(platformForSource("zernio_threads"), "threads");
    assert.equal(platformForSource("zernio_linkedin"), "linkedin");
    assert.equal(platformForSource("something_new"), "other");
  });
});

describe("refreshMultipliers", () => {
  it("scores assets against non-reply platform averages", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    process.env.SQLITE_PATH = join(mkdtempSync(join(tmpdir(), "creagent-mult-")), "test.sqlite");
    await import("../scripts/migrate");
    const { getDb } = await import("../lib/db");
    const { refreshMultipliers, pillarStats } = await import("../lib/metrics");
    const db = getDb();
    const recent = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
    const old = new Date(Date.now() - 300 * 24 * 3600 * 1000).toISOString();
    db.prepare(
      `INSERT INTO pillars (id, name, description, voice_notes, confirmed, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("pp1", "P1", "", "", 0, "2026-01-01T00:00:00.000Z");
    const insert = db.prepare(
      `INSERT INTO assets (id, source, kind, title, transcript, metadata, is_reply, pillar_id, multiplier, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    insert.run("m1", "x_posts", "x", "t", "", JSON.stringify({ raw: { viewCount: 100 } }), 0, "pp1", null, recent);
    insert.run("m2", "x_posts", "x", "t", "", JSON.stringify({ raw: { viewCount: 50 } }), 0, "pp1", null, old);
    insert.run("m3", "x_posts", "x", "t", "", JSON.stringify({ raw: { viewCount: 1000 } }), 1, null, null, recent);
    insert.run("m4", "x_posts", "x", "t", "", JSON.stringify({ raw: { note: "no numbers" } }), 0, null, null, recent);
    // Non-reply views median = 75.
    assert.equal(refreshMultipliers(), 3);
    const mult = (id: string): number | null =>
      (db.prepare(`SELECT multiplier FROM assets WHERE id = ?`).get(id) as { multiplier: number | null }).multiplier;
    assert.equal(mult("m1"), 1.33);
    assert.equal(mult("m2"), 0.67);
    assert.equal(mult("m3"), 13.33);
    assert.equal(mult("m4"), null);
    const stats = pillarStats();
    assert.deepEqual(stats["pp1"], {
      posts: 2,
      recent: 1,
      multiplier: 1,
      byPlatform: { x: { posts: 2, multiplier: 1 } },
    });
    assert.equal(stats["missing"], undefined);
  });
});

describe("median-based scoring", () => {
  it("uses the median so viral hits don't inflate the bar", () => {
    const avg = computeAverages([
      post({ likes: 10 }),
      post({ likes: 20 }),
      post({ likes: 1000 }),
    ]);
    assert.equal(avg.likes, 20);
    const [a, , c] = scorePosts(
      [post({ id: "a", likes: 10 }), post({ id: "b", likes: 20 }), post({ id: "c", likes: 1000 })],
      avg,
    );
    assert.equal(a.multipliers.likes, 0.5);
    assert.equal(c.multipliers.likes, 50);
  });

  it("treats zero views as missing, never as a real zero", () => {
    assert.deepEqual(extractEngagement({ views: 0, likes: 5 }), {
      likes: 5,
      comments: null,
      shares: null,
      views: null,
      reach: null,
      saves: null,
    });
  });

  it("scores views only; likes-only posts go unscored", async () => {
    const { getDb } = await import("../lib/db");
    const { refreshMultipliers } = await import("../lib/metrics");
    const db = getDb();
    const recent = new Date(Date.now() - 10 * 24 * 3600 * 1000).toISOString();
    db.prepare(
      `INSERT INTO pillars (id, name, description, voice_notes, confirmed, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("pp2", "P2", "", "", 0, "2026-01-01T00:00:00.000Z");
    const insert = db.prepare(
      `INSERT INTO assets (id, source, kind, title, transcript, metadata, is_reply, pillar_id, multiplier, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const raw = (o: unknown): string => JSON.stringify({ raw: o });
    // IG views median = 200. Likes-only rows stay NULL: no likes fallback.
    insert.run("g1", "instagram_posts", "ig", "t", "", raw({ viewCount: 400 }), 0, "pp2", null, recent);
    insert.run("g2", "instagram_posts", "ig", "t", "", raw({ viewCount: 200 }), 0, null, null, recent);
    insert.run("g3", "instagram_posts", "ig", "t", "", raw({ viewCount: 100 }), 0, null, null, recent);
    insert.run("g4", "instagram_posts", "ig", "t", "", raw({ likeCount: 9000 }), 0, "pp2", null, recent);
    insert.run("g5", "instagram_posts", "ig", "t", "", raw({ likeCount: 30 }), 0, null, null, recent);
    insert.run("x1", "x_posts", "x", "t", "", raw({ viewCount: 150 }), 0, "pp2", null, recent);
    assert.ok(refreshMultipliers() >= 6);
    const mult = (id: string): number | null =>
      (db.prepare(`SELECT multiplier FROM assets WHERE id = ?`).get(id) as { multiplier: number | null }).multiplier;
    assert.equal(mult("g1"), 2);
    assert.equal(mult("g2"), 1);
    assert.equal(mult("g3"), 0.5);
    assert.equal(mult("g4"), null);
    assert.equal(mult("g5"), null);
    // x views median over non-replies [100, 50, 150] = 100.
    assert.equal(mult("x1"), 1.5);
  });

  it("repairs stale 'other' platforms from the asset source", async () => {
    const { getDb } = await import("../lib/db");
    const { backfillMetricPlatforms } = await import("../lib/metrics");
    const db = getDb();
    db.prepare(
      `INSERT INTO assets (id, source, kind, title, transcript, metadata, is_reply, pillar_id, multiplier, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("yt1", "zernio_youtube", "yt", "t", "", "{}", 0, null, null, "2026-01-01T00:00:00.000Z");
    db.prepare(
      `INSERT INTO post_metrics (id, asset_id, platform, likes, collected_at) VALUES (?, ?, ?, ?, ?)`,
    ).run("pm-stale", "yt1", "other", 67, "2026-01-01T00:00:00.000Z");
    assert.ok(backfillMetricPlatforms() >= 1);
    const row = db.prepare(`SELECT platform FROM post_metrics WHERE id = ?`).get("pm-stale") as {
      platform: string;
    };
    assert.equal(row.platform, "youtube");
    assert.equal(backfillMetricPlatforms(), 0);
  });

  it("reports per-platform pillar stats with a primary-platform headline", async () => {
    const { pillarStats } = await import("../lib/metrics");
    const stats = pillarStats();
    // pp2: g1 (ig 2.0), g4 (ig unscored), x1 (x 1.5). Primary = instagram.
    assert.deepEqual(stats["pp2"], {
      posts: 3,
      recent: 3,
      multiplier: 2,
      byPlatform: {
        instagram: { posts: 2, multiplier: 2 },
        x: { posts: 1, multiplier: 1.5 },
      },
    });
  });
});

describe("autoConfirmTopPillars", () => {
  it("fills the 5 slots with the highest multiples, rank order", async () => {
    const { getDb } = await import("../lib/db");
    const { autoConfirmTopPillars } = await import("../lib/metrics");
    const db = getDb();
    const mkpillar = db.prepare(
      `INSERT INTO pillars (id, name, description, voice_notes, confirmed, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const mkasset = db.prepare(
      `INSERT INTO assets (id, source, kind, title, transcript, metadata, is_reply, pillar_id, multiplier, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const recent = new Date(Date.now() - 5 * 24 * 3600 * 1000).toISOString();
    const fixtures: Array<[string, string, number | null, number]> = [
      ["ac1", "Rank A", 9, 0],
      ["ac2", "Rank B", 7, 0],
      ["ac3", "Rank C", 5, 0],
      ["ac4", "Rank D", 4, 0],
      ["ac5", "Rank E", 3, 0],
      ["ac6", "Rank F", 1, 1], // pre-confirmed low scorer: must be released
      ["ac7", "Rank G", null, 0], // unscored: ranks last, never wins a slot here
    ];
    for (const [id, name, mult, confirmed] of fixtures) {
      mkpillar.run(id, name, "", "", confirmed, "2026-01-01T00:00:00.000Z");
      mkasset.run(`a-${id}`, "x_posts", "x", "t", "", "{}", 0, id, mult, recent);
    }
    const names = autoConfirmTopPillars();
    assert.deepEqual(names, ["Rank A", "Rank B", "Rank C", "Rank D", "Rank E"]);
    const flag = (id: string): number =>
      (db.prepare(`SELECT confirmed FROM pillars WHERE id = ?`).get(id) as { confirmed: number }).confirmed;
    for (const id of ["ac1", "ac2", "ac3", "ac4", "ac5"]) assert.equal(flag(id), 1);
    for (const id of ["ac6", "ac7", "pp1", "pp2"]) assert.equal(flag(id), 0);
    const count = db.prepare(`SELECT COUNT(*) AS n FROM pillars WHERE confirmed = 1`).get() as { n: number };
    assert.equal(count.n, 5);
    // Idempotent: re-ranking changes nothing.
    assert.deepEqual(autoConfirmTopPillars(), names);
  });
});

describe("extended engagement merge", () => {
  it("reads reach/saves keys including bookmarks", () => {
    assert.deepEqual(
      extractEngagement({ reach: 500, saves: 12, views: 1000 }),
      { likes: null, comments: null, shares: null, views: 1000, reach: 500, saves: 12 },
    );
    assert.equal(extractEngagement({ bookmarks: 4 }).saves, 4);
  });

  it("max-merges two readings, nulls never win over data", async () => {
    const { mergeEngagement, engagementEmpty } = await import("../lib/metrics");
    assert.deepEqual(
      mergeEngagement(
        { likes: 100, comments: null, shares: 0, views: 500, reach: null, saves: 3 },
        { likes: 80, comments: 7, shares: 5, views: null, reach: 900, saves: 0 },
      ),
      { likes: 100, comments: 7, shares: 5, views: 500, reach: 900, saves: 3 },
    );
    assert.equal(
      engagementEmpty({ likes: null, comments: 0, shares: null, views: null, reach: 0, saves: null }),
      true,
    );
    assert.equal(
      engagementEmpty({ likes: 1, comments: null, shares: null, views: null, reach: null, saves: null }),
      false,
    );
  });

  it("upsertMetricForAsset merges into the linked row across providers", async () => {
    const { getDb } = await import("../lib/db");
    const { upsertMetricForAsset } = await import("../lib/metrics");
    const db = getDb();
    db.prepare(
      `INSERT INTO assets (id, source, kind, title, transcript, metadata, is_reply, pillar_id, multiplier, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("um1", "zernio_threads", "th", "t", "", "{}", 0, null, null, "2026-01-01T00:00:00.000Z");
    const empty = { likes: null, comments: null, shares: null, views: null, reach: null, saves: null };
    upsertMetricForAsset("um1", "threads", "https://threads.com/p/1", { ...empty, likes: 10 }, { a: 1 });
    upsertMetricForAsset(
      "um1", "threads", "https://threads.com/p/1",
      { ...empty, likes: 4, views: 300, reach: 250 },
      { b: 2 },
    );
    const row = db.prepare(
      `SELECT likes, views, reach, saves FROM post_metrics WHERE asset_id = ?`,
    ).get("um1") as { likes: number; views: number; reach: number; saves: null };
    assert.equal(row.likes, 10);
    assert.equal(row.views, 300);
    assert.equal(row.reach, 250);
    assert.equal(row.saves, null);
    const count = db.prepare(`SELECT COUNT(*) AS n FROM post_metrics WHERE asset_id = ?`).get("um1") as {
      n: number;
    };
    assert.equal(count.n, 1);
  });
});

describe("provider shape tolerance", () => {
  it("coerces pure numeric strings, rejects formatted text", () => {
    assert.deepEqual(
      extractEngagement({ view_count: "1780", like_count: "40", comment_count: "1" }),
      { likes: 40, comments: 1, shares: null, views: 1780, reach: null, saves: null },
    );
    assert.deepEqual(
      extractEngagement({ view_count_text: "1,780 views", likes: "lots" }),
      { likes: null, comments: null, shares: null, views: null, reach: null, saves: null },
    );
  });

  it("attributes {metric: {value}} nests to the parent key", () => {
    assert.deepEqual(
      extractEngagement({
        item_id: "7424931654021582126",
        video_views: { message: { status: 1 }, value: 13356 },
        likes: { value: 655 },
        comments: { value: 7 },
        favorites: { value: 288 },
      }),
      { likes: 655, comments: 7, shares: null, views: 13356, reach: null, saves: 288 },
    );
  });
});

describe("linkedin shapes", () => {
  it("reads reaction counts as likes", () => {
    assert.deepEqual(
      extractEngagement({ reactionCount: 42, commentCount: 5, shareCount: 2 }),
      { likes: 42, comments: 5, shares: 2, views: null, reach: null, saves: null },
    );
  });

  it("maps linkedin sources to the linkedin platform", () => {
    assert.equal(platformForSource("linkedin_posts"), "linkedin");
  });
});

describe("linkedin reactions basis", () => {
  it("scores linkedin on likes while other platforms stay views-only", async () => {
    const { getDb } = await import("../lib/db");
    const { refreshMultipliers } = await import("../lib/metrics");
    const db = getDb();
    const insert = db.prepare(
      `INSERT INTO assets (id, source, kind, title, transcript, metadata, is_reply, pillar_id, multiplier, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const raw = (o: unknown): string => JSON.stringify({ raw: o });
    const recent = new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString();
    insert.run("l1", "linkedin_posts", "li", "t", "", raw({ likes: 10 }), 0, null, null, recent);
    insert.run("l2", "linkedin_posts", "li", "t", "", raw({ likes: 30 }), 0, null, null, recent);
    refreshMultipliers();
    const mult = (id: string): number | null =>
      (db.prepare(`SELECT multiplier FROM assets WHERE id = ?`).get(id) as { multiplier: number | null }).multiplier;
    // Linkedin likes median = 20 → scored; instagram likes-only rows stay NULL.
    assert.equal(mult("l1"), 0.5);
    assert.equal(mult("l2"), 1.5);
    assert.equal(mult("g4"), null);
  });
});
