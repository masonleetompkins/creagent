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
  platforms: ["x"],
  platformsLine: "x",
  rulesSection: "",
  fitSection: "",
  pillarSection: "",
  newsSection: "",
  newsy: false,
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
    // Single-post scope overrides thread-heavy platform guides.
    assert.ok(calls.every((c) => c.prompt.includes("ONE standalone post")));
    assert.ok(calls.every((c) => c.prompt.includes("ignore all thread advice")));
    // Ranked craft rules ride along for X.
    assert.ok(calls.every((c) => c.prompt.includes("POST CRAFT")));
    assert.ok(calls.every((c) => c.prompt.includes("Replies rule")));
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

describe("craftBlock", () => {
  it("covers X and Threads short forms only", async () => {
    const { craftBlock } = await import("../lib/social-craft");
    assert.match(craftBlock(["x"], "short_post"), /Replies rule/);
    assert.match(craftBlock(["x"], "thread"), /Replies rule/);
    assert.match(craftBlock(["threads"], "short_post"), /poignant idea/);
    assert.equal(craftBlock(["linkedin"], "short_post"), "");
    assert.equal(craftBlock(["x"], "carousel"), "");
    assert.equal(craftBlock([], "short_post"), "");
  });
});

describe("voiceFraming", () => {
  it("composes weak-fit and pillar-format exceptions", async () => {
    const { voiceFraming } = await import("../lib/drafting");
    assert.equal(voiceFraming(false, false), "VOICE PROFILE (match every rule below exactly)");
    assert.match(voiceFraming(true, false), /WEAK FIT/);
    assert.match(voiceFraming(false, true), /pillar's format wins/);
    const both = voiceFraming(true, true);
    assert.ok(both.includes("WEAK FIT") && both.includes("pillar's format wins"));
  });
});

describe("refineTarget + buildRefinePrompt", () => {
  it("targets the picked option and carries thread bodies", async () => {
    const { refineTarget, buildRefinePrompt } = await import("../lib/drafting");
    const t = refineTarget(
      "short_post",
      "joined",
      JSON.stringify({
        layout: "pick-one",
        options: [
          { label: "Contrarian", body: "AAA" },
          { label: "Proof", body: "BBB" },
        ],
      }),
      "1",
    );
    assert.equal(t.text, "BBB");
    assert.equal(t.label, "Proof");
    assert.equal(t.layout, "pick-one");
    const h = refineTarget(
      "thread",
      "joined",
      JSON.stringify({
        layout: "hooks-plus-body",
        options: [{ label: "Bold claim", body: "HOOK" }],
        body: "2. post two",
      }),
      "5",
    );
    assert.equal(h.text, "HOOK");
    assert.equal(h.threadBody, "2. post two");
    // Legacy/edited drafts without structure refine whole-body.
    const legacy = refineTarget("short_post", "plain old draft", null, null);
    assert.equal(legacy.text, "plain old draft");
    assert.equal(legacy.layout, "prose");
    const broken = refineTarget("short_post", "fallback", "{oops", "0");
    assert.equal(broken.text, "fallback");
  });

  it("builds single-piece prompts with feedback and news context", async () => {
    const { buildRefinePrompt } = await import("../lib/drafting");
    const prompt = buildRefinePrompt(
      "short_post",
      { ...CTX, previous: "old", feedback: "more specific facts" },
      { text: "PIECE", label: "Proof", layout: "pick-one" },
    );
    assert.ok(prompt.includes("more specific facts"));
    assert.ok(prompt.includes("PIECE TO REVISE"));
    assert.ok(prompt.includes("PIECE"));
    assert.ok(prompt.includes("Output only the revised piece"));
    assert.ok(!prompt.includes("alternate variants"));
  });
});

describe("runFanout news retry", () => {
  it("retries digit-less news options once, keeps originals otherwise", async () => {
    const { runFanout } = await import("../lib/drafting");
    const seen: string[] = [];
    const stub = {
      responses: {
        create: async ({ input }: { input: string }) => {
          seen.push(input);
          if (input.includes("Too vague")) return { output_text: "Model X costs $5 — verified digit" };
          if (input.includes("PROMPT-A")) return { output_text: "vague post with no facts" };
          return { output_text: "post with 3 facts" };
        },
      },
    };
    const calls = [
      { key: "a", label: "A", role: "option" as const, prompt: "PROMPT-A" },
      { key: "b", label: "B", role: "option" as const, prompt: "PROMPT-B" },
    ];
    // @ts-expect-error stub client
    const out = await runFanout(stub, "short_post", calls, true);
    assert.match(out.get("a") ?? "", /verified digit/);
    assert.equal(out.get("b"), "post with 3 facts");
    assert.ok(seen.some((s) => s.includes("Too vague")));
  });

  it("skips the retry for non-news drafts", async () => {
    const { runFanout } = await import("../lib/drafting");
    let n = 0;
    const stub = {
      responses: { create: async () => ({ output_text: `vague ${++n}` }) },
    };
    // @ts-expect-error stub client
    const out = await runFanout(stub, "short_post", [
      { key: "a", label: "A", role: "option" as const, prompt: "P" },
    ]);
    assert.equal(out.get("a"), "vague 1");
    assert.equal(n, 1);
  });
});

describe("overLimit", () => {
  it("counts code points against the kind limit", async () => {
    const { overLimit } = await import("../lib/drafting");
    assert.equal(overLimit("short_post", "x".repeat(280)), 0);
    assert.equal(overLimit("short_post", "x".repeat(281)), 1);
    assert.equal(overLimit("short_post", "👇".repeat(280)), 0);
    assert.equal(overLimit("short_post", "👇".repeat(281)), 1);
    assert.equal(overLimit("carousel", "x".repeat(5000)), 0);
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
