import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.SQLITE_PATH = join(mkdtempSync(join(tmpdir(), "creagent-taste-")), "test.sqlite");

before(async () => {
  await import("../scripts/migrate");
});

describe("parseCriticScore", () => {
  it("reads the score line in any casing", async () => {
    const { parseCriticScore } = await import("../lib/taste");
    assert.equal(parseCriticScore("SCORE: 4/5"), 4);
    assert.equal(parseCriticScore("score:2\n\nrewrite"), 2);
    assert.equal(parseCriticScore("  Score: 5 / 5"), 5);
    assert.equal(parseCriticScore("SCORE: 1/5\n\nMuch sharper post"), 1);
  });

  it("returns null when no valid score exists", async () => {
    const { parseCriticScore } = await import("../lib/taste");
    assert.equal(parseCriticScore("this is a fine post"), null);
    assert.equal(parseCriticScore("SCORE: 7/5"), null);
    assert.equal(parseCriticScore(""), null);
  });
});

describe("extractRevision", () => {
  it("returns the rewrite after the score line", async () => {
    const { extractRevision } = await import("../lib/taste");
    assert.equal(extractRevision("SCORE: 2/5\n\nThe sharp rewrite"), "The sharp rewrite");
    assert.equal(
      extractRevision("SCORE: 3/5\n\nLine one\nline two"),
      "Line one\nline two",
    );
  });

  it("returns null for score-only verdicts and scoreless text", async () => {
    const { extractRevision } = await import("../lib/taste");
    assert.equal(extractRevision("SCORE: 5/5"), null);
    assert.equal(extractRevision("SCORE: 2/5\n\n   "), null);
    assert.equal(extractRevision("no score here"), null);
  });
});

describe("buildCriticPrompt", () => {
  it("carries the taste rules, the draft, and the score contract", async () => {
    const { ANTI_SLOP, buildCriticPrompt } = await import("../lib/taste");
    const prompt = buildCriticPrompt("my draft post");
    assert.ok(prompt.includes(ANTI_SLOP));
    assert.ok(prompt.includes("my draft post"));
    assert.ok(prompt.includes("SCORE: n/5"));
  });

  it("pins the required format when a shape note is given", async () => {
    const { buildCriticPrompt } = await import("../lib/taste");
    const prompt = buildCriticPrompt("outline", "FORMAT (preserve exactly): SLIDE markers.");
    assert.ok(prompt.includes("FORMAT (preserve exactly): SLIDE markers."));
    assert.ok(prompt.includes("preserving the required format"));
  });
});

describe("pillarVoiceExemplars", () => {
  it("returns full verbatim winners, platform-preferred", async () => {
    const { getDb } = await import("../lib/db");
    const { nowIso } = await import("../lib/db");
    const { pillarVoiceExemplars } = await import("../lib/taste");
    const db = getDb();
    const pillarId = randomUUID();
    db.prepare(`INSERT INTO pillars (id, name, confirmed, created_at) VALUES (?, 'Voice', 1, ?)`).run(
      pillarId,
      nowIso(),
    );
    const seed = (source: string, title: string, transcript: string, mult: number) => {
      db.prepare(
        `INSERT INTO assets (id, source, title, transcript, created_at, is_reply, pillar_id, multiplier)
         VALUES (?, ?, ?, ?, ?, 0, ?, ?)`,
      ).run(randomUUID(), source, title, transcript, nowIso(), pillarId, mult);
    };
    seed("zernio_tiktok", "tiktok winner", "full tiktok voice here", 3.1);
    seed("zernio_twitter", "x winner", "full x voice here with cadence", 2.4);
    seed("zernio_twitter", "x flop", "flop body", 0.3);
    const out = pillarVoiceExemplars(pillarId, ["x"], 3);
    assert.equal(out.length, 3);
    // Platform-preferred: both x posts lead (multiplier order), then backfill.
    assert.ok(out[0].body.includes("full x voice here with cadence"));
    assert.ok(out[1].body.includes("flop body"));
    assert.ok(out[2].body.includes("full tiktok voice here"));
  });

  it("returns [] without a pillar or winners", async () => {
    const { pillarVoiceExemplars } = await import("../lib/taste");
    assert.deepEqual(pillarVoiceExemplars(null, ["x"]), []);
    assert.deepEqual(pillarVoiceExemplars(randomUUID(), ["x"]), []);
  });

  it("bounds each exemplar so winners can't swallow the prompt", async () => {
    const { getDb, nowIso } = await import("../lib/db");
    const { pillarVoiceExemplars } = await import("../lib/taste");
    const db = getDb();
    const pillarId = randomUUID();
    db.prepare(`INSERT INTO pillars (id, name, confirmed, created_at) VALUES (?, 'Long', 1, ?)`).run(
      pillarId,
      nowIso(),
    );
    db.prepare(
      `INSERT INTO assets (id, source, title, transcript, created_at, is_reply, pillar_id, multiplier)
       VALUES (?, 'zernio_twitter', ?, ?, ?, 0, ?, 2.0)`,
    ).run(randomUUID(), "t", "y".repeat(2000), nowIso(), pillarId);
    const out = pillarVoiceExemplars(pillarId, ["x"], 2, 600);
    assert.equal(out.length, 1);
    assert.ok(out[0].body.length <= 601);
  });
});

describe("buildVoiceExemplarSection", () => {
  it("is empty without a pillar, name, or winners", async () => {
    const { buildVoiceExemplarSection } = await import("../lib/taste");
    assert.equal(buildVoiceExemplarSection(null, "P", ["x"]), "");
    assert.equal(buildVoiceExemplarSection(randomUUID(), null, ["x"]), "");
    assert.equal(buildVoiceExemplarSection(randomUUID(), "P", ["x"]), "");
  });

  it("keeps full winner arcs at the long budget, openings at the tight one", async () => {
    const { getDb, nowIso } = await import("../lib/db");
    const { buildVoiceExemplarSection } = await import("../lib/taste");
    const db = getDb();
    const pillarId = randomUUID();
    db.prepare(`INSERT INTO pillars (id, name, confirmed, created_at) VALUES (?, 'Arc', 1, ?)`).run(
      pillarId,
      nowIso(),
    );
    db.prepare(
      `INSERT INTO assets (id, source, title, transcript, created_at, is_reply, pillar_id, multiplier)
       VALUES (?, 'zernio_twitter', ?, ?, ?, 0, ?, 9.9)`,
    ).run(randomUUID(), "hook", `${"setup ".repeat(150)}BRIDGE-PAYOFF`, nowIso(), pillarId);
    const tight = buildVoiceExemplarSection(pillarId, "Arc", ["x"], 600);
    const full = buildVoiceExemplarSection(pillarId, "Arc", ["x"], 1500);
    assert.ok(!tight.includes("BRIDGE-PAYOFF"));
    assert.ok(full.includes("BRIDGE-PAYOFF"));
  });
});

describe("exemplarBudgetFor", () => {
  it("gives long kinds full arcs, short kinds tight excerpts", async () => {
    const { exemplarBudgetFor } = await import("../lib/taste");
    for (const kind of ["carousel", "video_yap", "long_video", "article_blog", "article_thread"]) {
      assert.equal(exemplarBudgetFor(kind), 1500);
    }
    for (const kind of ["short_post", "thread"]) {
      assert.equal(exemplarBudgetFor(kind), 600);
    }
  });
});

describe("fanout taste wiring", () => {
  it("raises temperature on options only and appends taste rules", async () => {
    const { buildFanoutPrompts, OPTION_TEMPERATURE } = await import("../lib/drafting");
    const { ANTI_SLOP } = await import("../lib/taste");
    const ctx = {
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
      voiceExemplars: "VOICE EXEMPLARS\nverbatim winner",
    };
    const calls = buildFanoutPrompts("short_post", ctx);
    assert.ok(calls.every((c) => c.temperature === OPTION_TEMPERATURE));
    assert.ok(calls.every((c) => c.prompt.includes(ANTI_SLOP)));
    assert.ok(calls[0].prompt.includes("verbatim winner"));
    const thread = buildFanoutPrompts("thread", ctx);
    const hooks = thread.filter((c) => c.role === "option");
    const bodies = thread.filter((c) => c.role === "body");
    assert.ok(hooks.length === 3 && hooks.every((c) => c.temperature === OPTION_TEMPERATURE));
    assert.ok(bodies.length === 1 && bodies[0].temperature === undefined);
    assert.ok(bodies[0].prompt.includes(ANTI_SLOP));
  });
});

describe("runFanout taste pass", () => {
  const calls = [
    { key: "a", label: "A", role: "option" as const, prompt: "PROMPT-A" },
    { key: "b", label: "B", role: "option" as const, prompt: "PROMPT-B" },
  ];

  it("rewrites low scores, keeps high scores", async () => {
    const { runFanout } = await import("../lib/drafting");
    const stub = {
      responses: {
        create: async ({ input }: { input: string }) => {
          if (input.includes("PROMPT-A")) return { output_text: "sloppy original" };
          if (input.includes("PROMPT-B")) return { output_text: "sharp original" };
          if (input.includes("sloppy original")) {
            return { output_text: "SCORE: 2/5\n\nsharp rewrite" };
          }
          return { output_text: "SCORE: 5/5" };
        },
      },
    };
    // @ts-expect-error stub client
    const out = await runFanout(stub, "short_post", calls);
    assert.equal(out.get("a"), "sharp rewrite");
    assert.equal(out.get("b"), "sharp original");
  });

  it("keeps the original on unparseable verdicts, errors, and over-limit rewrites", async () => {
    const { runFanout } = await import("../lib/drafting");
    const stub = {
      responses: {
        create: async ({ input }: { input: string }) => {
          if (input.includes("PROMPT-A")) return { output_text: "original a" };
          if (input.includes("PROMPT-B")) return { output_text: "original b" };
          if (input.includes("original a")) return { output_text: "looks fine, no score" };
          throw new Error("critic down");
        },
      },
    };
    // @ts-expect-error stub client
    const out = await runFanout(stub, "short_post", calls);
    assert.equal(out.get("a"), "original a");
    assert.equal(out.get("b"), "original b");

    const longStub = {
      responses: {
        create: async ({ input }: { input: string }) => {
          if (input.includes("PROMPT-A")) return { output_text: "short original" };
          return { output_text: `SCORE: 1/5\n\n${"z".repeat(500)}` };
        },
      },
    };
    // @ts-expect-error stub client
    const out2 = await runFanout(longStub, "short_post", [calls[0]]);
    assert.equal(out2.get("a"), "short original");
  });

  it("critiques bodies too, without the option cap-drop", async () => {
    const { runFanout } = await import("../lib/drafting");
    let n = 0;
    const stub = {
      responses: {
        create: async ({ input }: { input: string }) => {
          n += 1;
          if (input.includes("DRAFT TO SCORE")) return { output_text: "SCORE: 5/5" };
          return { output_text: "body text" };
        },
      },
    };
    // @ts-expect-error stub client
    const out = await runFanout(stub, "thread", [
      { key: "thread-body", label: "Thread", role: "body" as const, prompt: "P" },
    ]);
    assert.equal(out.get("thread-body"), "body text");
    assert.equal(n, 2); // gen + critic

    const rewriteStub = {
      responses: {
        create: async ({ input }: { input: string }) => {
          if (input.includes("DRAFT TO SCORE")) return { output_text: "SCORE: 2/5\n\nsharper body" };
          return { output_text: "flat body" };
        },
      },
    };
    // @ts-expect-error stub client
    const out2 = await runFanout(rewriteStub, "article_blog", [
      { key: "draft", label: "Draft", role: "body" as const, prompt: "P" },
    ]);
    assert.equal(out2.get("draft"), "sharper body");
  });

  it("retries plain when the endpoint rejects temperature", async () => {
    const { runFanout } = await import("../lib/drafting");
    const seen: Array<number | undefined> = [];
    const stub = {
      responses: {
        create: async (params: { input: string; temperature?: number }) => {
          seen.push(params.temperature);
          if (params.temperature !== undefined) throw new Error("unsupported parameter");
          if (params.input.includes("DRAFT TO SCORE")) return { output_text: "SCORE: 5/5" };
          return { output_text: "plain draft" };
        },
      },
    };
    // @ts-expect-error stub client
    const out = await runFanout(stub, "short_post", [
      { key: "a", label: "A", role: "option" as const, prompt: "P", temperature: 1.2 },
    ]);
    assert.equal(out.get("a"), "plain draft");
    assert.ok(seen.includes(1.2));
    assert.ok(seen.includes(undefined));
  });
});
