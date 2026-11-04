import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.SQLITE_PATH = join(mkdtempSync(join(tmpdir(), "creagent-video-v1-")), "test.sqlite");
process.env.UPLOADS_DIR = mkdtempSync(join(tmpdir(), "creagent-vidup-"));

before(async () => {
  await import("../scripts/migrate");
});

function words(text: string, startAt = 0, conf = 0.9) {
  let t = startAt;
  return text.split(" ").map((word) => {
    const w = { word, start_ms: t, end_ms: t + 200, conf };
    t += 300;
    return w;
  });
}

describe("last-take preference", () => {
  it("keeps the last of equal takes", async () => {
    const { detectTakes } = await import("../lib/autocut");
    const first = words("hello world today.", 0, 0.9);
    const second = words("hello world today.", 5000, 0.9);
    const takes = detectTakes([...first, ...second]);
    const verdicts = takes.filter((t) => t.label.startsWith("take")).map((t) => t.verdict);
    assert.deepEqual(verdicts, ["cut", "keep"]);
  });

  it("sends lone fragments to review instead of the timeline", async () => {
    const { detectTakes } = await import("../lib/autocut");
    const full = words("this is the full line here.", 0, 0.9);
    const fragment = words("so basically.", 5000, 0.95);
    const takes = detectTakes([...full, ...fragment]);
    const lines = takes.filter((t) => t.label === "line" || t.label === "fragment");
    assert.deepEqual(lines.map((t) => t.verdict), ["keep", "unsure"]);
    assert.equal(lines[1].label, "fragment");
  });

  it("prefers a complete later take over a gappy earlier one", async () => {
    const { detectTakes } = await import("../lib/autocut");
    const gappy = words("this is the full line huh.", 0, 0.4);
    const clean = words("this is the full line here.", 5000, 0.9);
    const takes = detectTakes([...gappy, ...clean]);
    const pair = takes.filter((t) => t.label.startsWith("take"));
    assert.equal(pair.length, 2);
    assert.deepEqual(pair.map((t) => t.verdict), ["cut", "keep"]);
  });
});

describe("attachExportToSlot", () => {
  it("copies the export file onto the linked slot as video", async () => {
    const { getDb, nowIso } = await import("../lib/db");
    const { attachExportToSlot } = await import("../lib/export");
    const { listAttachments } = await import("../lib/uploads");
    const db = getDb();
    const slotId = randomUUID();
    const projectId = randomUUID();
    const exportId = randomUUID();
    const ts = nowIso();
    db.prepare(
      `INSERT INTO queue_slots (id, scheduled_at, content_type, platforms, status, created_at)
       VALUES (?, ?, 'video_yap', '[]', 'orange', ?)`,
    ).run(slotId, "2026-11-01T09:00:00.000Z", ts);
    db.prepare(
      `INSERT INTO video_projects (id, slot_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
    ).run(projectId, slotId, "v", ts, ts);
    const fake = join(mkdtempSync(join(tmpdir(), "creagent-expfile-")), "out.mp4");
    writeFileSync(fake, Buffer.from([0, 0, 0, 1]));
    db.prepare(
      `INSERT INTO video_exports (id, project_id, path, width, height, fps, captions, created_at)
       VALUES (?, ?, ?, 1080, 1920, 30, 1, ?)`,
    ).run(exportId, projectId, fake, ts);
    const out = await attachExportToSlot(projectId, exportId);
    assert.equal(out.size, 4);
    const attachments = listAttachments(slotId);
    assert.equal(attachments.length, 1);
    assert.equal(attachments[0].kind, "video");
    assert.equal(attachments[0].id, out.attachmentId);
  });

  it("refuses unlinked projects and missing files", async () => {
    const { getDb, nowIso } = await import("../lib/db");
    const { attachExportToSlot } = await import("../lib/export");
    const db = getDb();
    const ts = nowIso();
    const bare = randomUUID();
    db.prepare(
      `INSERT INTO video_projects (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)`,
    ).run(bare, "b", ts, ts);
    await assert.rejects(() => attachExportToSlot(bare, randomUUID()), /not linked/);
    await assert.rejects(() => attachExportToSlot(randomUUID(), randomUUID()), /not found/);
    const slotId = randomUUID();
    const projectId = randomUUID();
    db.prepare(
      `INSERT INTO queue_slots (id, scheduled_at, content_type, platforms, status, created_at)
       VALUES (?, ?, 'video_yap', '[]', 'orange', ?)`,
    ).run(slotId, "2026-11-01T09:00:00.000Z", ts);
    db.prepare(
      `INSERT INTO video_projects (id, slot_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
    ).run(projectId, slotId, "v", ts, ts);
    const exportId = randomUUID();
    db.prepare(
      `INSERT INTO video_exports (id, project_id, path, width, height, fps, captions, created_at)
       VALUES (?, ?, '/nonexistent/out.mp4', 1080, 1920, 30, 1, ?)`,
    ).run(exportId, projectId, ts);
    await assert.rejects(() => attachExportToSlot(projectId, exportId), /gone/);
    await assert.rejects(() => attachExportToSlot(projectId, randomUUID()), /gone/);
  });
});
