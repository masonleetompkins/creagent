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
    });
  });

  it("reads tiktok-style plain counters", () => {
    assert.deepEqual(
      extractEngagement({ likes: 5, comments: 2, shares: 1, views: 50 }),
      { likes: 5, comments: 2, shares: 1, views: 50 },
    );
  });

  it("finds counters nested under stats/metrics objects", () => {
    assert.deepEqual(extractEngagement({ stats: { likes: 7 } }), {
      likes: 7,
      comments: null,
      shares: null,
      views: null,
    });
  });

  it("fails closed on garbage: nulls, never guesses", () => {
    assert.deepEqual(extractEngagement({ likes: "lots", views: null }), {
      likes: null,
      comments: null,
      shares: null,
      views: null,
    });
    assert.deepEqual(extractEngagement(null), {
      likes: null,
      comments: null,
      shares: null,
      views: null,
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
    insert.run("m1", "x_posts", "x", "t", "", JSON.stringify({ raw: { likeCount: 100 } }), 0, "pp1", null, recent);
    insert.run("m2", "x_posts", "x", "t", "", JSON.stringify({ raw: { likeCount: 50 } }), 0, "pp1", null, old);
    insert.run("m3", "x_posts", "x", "t", "", JSON.stringify({ raw: { likeCount: 1000 } }), 1, null, null, recent);
    insert.run("m4", "x_posts", "x", "t", "", JSON.stringify({ raw: { note: "no numbers" } }), 0, null, null, recent);
    // Non-reply average = (100 + 50) / 2 = 75.
    assert.equal(refreshMultipliers(), 3);
    const mult = (id: string): number | null =>
      (db.prepare(`SELECT multiplier FROM assets WHERE id = ?`).get(id) as { multiplier: number | null }).multiplier;
    assert.equal(mult("m1"), 1.33);
    assert.equal(mult("m2"), 0.67);
    assert.equal(mult("m3"), 13.33);
    assert.equal(mult("m4"), null);
    const stats = pillarStats();
    assert.deepEqual(stats["pp1"], { posts: 2, recent: 1, multiplier: 1 });
    assert.equal(stats["missing"], undefined);
  });
});
