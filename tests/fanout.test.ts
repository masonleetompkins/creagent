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
  it("carries the assigned idea, audience, and freshness list", async () => {
    const { buildFanoutPrompts } = await import("../lib/drafting");
    const calls = buildFanoutPrompts("short_post", {
      ...CTX,
      ideaSection: "ASSIGNED IDEA:\nHooks are promises.",
      audienceSection: "TARGET READER:\nBuilders.",
      freshnessSection: "ALREADY COVERED:\n- hooks",
    });
    assert.ok(calls.every((c) => c.prompt.includes("ASSIGNED IDEA")));
    assert.ok(calls.every((c) => c.prompt.includes("TARGET READER")));
    assert.ok(calls.every((c) => c.prompt.includes("ALREADY COVERED")));
    // The assignment leads — it must win over generic instincts.
    assert.ok(calls[0].prompt.indexOf("ASSIGNED IDEA") < calls[0].prompt.indexOf("Pillar: Test"));
  });

  it("injects the brain dump at the top of every call", async () => {
    const { buildFanoutPrompts, formatBrainDump } = await import("../lib/drafting");
    const calls = buildFanoutPrompts("short_post", {
      ...CTX,
      dumpSection: formatBrainDump("Ship the demo today."),
    });
    assert.ok(calls.every((c) => c.prompt.includes("FRESH BRAIN DUMP")));
    assert.ok(calls.every((c) => c.prompt.includes("Ship the demo today.")));
    assert.ok(
      calls.every(
        (c) => c.prompt.indexOf("BRAIN DUMP") < c.prompt.indexOf("VAULT CONTEXT"),
      ),
    );
    const plain = buildFanoutPrompts("short_post", CTX);
    assert.ok(plain.every((c) => !c.prompt.includes("BRAIN DUMP")));
  });

  it("instructs carousel flow: one story, bridges, no disconnected slides", async () => {
    const { buildFanoutPrompts } = await import("../lib/drafting");
    const calls = buildFanoutPrompts("carousel", CTX);
    assert.equal(calls.length, 1);
    const prompt = calls[0].prompt;
    assert.ok(prompt.includes("ONE continuous story"));
    assert.ok(prompt.includes("SLIDE 1..7"));
    assert.ok(prompt.includes("because / so / then / now / but"));
    assert.ok(prompt.includes("name-the-concept bridge"));
    assert.ok(prompt.includes("disconnected slides"));
  });

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

  it("treats article_thread exactly like thread", async () => {
    const { assembleStructure, buildFanoutPrompts } = await import("../lib/drafting");
    const calls = buildFanoutPrompts("article_thread", CTX);
    assert.deepEqual(calls.map((c) => c.key), ["hook-0", "hook-1", "hook-2", "thread-body"]);
    assert.ok(calls[3].prompt.includes("10-14 posts"));
    const ok = assembleStructure(
      "article_thread",
      new Map([
        ["hook-0", "H"],
        ["thread-body", "1/ first"],
      ]),
    );
    assert.equal(ok?.structure.layout, "hooks-plus-body");
    assert.equal(
      assembleStructure("article_thread", new Map([["hook-0", "H"]])) === null,
      true,
    );
  });
});

describe("craftBlock", () => {
  it("covers X and Threads short forms only", async () => {
    const { craftBlock } = await import("../lib/social-craft");
    assert.match(craftBlock(["x"], "short_post"), /Replies rule/);
    assert.match(craftBlock(["x"], "thread"), /Replies rule/);
    assert.match(craftBlock(["x"], "article_thread"), /Replies rule/);
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
    assert.equal(n, 2); // gen + taste-pass critic (scoreless verdict keeps the original)
  });
});

describe("firstOverlongPost", () => {
  it("finds the first post over the cap, null when all fit", async () => {
    const { firstOverlongPost } = await import("../lib/drafting");
    assert.equal(firstOverlongPost("short\n\nfits", 280), null);
    assert.deepEqual(firstOverlongPost(`ok\n\n${"x".repeat(300)}`, 280), { index: 1, over: 20 });
    assert.deepEqual(firstOverlongPost("👇".repeat(281), 280), { index: 0, over: 1 });
  });
});

describe("runFanout thread-body repair", () => {
  it("rewrites the body when a post runs over, keeps it when still over", async () => {
    const { runFanout } = await import("../lib/drafting");
    const seen: string[] = [];
    const stub = {
      responses: {
        create: async ({ input }: { input: string }) => {
          seen.push(input);
          if (input.includes("DRAFT TO SCORE")) return { output_text: "SCORE: 5/5" };
          if (input.includes("Post 2 was")) return { output_text: "fine\n\nfixed" };
          return { output_text: `fine\n\n${"x".repeat(300)}` };
        },
      },
    };
    // @ts-expect-error stub client
    const out = await runFanout(stub, "thread", [
      { key: "thread-body", label: "Thread", role: "body" as const, prompt: "P" },
    ]);
    assert.equal(out.get("thread-body"), "fine\n\nfixed");
    assert.ok(seen.some((s) => s.includes("Post 2 was 20 characters over")));

    const stubborn = {
      responses: {
        create: async ({ input }: { input: string }) => {
          if (input.includes("DRAFT TO SCORE")) return { output_text: "SCORE: 5/5" };
          return { output_text: `fine\n\n${"y".repeat(300)}` };
        },
      },
    };
    // @ts-expect-error stub client
    const out2 = await runFanout(stubborn, "thread", [
      { key: "thread-body", label: "Thread", role: "body" as const, prompt: "P" },
    ]);
    assert.ok((out2.get("thread-body") ?? "").includes("yyy"));
  });
});

describe("playbook architectures", () => {
  it("gives every kind connective flow, not disconnected parts", async () => {
    const { PLAYBOOK } = await import("../lib/content");
    for (const kind of ["thread", "article_thread"]) {
      assert.ok(PLAYBOOK[kind].includes("connected to the previous"));
      assert.ok(PLAYBOOK[kind].includes("1/ 2/"));
    }
    assert.ok(PLAYBOOK["video_trend"].includes("open loop"));
    assert.ok(PLAYBOOK["video_yap"].includes("weakest-to-strongest"));
    assert.ok(PLAYBOOK["article_blog"].includes("Cold open") && PLAYBOOK["article_blog"].includes("Thesis"));
    assert.ok(PLAYBOOK["long_video"].includes("micro-hook"));
    assert.ok(PLAYBOOK["clip"].includes("IN/OUT"));
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

describe("scoped draft edits", () => {
  async function seed(structure: unknown): Promise<string> {
    const { saveDraft } = await import("../lib/drafting");
    const { getDb, nowIso } = await import("../lib/db");
    const db = getDb();
    const slotId = randomUUID();
    db.prepare(
      `INSERT INTO queue_slots (id, scheduled_at, content_type, platforms, status, brief, created_at)
       VALUES (?, ?, 'short_post', '[]', 'red', '{}', ?)`,
    ).run(slotId, new Date(Date.now() + 3600000).toISOString(), nowIso());
    return saveDraft(
      slotId,
      "short_post",
      "seed",
      structure as { layout: "pick-one"; options: Array<{ label: string; body: string }> },
    );
  }

  it("updates one option, keeps the rest and the layout", async () => {
    const { updateDraftOption } = await import("../lib/drafting");
    const { getDb } = await import("../lib/db");
    const id = await seed({
      layout: "pick-one",
      options: [
        { label: "A", body: "first" },
        { label: "B", body: "second" },
      ],
    });
    updateDraftOption(id, 1, "  second, sharper  ");
    const row = getDb()
      .prepare(`SELECT body, structure, status FROM drafts WHERE id = ?`)
      .get(id) as { body: string; structure: string; status: string };
    const parsed = JSON.parse(row.structure) as { layout: string; options: Array<{ body: string }> };
    assert.equal(parsed.layout, "pick-one");
    assert.equal(parsed.options[0].body, "first");
    assert.equal(parsed.options[1].body, "second, sharper");
    assert.ok(row.body.includes("second, sharper"));
    assert.equal(row.status, "edited");
  });

  it("rejects bad indexes and missing drafts", async () => {
    const { updateDraftOption } = await import("../lib/drafting");
    const id = await seed({ layout: "pick-one", options: [{ label: "A", body: "first" }] });
    assert.throws(() => updateDraftOption(id, 3, "x"), /that option is gone/);
    assert.throws(() => updateDraftOption(id, 0, "   "), /edited text is empty/);
    assert.throws(() => updateDraftOption(randomUUID(), 0, "x"), /draft not found/);
  });

  it("updates the thread body, keeps the hooks", async () => {
    const { updateDraftThreadBody } = await import("../lib/drafting");
    const { getDb } = await import("../lib/db");
    const id = await seed({
      layout: "hooks-plus-body",
      options: [{ label: "H1", body: "hook" }],
      body: "1/ Old.",
    });
    updateDraftThreadBody(id, "1/ New.\n\n2/ More.");
    const row = getDb()
      .prepare(`SELECT body, structure FROM drafts WHERE id = ?`)
      .get(id) as { body: string; structure: string };
    const parsed = JSON.parse(row.structure) as { body: string; options: Array<{ body: string }> };
    assert.equal(parsed.options[0].body, "hook");
    assert.equal(parsed.body, "1/ New.\n\n2/ More.");
    assert.ok(row.body.includes("2/ More."));
  });

  it("rebuildBody mirrors the assemble formats", async () => {
    const { rebuildBody } = await import("../lib/drafting");
    assert.equal(
      rebuildBody({ layout: "pick-one", options: [{ label: "A", body: "x" }] }),
      "Option 1 (A):\nx",
    );
    assert.equal(
      rebuildBody({ layout: "prose", options: [{ label: "D", body: "solo" }] }),
      "solo",
    );
  });
});
