import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.SQLITE_PATH = join(mkdtempSync(join(tmpdir(), "creagent-feedback-")), "test.sqlite");

before(async () => {
  await import("../scripts/migrate");
});

describe("draft_feedback", () => {
  it("saves raw feedback linked to draft and slot", async () => {
    const { saveFeedback } = await import("../lib/feedback");
    const { getDb, nowIso } = await import("../lib/db");
    const db = getDb();
    const slotId = randomUUID();
    db.prepare(
      `INSERT INTO queue_slots (id, scheduled_at, content_type, platforms, status, brief, created_at)
       VALUES (?, ?, 'short_post', '[]', 'orange', '{}', ?)`,
    ).run(slotId, new Date(Date.now() + 3600000).toISOString(), nowIso());
    const draftId = randomUUID();
    db.prepare(
      `INSERT INTO drafts (id, slot_id, kind, body, status, created_at)
       VALUES (?, ?, 'short_post', 'first try', 'draft', ?)`,
    ).run(draftId, slotId, nowIso());
    const id = saveFeedback(slotId, draftId, "  punchier hook  ");
    const row = db.prepare(`SELECT draft_id, slot_id, body FROM draft_feedback WHERE id = ?`).get(id) as {
      draft_id: string;
      slot_id: string;
      body: string;
    };
    assert.equal(row.draft_id, draftId);
    assert.equal(row.slot_id, slotId);
    assert.equal(row.body, "punchier hook");
  });
});

describe("style_rules", () => {
  it("upsertRules dedupes on normalized text and bumps uses", async () => {
    const { upsertRules } = await import("../lib/feedback");
    const { getDb } = await import("../lib/db");
    const db = getDb();
    assert.equal(upsertRules(null, null, ["No emojis in hooks."]), 1);
    assert.equal(upsertRules(null, null, ["  NO  emojis in HOOKS. "]), 0);
    // Case/whitespace variants dedupe; one row total.
    const n = (
      db.prepare(`SELECT COUNT(*) AS n FROM style_rules WHERE rule = 'No emojis in hooks.'`).get() as {
        n: number;
      }
    ).n;
    assert.equal(n, 1);
  });

  it("parseRulesJson tolerates fenced and prose-wrapped output", async () => {
    const { parseRulesJson } = await import("../lib/feedback");
    assert.deepEqual(parseRulesJson(`{"rules": ["Never open with a question."]}`), [
      "Never open with a question.",
    ]);
    assert.deepEqual(parseRulesJson(`Here you go:\n\`\`\`json\n{"rules": ["Keep hooks under 10 words."]}\n\`\`\`\nDone.`), [
      "Keep hooks under 10 words.",
    ]);
    assert.deepEqual(parseRulesJson(`{"rules": []}`), []);
    assert.deepEqual(parseRulesJson(`not json at all`), []);
  });

  it("rulesFor prefers scoped rules over global", async () => {
    const { upsertRules, rulesFor } = await import("../lib/feedback");
    upsertRules(null, null, ["Always end with a question?"]);
    upsertRules(null, "thread", ["Keep threads under 5 posts."]);
    upsertRules(null, "video", ["Vertical video needs captions."]);
    const rules = rulesFor(null, "thread", 5).map((r) => r.rule);
    assert.ok(rules.includes("Keep threads under 5 posts."));
    assert.ok(rules.includes("Always end with a question?"));
    assert.ok(!rules.includes("Vertical video needs captions."));
    // Exact-scope rules sort before global ones.
    assert.ok(rules.indexOf("Keep threads under 5 posts.") < rules.indexOf("Always end with a question?"));
  });
});
