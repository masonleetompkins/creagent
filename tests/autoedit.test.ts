import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.SQLITE_PATH = join(mkdtempSync(join(tmpdir(), "creagent-autoedit-")), "test.sqlite");

before(async () => {
  await import("../scripts/migrate");
});

describe("slot auto-edit guards", () => {
  it("rejects missing, non-video, and footage-less slots", async () => {
    const { runSlotAutoEdit } = await import("../lib/autoedit");
    const db = await import("../lib/db");
    const conn = db.getDb();
    await assert.rejects(() => runSlotAutoEdit("missing"), /slot not found/);
    conn.prepare(
      `INSERT INTO queue_slots (id, scheduled_at, content_type, status, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run("s1", db.nowIso(), "short_post", "red", db.nowIso());
    await assert.rejects(() => runSlotAutoEdit("s1"), /needs a video slot/);
    conn.prepare(
      `INSERT INTO queue_slots (id, scheduled_at, content_type, status, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run("s2", db.nowIso(), "video_yap", "red", db.nowIso());
    await assert.rejects(() => runSlotAutoEdit("s2"), /attach footage/);
  });
});
