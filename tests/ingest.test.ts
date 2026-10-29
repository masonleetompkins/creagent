import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.SQLITE_PATH = join(mkdtempSync(join(tmpdir(), "creagent-ingest-")), "test.sqlite");

before(async () => {
  await import("../scripts/migrate");
});

describe("parsePostedAt", () => {
  it("parses ISO strings, timestamps, and rejects garbage", async () => {
    const { parsePostedAt } = await import("../lib/ingest");
    assert.equal(parsePostedAt({ created_at: "2026-09-01T12:00:00Z" }), "2026-09-01T12:00:00.000Z");
    assert.equal(
      parsePostedAt({ publishedAt: "Mon Sep 07 10:00:00 +0000 2026" }),
      "2026-09-07T10:00:00.000Z",
    );
    assert.equal(parsePostedAt({ taken_at: 1756725600 }), "2025-09-01T11:20:00.000Z");
    assert.equal(parsePostedAt({ timestamp: 1756725600000 }), "2025-09-01T11:20:00.000Z");
    assert.equal(parsePostedAt({ created_at: "1756725600" }), "2025-09-01T11:20:00.000Z");
    assert.equal(parsePostedAt({ createdUtc: 1790888156 }), "2026-10-01T20:55:56.000Z");
    assert.equal(parsePostedAt({ createdTime: "2026-09-04T18:21:07.000Z" }), "2026-09-04T18:21:07.000Z");
    assert.equal(parsePostedAt({ text: "no date here" }), null);
    assert.equal(parsePostedAt({ created_at: "not a date" }), null);
    assert.equal(parsePostedAt({}), null);
  });
});

describe("normalizeUrl + detectReply + storeAsset", () => {
  it("canonicalizes urls, spots replies, and merges cross-source dupes", async () => {
    const { normalizeUrl, detectReply, storeAsset } = await import("../lib/ingest");
    const { getDb } = await import("../lib/db");
    assert.equal(normalizeUrl("https://x.com/u/status/1?s=20"), "x.com/u/status/1");
    assert.equal(normalizeUrl("https://twitter.com/u/status/1/"), "x.com/u/status/1");
    assert.equal(normalizeUrl("https://m.facebook.com/x/?a=b"), "facebook.com/x");
    assert.equal(normalizeUrl("zernio:x:9"), "zernio:x:9");
    assert.equal(normalizeUrl(""), "");
    assert.equal(detectReply({ referenced_tweets: [{ type: "replied_to" }] }), true);
    assert.equal(detectReply({ in_reply_to_status_id: "123" }), true);
    assert.equal(detectReply({ post_type: "reply" }), true);
    assert.equal(detectReply({ text: "hello", in_reply_to_status_id: null }), false);
    assert.equal(detectReply({ text: "hello" }), false);
    const db = getDb();
    const first = storeAsset(db, {
      source: "x_posts",
      sourceUrl: "https://x.com/u/status/1?s=20",
      title: "hello",
      transcript: "",
      metadata: { runId: "a" },
      postedAt: "2026-01-01T00:00:00.000Z",
      isReply: false,
      isVideo: true,
      transcribedAt: null,
    });
    assert.equal(first, "inserted");
    const second = storeAsset(db, {
      source: "zernio_x",
      sourceUrl: "https://twitter.com/u/status/1/",
      title: "",
      transcript: "hello world",
      metadata: { accountId: "b" },
      postedAt: null,
      isReply: false,
      isVideo: false,
      transcribedAt: "2026-02-02T00:00:00.000Z",
    });
    assert.equal(second, "merged");
    const rows = db.prepare(`SELECT title, transcript, metadata, is_video, transcribed_at FROM assets`).all() as {
      title: string;
      transcript: string;
      metadata: string;
      is_video: number;
      transcribed_at: string | null;
    }[];
    assert.equal(rows.length, 1);
    assert.equal(rows[0].title, "hello");
    assert.equal(rows[0].transcript, "hello world");
    assert.equal(rows[0].is_video, 1);
    assert.equal(rows[0].transcribed_at, "2026-02-02T00:00:00.000Z");
    const meta = JSON.parse(rows[0].metadata) as { sources: string[] };
    assert.deepEqual([...meta.sources].sort(), ["x_posts", "zernio_x"]);
  });
});

describe("runMigrations", () => {
  it("is idempotent and reports nothing newly applied", async () => {
    const { runMigrations } = await import("../scripts/migrate");
    assert.deepEqual(runMigrations(), []);
  });
});

describe("monidPayloadError", () => {
  it("spots silent provider failures and bad handles", async () => {
    const { monidPayloadError } = await import("../lib/ingest");
    assert.equal(
      monidPayloadError({ httpStatus: 502, error: { error: "all providers failed" } }),
      "Monid provider error (HTTP 502: all providers failed)",
    );
    assert.equal(
      monidPayloadError({ found: false, data: null, reason: "not_found" }),
      "handle not found (not_found) — check the spelling",
    );
    assert.equal(monidPayloadError({ data: { posts: [] } }), null);
    assert.equal(monidPayloadError({ httpStatus: 200 }), null);
    assert.equal(monidPayloadError(null), null);
  });
});

describe("video project lib", () => {
  it("creates with the default track stack, lists, and deletes", async () => {
    const video = await import("../lib/video");
    const created = video.createProject({ title: "  spaced  " });
    assert.equal(created.title, "spaced");
    assert.equal(created.width, 1080);
    assert.equal(created.height, 1920);
    const detail = video.getProjectDetail(created.id);
    assert.ok(detail);
    assert.deepEqual(
      detail.tracks.map((t) => t.name),
      ["Subject (keyed)", "Graphics", "Main", "Audio", "Captions", "Review"],
    );
    const listed = video.listProjects().find((p) => p.id === created.id);
    assert.ok(listed);
    assert.equal(listed.track_count, 6);
    assert.equal(video.deleteProject(created.id), true);
    assert.equal(video.getProject(created.id), null);
    assert.equal(video.deleteProject(created.id), false);
  });
});

describe("assets posted_at migration", () => {
  it("exposes posted_at with a historical index", async () => {
    const db = await import("../lib/db");
    const conn = db.getDb();
    const cols = conn
      .prepare(`PRAGMA table_info(assets)`)
      .all() as { name: string }[];
    assert.ok(cols.some((c) => c.name === "posted_at"));
    conn.prepare(
      `INSERT INTO assets (id, source, kind, title, posted_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("post-1", "x_posts", "x_posts", "old post", "2026-08-01T00:00:00.000Z", db.nowIso());
    const row = conn
      .prepare(`SELECT posted_at FROM assets WHERE id = ?`)
      .get("post-1") as { posted_at: string };
    assert.equal(row.posted_at, "2026-08-01T00:00:00.000Z");
  });
});
