import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.SQLITE_PATH = join(mkdtempSync(join(tmpdir(), "creagent-draft-")), "test.sqlite");

before(async () => {
  await import("../scripts/migrate");
});

describe("saveDraft", () => {
  it("inserts the draft body and flips the slot orange", async () => {
    const { saveDraft } = await import("../lib/drafting");
    const { getDb, nowIso } = await import("../lib/db");
    const db = getDb();
    const slotId = randomUUID();
    db.prepare(
      `INSERT INTO queue_slots (id, scheduled_at, content_type, platforms, status, brief, created_at)
       VALUES (?, ?, 'short_post', '[]', 'red', '{}', ?)`,
    ).run(slotId, new Date(Date.now() + 3600000).toISOString(), nowIso());
    const draftId = saveDraft(slotId, "short_post", "hello world");
    const draft = db.prepare(`SELECT body, status FROM drafts WHERE id = ?`).get(draftId) as {
      body: string;
      status: string;
    };
    assert.equal(draft.body, "hello world");
    assert.equal(draft.status, "draft");
    const slot = db.prepare(`SELECT status FROM queue_slots WHERE id = ?`).get(slotId) as {
      status: string;
    };
    assert.equal(slot.status, "orange");
  });
});

describe("planner sync", () => {
  it("flows template edits into future red slots only", async () => {
    const { runPlanner } = await import("../lib/planner");
    const { getDb, nowIso } = await import("../lib/db");
    const db = getDb();
    const pillarA = randomUUID();
    const pillarB = randomUUID();
    db.prepare(`INSERT INTO pillars (id, name, created_at) VALUES (?, 'A', ?)`).run(pillarA, nowIso());
    db.prepare(`INSERT INTO pillars (id, name, created_at) VALUES (?, 'B', ?)`).run(pillarB, nowIso());
    const weekday = new Date().getDay();
    const templateId = randomUUID();
    db.prepare(
      `INSERT INTO queue_templates (id, weekday, time, pillar_id, content_type, platforms, created_at)
       VALUES (?, ?, '23:55', ?, 'short_post', '["x"]', ?)`,
    ).run(templateId, weekday, pillarA, nowIso());
    const redId = randomUUID();
    const orangeId = randomUUID();
    const future = new Date(Date.now() + 2 * 3600000).toISOString();
    for (const [id, status] of [
      [redId, "red"],
      [orangeId, "orange"],
    ] as const) {
      db.prepare(
        `INSERT INTO queue_slots (id, scheduled_at, pillar_id, content_type, platforms, status, brief, created_at)
         VALUES (?, ?, ?, 'short_post', '["x"]', ?, ?, ?)`,
      ).run(id, future, pillarA, status, JSON.stringify({ template_id: templateId }), nowIso());
    }
    db.prepare(`UPDATE queue_templates SET pillar_id = ? WHERE id = ?`).run(pillarB, templateId);
    const res = runPlanner(1);
    assert.ok(res.synced >= 1);
    const red = db.prepare(`SELECT pillar_id FROM queue_slots WHERE id = ?`).get(redId) as {
      pillar_id: string;
    };
    assert.equal(red.pillar_id, pillarB);
    const orange = db.prepare(`SELECT pillar_id FROM queue_slots WHERE id = ?`).get(orangeId) as {
      pillar_id: string;
    };
    assert.equal(orange.pillar_id, pillarA);
  });
});
