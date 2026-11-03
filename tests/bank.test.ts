import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.SQLITE_PATH = join(mkdtempSync(join(tmpdir(), "creagent-bank-")), "test.sqlite");

before(async () => {
  await import("../scripts/migrate");
});

const DAY = 24 * 3600 * 1000;
const T0 = Date.parse("2026-11-10T09:00:00.000Z");

function slot(id: string, at: number, pillar: string | null, type = "short_post") {
  return {
    id,
    scheduled_at: new Date(at).toISOString(),
    pillar_id: pillar,
    content_type: type,
    platforms: '["x"]',
  };
}

describe("planBankFill", () => {
  it("spaces placements 72h+ apart and prefers pillar matches", async () => {
    const { planBankFill } = await import("../lib/bank");
    const pillarA = randomUUID();
    const banked = [
      { id: "b1", pillar_id: pillarA, content_type: "short_post", platforms: '["x"]' },
      { id: "b2", pillar_id: pillarA, content_type: "short_post", platforms: '["x"]' },
      { id: "b3", pillar_id: null, content_type: "short_post", platforms: '["x"]' },
    ];
    const slots = [
      slot("s1", T0, pillarA),
      slot("s2", T0 + DAY, pillarA),
      slot("s3", T0 + 7 * DAY, randomUUID()),
      slot("s4", T0 + 4 * DAY, pillarA),
      slot("s5", T0 + 5 * DAY, pillarA, "thread"),
    ];
    const plan = planBankFill(banked, slots);
    // b1 -> s1 (earliest pillar match); b2 skips s2 (24h gap) for s4 (96h);
    // b3 (no pillar) takes s3 — 72h+ from both; thread slot never matches.
    assert.deepEqual(plan, [
      { bankId: "b1", slotId: "s1" },
      { bankId: "b2", slotId: "s4" },
      { bankId: "b3", slotId: "s3" },
    ]);
  });

  it("skips items with no eligible slot", async () => {
    const { planBankFill } = await import("../lib/bank");
    const plan = planBankFill(
      [{ id: "b1", pillar_id: null, content_type: "carousel", platforms: "[]" }],
      [slot("s1", T0, null)],
    );
    assert.deepEqual(plan, []);
  });
});

describe("bankOption + fillBanked", () => {
  it("banks an option and places it into a later red slot", async () => {
    const { bankOption, fillBanked, bankedCount } = await import("../lib/bank");
    const { getDb, nowIso } = await import("../lib/db");
    const db = getDb();
    const pillar = randomUUID();
    db.prepare(`INSERT INTO pillars (id, name, created_at) VALUES (?, 'P', ?)`).run(pillar, nowIso());
    const mkSlot = (at: number) => {
      const id = randomUUID();
      db.prepare(
        `INSERT INTO queue_slots (id, scheduled_at, pillar_id, content_type, platforms, status, brief, created_at)
         VALUES (?, ?, ?, 'short_post', '["x"]', 'red', '{}', ?)`,
      ).run(id, new Date(at).toISOString(), pillar, nowIso());
      return id;
    };
    const src = mkSlot(T0);
    const dst = mkSlot(T0 + 4 * DAY);
    const draftId = randomUUID();
    db.prepare(
      `INSERT INTO drafts (id, slot_id, kind, body, status, structure, created_at)
       VALUES (?, ?, 'short_post', 'joined', 'draft', ?, ?)`,
    ).run(
      draftId,
      src,
      JSON.stringify({
        layout: "pick-one",
        options: [
          { label: "Contrarian", body: "winner" },
          { label: "Proof", body: "runner-up" },
        ],
      }),
      nowIso(),
    );
    const bankId = bankOption(draftId, 1);
    assert.equal(bankedCount(), 1);
    // Idempotent re-bank returns the same row.
    assert.equal(bankOption(draftId, 1), bankId);
    assert.equal(bankedCount(), 1);
    const res = fillBanked();
    assert.deepEqual(res, { placed: 1, skipped: 0 });
    assert.equal(bankedCount(), 0);
    const draft = db
      .prepare(`SELECT body, status FROM drafts WHERE slot_id = ?`)
      .get(dst) as { body: string; status: string };
    assert.equal(draft.body, "runner-up");
    const slot = db.prepare(`SELECT status FROM queue_slots WHERE id = ?`).get(dst) as {
      status: string;
    };
    assert.equal(slot.status, "orange");
    const row = db.prepare(`SELECT status, placed_slot_id FROM option_bank WHERE id = ?`).get(bankId) as {
      status: string;
      placed_slot_id: string;
    };
    assert.equal(row.status, "placed");
    assert.equal(row.placed_slot_id, dst);
  });

  it("rejects missing drafts and options", async () => {
    const { bankOption } = await import("../lib/bank");
    assert.throws(() => bankOption(randomUUID(), 0), /draft not found/);
  });
});
