import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.SQLITE_PATH = join(mkdtempSync(join(tmpdir(), "creagent-brain-")), "test.sqlite");

before(async () => {
  await import("../scripts/migrate");
});

describe("brain reads", () => {
  it("returns voice, vault, strategy, and playbook", async () => {
    const brain = await import("../lib/brain");
    const db = await import("../lib/db");
    const conn = db.getDb();
    conn.prepare(
      `INSERT INTO vault_docs (id, doc_type, title, body, created_at) VALUES (?, ?, ?, ?, ?)`,
    ).run("v1", "voice", "Voice profile", "talks fast", db.nowIso());
    conn.prepare(
      `INSERT INTO vault_docs (id, doc_type, title, body, created_at) VALUES (?, ?, ?, ?, ?)`,
    ).run("q1", "quote", null, "ship it", db.nowIso());
    conn.prepare(
      `INSERT INTO pillars (id, name, description, created_at) VALUES (?, ?, ?, ?)`,
    ).run("p1", "Build", "", db.nowIso());
    conn.prepare(
      `INSERT INTO queue_templates (id, weekday, time, pillar_id, content_type, platforms, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run("t1", 1, "09:00", "p1", "short_post", '["x"]', db.nowIso());

    const overview = brain.brainOverview();
    assert.equal(overview.voice?.body, "talks fast");
    assert.equal(overview.counts.voice, 1);
    assert.equal(overview.strategy.length, 1);
    assert.equal(overview.strategy[0].pillar_name, "Build");
    assert.equal(overview.playbook.length, 10);
    assert.ok(overview.playbook.every((p) => p.guide.length > 0));

    assert.equal(brain.listVault("quote").length, 1);
    assert.equal(brain.listVault().length, 2);
    assert.equal(brain.listVault("nope").length, 2);
  });
});
