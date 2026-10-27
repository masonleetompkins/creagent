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
    assert.equal(parsePostedAt({ text: "no date here" }), null);
    assert.equal(parsePostedAt({ created_at: "not a date" }), null);
    assert.equal(parsePostedAt({}), null);
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
