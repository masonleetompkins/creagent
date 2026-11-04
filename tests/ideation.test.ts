import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.SQLITE_PATH = join(mkdtempSync(join(tmpdir(), "creagent-ideation-")), "test.sqlite");

before(async () => {
  await import("../scripts/migrate");
});

describe("recentDraftTopics", () => {
  async function seed(slotAgeDays: number, body: string, pillarId: string | null): Promise<string> {
    const { getDb } = await import("../lib/db");
    const db = getDb();
    const slotId = randomUUID();
    const at = new Date().toISOString();
    db.prepare(
      `INSERT INTO queue_slots (id, scheduled_at, content_type, platforms, status, brief, created_at, pillar_id)
       VALUES (?, ?, 'short_post', '[]', 'orange', '{}', ?, ?)`,
    ).run(slotId, at, at, pillarId);
    db.prepare(
      `INSERT INTO drafts (id, slot_id, kind, body, status, created_at)
       VALUES (?, ?, 'short_post', ?, 'draft', ?)`,
    ).run(randomUUID(), slotId, body, new Date(Date.now() - slotAgeDays * 86400000).toISOString());
    return slotId;
  }

  it("returns recent excerpts newest-first, excluding the given slot", async () => {
    const { getDb, nowIso } = await import("../lib/db");
    const { recentDraftTopics } = await import("../lib/ideation");
    const db = getDb();
    const pillarId = randomUUID();
    db.prepare(`INSERT INTO pillars (id, name, confirmed, created_at) VALUES (?, 'Tools', 1, ?)`).run(
      pillarId,
      nowIso(),
    );
    const mine = await seed(1, "my current versions stay on topic", pillarId);
    await seed(2, "-carousel about hooks that convert, with examples ".padEnd(200, "x"), pillarId);
    await seed(30, "ancient history, outside the window", pillarId);
    const topics = recentDraftTopics(mine);
    assert.equal(topics.length, 1);
    assert.equal(topics[0].pillar, "Tools");
    assert.ok(topics[0].excerpt.length <= 160);
    assert.ok(topics[0].excerpt.includes("carousel about hooks"));
  });
});

describe("buildFreshnessSection", () => {
  it("lists covered topics, empty when none", async () => {
    const { buildFreshnessSection } = await import("../lib/ideation");
    assert.equal(buildFreshnessSection([]), "");
    const out = buildFreshnessSection([{ pillar: "P", kind: "thread", excerpt: "hooks" }]);
    assert.ok(out.includes("ALREADY COVERED"));
    assert.ok(out.includes("[P / thread] hooks"));
  });
});

describe("buildAudienceSection", () => {
  it("falls back gracefully without a profile", async () => {
    const { buildAudienceSection } = await import("../lib/ideation");
    assert.ok(buildAudienceSection().includes("no audience profile yet"));
  });

  it("injects the stored profile when present", async () => {
    const { getDb, nowIso } = await import("../lib/db");
    const { buildAudienceSection } = await import("../lib/ideation");
    getDb()
      .prepare(
        `INSERT INTO vault_docs (id, doc_type, title, body, created_at) VALUES (?, 'audience', 'Target reader', ?, ?)`,
      )
      .run(randomUUID(), "Builders who ship daily.", nowIso());
    const out = buildAudienceSection();
    assert.ok(out.includes("TARGET READER"));
    assert.ok(out.includes("Builders who ship daily."));
  });
});

describe("buildIdeaPrompt", () => {
  it("reasons from reader, formats, news, and covered list", async () => {
    const { buildIdeaPrompt } = await import("../lib/ideation");
    const prompt = buildIdeaPrompt({
      pillarLine: "Pillar: Tools",
      typeLabel: "Short post",
      platformsLine: "x",
      pillarSection: "WINNERS: ...",
      vaultContext: "principles...",
      newsSection: "\n\nNEWS: ...",
      freshnessSection: "ALREADY COVERED: ...",
      audienceSection: "TARGET READER: ...",
    });
    assert.ok(prompt.includes("TARGET READER"));
    assert.ok(prompt.includes("ALREADY COVERED"));
    assert.ok(prompt.includes("FORMAT MOVE"));
    assert.ok(prompt.includes("NEW idea in one of the proven formats"));
    assert.ok(prompt.includes("proven idea") && prompt.includes("fresh format"));
    assert.ok(prompt.includes("IDEA:"));
  });
});

describe("parseIdea", () => {
  it("reads the labeled block, null without an idea", async () => {
    const { parseIdea } = await import("../lib/ideation");
    const parsed = parseIdea("IDEA: Hooks are promises.\nFORMAT MOVE: contrarian list\nWHY NEW: nobody covered it");
    assert.deepEqual(parsed, {
      idea: "Hooks are promises.",
      formatMove: "contrarian list",
      whyNew: "nobody covered it",
    });
    assert.equal(parseIdea("just some prose"), null);
    assert.equal(parseIdea(""), null);
  });
});

describe("ideate", () => {
  it("returns the parsed idea, retries once on empty", async () => {
    const { ideate } = await import("../lib/ideation");
    let n = 0;
    const idea = await ideate(async () => (++n === 1 ? "" : "IDEA: Fresh take."), "prompt");
    assert.equal(idea?.idea, "Fresh take.");
    assert.equal(n, 2);
  });

  it("returns null on garbage and errors", async () => {
    const { ideate } = await import("../lib/ideation");
    assert.equal(await ideate(async () => "no labels here", "prompt"), null);
    assert.equal(
      await ideate(async () => {
        throw new Error("down");
      }, "prompt"),
      null,
    );
  });
});
