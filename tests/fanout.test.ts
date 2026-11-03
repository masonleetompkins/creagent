import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.SQLITE_PATH = join(mkdtempSync(join(tmpdir(), "creagent-fanout-")), "test.sqlite");

before(async () => {
  await import("../scripts/migrate");
});

const CTX = {
  voiceSection: "voice",
  pillarLine: "Pillar: Test",
  pillarVoice: "",
  typeLabel: "Short post",
  platformsLine: "x",
  rulesSection: "",
  fitSection: "",
  vaultContext: "(vault is empty)",
};

describe("buildFanoutPrompts", () => {
  it("fans short_post into 3 angle-differentiated single-post calls", async () => {
    const { buildFanoutPrompts } = await import("../lib/drafting");
    const calls = buildFanoutPrompts("short_post", CTX);
    assert.equal(calls.length, 3);
    assert.deepEqual(calls.map((c) => c.label), ["Contrarian", "Proof", "Curiosity"]);
    assert.ok(calls.every((c) => c.role === "option"));
    // Each prompt carries the shared context plus its own angle.
    assert.ok(calls[0].prompt.includes("Pillar: Test"));
    assert.ok(calls[0].prompt.includes("contrarian"));
    assert.ok(calls[1].prompt.includes("concrete number"));
    assert.ok(calls[2].prompt.includes("curiosity gap"));
    // No call asks for variants or JSON — one post each.
    assert.ok(calls.every((c) => !c.prompt.includes("alternate variants")));
  });

  it("fans thread into 3 hook calls plus a hookless body call", async () => {
    const { buildFanoutPrompts } = await import("../lib/drafting");
    const calls = buildFanoutPrompts("thread", CTX);
    assert.equal(calls.length, 4);
    assert.equal(calls.filter((c) => c.role === "option").length, 3);
    assert.equal(calls.filter((c) => c.role === "body").length, 1);
    assert.ok(calls[3].prompt.includes("do NOT write the hook"));
  });

  it("keeps other types on a single call and threads feedback through", async () => {
    const { buildFanoutPrompts } = await import("../lib/drafting");
    assert.equal(buildFanoutPrompts("carousel", CTX).length, 1);
    const redraft = buildFanoutPrompts("short_post", { ...CTX, previous: "old", feedback: "punchier" });
    assert.equal(redraft.length, 3);
    assert.ok(redraft.every((c) => c.prompt.includes("punchier") && c.prompt.includes("old")));
  });
});

describe("assembleStructure", () => {
  it("assembles full and partial option sets, null when empty", async () => {
    const { assembleStructure } = await import("../lib/drafting");
    const full = assembleStructure(
      "short_post",
      new Map([
        ["variant-0", "A"],
        ["variant-1", "B"],
        ["variant-2", "C"],
      ]),
    );
    assert.equal(full?.structure.layout, "pick-one");
    assert.equal(full?.structure.options.length, 3);
    assert.ok(full?.body.includes("Option 2 (Proof)"));
    const partial = assembleStructure("short_post", new Map([["variant-1", "B"]]));
    assert.equal(partial?.structure.options.length, 1);
    assert.equal(partial?.structure.options[0].label, "Proof");
    assert.equal(assembleStructure("short_post", new Map()), null);
  });

  it("requires thread body plus at least one hook", async () => {
    const { assembleStructure } = await import("../lib/drafting");
    assert.equal(
      assembleStructure("thread", new Map([["hook-0", "H"]])) === null,
      true,
    );
    const ok = assembleStructure(
      "thread",
      new Map([
        ["hook-2", "H"],
        ["thread-body", "2. first\n3. second"],
      ]),
    );
    assert.equal(ok?.structure.layout, "hooks-plus-body");
    assert.equal(ok?.structure.options[0].label, "Curiosity gap");
    assert.ok(ok?.body.includes("Thread:"));
  });

  it("wraps single-call types as prose", async () => {
    const { assembleStructure } = await import("../lib/drafting");
    const ok = assembleStructure("carousel", new Map([["draft", "slides here"]]));
    assert.equal(ok?.structure.layout, "prose");
    assert.equal(ok?.body, "slides here");
    assert.equal(assembleStructure("carousel", new Map()), null);
  });
});

describe("saveDraft structure", () => {
  it("persists structure JSON and flips the slot orange", async () => {
    const { saveDraft } = await import("../lib/drafting");
    const { getDb, nowIso } = await import("../lib/db");
    const db = getDb();
    const slotId = randomUUID();
    db.prepare(
      `INSERT INTO queue_slots (id, scheduled_at, content_type, platforms, status, brief, created_at)
       VALUES (?, ?, 'short_post', '[]', 'red', '{}', ?)`,
    ).run(slotId, new Date(Date.now() + 3600000).toISOString(), nowIso());
    const id = saveDraft(slotId, "short_post", "Option 1 (Contrarian):\nA", {
      layout: "pick-one",
      options: [{ label: "Contrarian", body: "A" }],
    });
    const row = db.prepare(`SELECT structure, selection FROM drafts WHERE id = ?`).get(id) as {
      structure: string;
      selection: string | null;
    };
    assert.equal(JSON.parse(row.structure).layout, "pick-one");
    assert.equal(row.selection, null);
  });
});
