import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { approvedBody, clampSelection, parseStructure, splitLegacyOptions } from "../lib/draft-structure";

process.env.SQLITE_PATH = join(mkdtempSync(join(tmpdir(), "creagent-approval-")), "test.sqlite");

before(async () => {
  await import("../scripts/migrate");
});

describe("parseStructure", () => {
  it("accepts valid structures and rejects garbage", () => {
    assert.equal(parseStructure(null), null);
    assert.equal(parseStructure(""), null);
    assert.equal(parseStructure("{nope"), null);
    assert.equal(parseStructure(JSON.stringify({ layout: "pick-one", options: [] })), null);
    const ok = parseStructure(
      JSON.stringify({
        layout: "hooks-plus-body",
        options: [{ label: "Bold claim", body: "H" }],
        body: "2. post",
      }),
    );
    assert.equal(ok?.layout, "hooks-plus-body");
    assert.equal(ok?.options[0].label, "Bold claim");
    // Unknown layouts and missing labels degrade, never crash.
    const weird = parseStructure(JSON.stringify({ layout: "zzz", options: [{ body: "B" }] }));
    assert.equal(weird?.layout, "prose");
    assert.equal(weird?.options[0].label, "Option");
  });
});

describe("splitLegacyOptions", () => {
  it("splits Variant/Option soup into cards", () => {
    const split = splitLegacyOptions("Variant 1:\nFirst post here\n\n---\n\nVariant 2:\nSecond post here");
    assert.equal(split?.length, 2);
    assert.equal(split?.[0].body, "First post here");
    assert.equal(split?.[1].label, "Option 2");
    assert.equal(splitLegacyOptions("Just one plain post."), null);
    assert.equal(splitLegacyOptions("Option 1 (Contrarian):\nOnly one"), null);
  });
});

describe("clampSelection + approvedBody", () => {
  it("clamps persisted picks and composes hook+thread heroes", () => {
    assert.equal(clampSelection("1", 3), 1);
    assert.equal(clampSelection("9", 3), 2);
    assert.equal(clampSelection(null, 3), 0);
    assert.equal(clampSelection("junk", 2), 0);
    const hook = approvedBody(
      {
        body: "joined",
        structure: JSON.stringify({
          layout: "hooks-plus-body",
          options: [{ label: "Bold claim", body: "HOOK" }],
          body: "2. post two",
        }),
      },
      0,
    );
    assert.equal(hook, "HOOK\n\n2. post two");
    const pick = approvedBody(
      {
        body: "joined",
        structure: JSON.stringify({
          layout: "pick-one",
          options: [
            { label: "A", body: "AAA" },
            { label: "B", body: "BBB" },
          ],
        }),
      },
      1,
    );
    assert.equal(pick, "BBB");
    assert.equal(approvedBody({ body: "plain", structure: null }, 0), "plain");
  });
});

describe("resolveApproval", () => {
  it("pins the latest version's pick", async () => {
    const { resolveApproval, pinApproval, clearApproval } = await import("../lib/draft-approval");
    const { getDb, nowIso } = await import("../lib/db");
    const db = getDb();
    const slotId = randomUUID();
    db.prepare(
      `INSERT INTO queue_slots (id, scheduled_at, content_type, platforms, status, brief, created_at)
       VALUES (?, ?, 'short_post', '[]', 'orange', '{}', ?)`,
    ).run(slotId, new Date(Date.now() + 3600000).toISOString(), nowIso());
    const struct = JSON.stringify({
      layout: "pick-one",
      options: [
        { label: "A", body: "AAA" },
        { label: "B", body: "BBB" },
      ],
    });
    const d1 = randomUUID();
    db.prepare(
      `INSERT INTO drafts (id, slot_id, kind, body, status, structure, selection, created_at)
       VALUES (?, ?, 'short_post', 'v1', 'draft', ?, '0', ?)`,
    ).run(d1, slotId, struct, nowIso());
    const d2 = randomUUID();
    db.prepare(
      `INSERT INTO drafts (id, slot_id, kind, body, status, structure, selection, created_at)
       VALUES (?, ?, 'short_post', 'v2', 'draft', ?, '1', ?)`,
    ).run(d2, slotId, struct, new Date(Date.now() + 1000).toISOString());
    assert.deepEqual(resolveApproval(slotId), { draftId: d2, optionIndex: 1 });
    pinApproval(slotId);
    const pinned = db
      .prepare(`SELECT approved_draft_id, approved_option FROM queue_slots WHERE id = ?`)
      .get(slotId) as { approved_draft_id: string; approved_option: number };
    assert.equal(pinned.approved_draft_id, d2);
    assert.equal(pinned.approved_option, 1);
    clearApproval(slotId);
    const cleared = db
      .prepare(`SELECT approved_draft_id, approved_option FROM queue_slots WHERE id = ?`)
      .get(slotId) as { approved_draft_id: string | null; approved_option: number | null };
    assert.equal(cleared.approved_draft_id, null);
    assert.equal(cleared.approved_option, null);
    assert.equal(resolveApproval(randomUUID()), null);
  });
});
