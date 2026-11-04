import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.SQLITE_PATH = join(mkdtempSync(join(tmpdir(), "creagent-carousel-pipe-")), "test.sqlite");
process.env.PHOTOS_DIR = mkdtempSync(join(tmpdir(), "creagent-photos-"));
process.env.CREAGENT_DESIGN_OFFLINE = "1";
process.env.CREAGENT_MODEL_OFFLINE = "1";

before(async () => {
  await import("../scripts/migrate");
});

describe("slide backgrounds", () => {
  it("validates and normalizes background values", async () => {
    const { isBackground, normalizeBackground } = await import("../lib/carousel");
    assert.equal(isBackground(null), true);
    assert.equal(isBackground(""), true);
    assert.equal(isBackground("gradient"), true);
    assert.equal(isBackground("#ffffff"), true);
    assert.equal(isBackground("white"), false);
    assert.equal(isBackground("red"), false);
    assert.equal(normalizeBackground(""), null);
    assert.equal(normalizeBackground("gradient"), "gradient");
    assert.throws(() => normalizeBackground("white"), /unknown background/);
  });

  it("round-trips backgrounds through add/update", async () => {
    const { addSlide, createProject, updateSlide } = await import("../lib/carousel");
    const project = createProject({ title: "bg" });
    const plain = addSlide(project.id, { heading: "h" });
    assert.equal(plain.background, null);
    const dark = updateSlide(plain.id, { background: "#111111" });
    assert.equal(dark?.background, "#111111");
    const reset = updateSlide(plain.id, { background: "" });
    assert.equal(reset?.background, null);
    assert.throws(() => updateSlide(plain.id, { background: "white" }), /unknown background/);
    const grad = addSlide(project.id, { heading: "g", background: "gradient" });
    assert.equal(grad.background, "gradient");
  });
});

describe("inkForBackground", () => {
  const kit = { primary: "#0b5fff", secondary: "#111111", background: "#ffffff" };

  it("picks white ink on dark fills, kit ink on light ones", async () => {
    const { inkForBackground } = await import("../lib/carousel-render");
    assert.equal(inkForBackground(null, kit), "#111111");
    assert.equal(inkForBackground("", kit), "#111111");
    assert.equal(inkForBackground("#ffffff", kit), "#111111");
    assert.equal(inkForBackground("#111111", kit), "#ffffff");
    assert.equal(inkForBackground("#000000", kit), "#ffffff");
  });

  it("judges gradients by their primary/secondary mix", async () => {
    const { inkForBackground } = await import("../lib/carousel-render");
    assert.equal(inkForBackground("gradient", kit), "#ffffff");
    const light = { primary: "#ffe08a", secondary: "#ffffff", background: "#ffffff" };
    assert.equal(inkForBackground("gradient", light), "#ffffff");
  });
});

describe("parseDesignJson", () => {
  it("maps named backgrounds and sanitizes layouts", async () => {
    const { parseDesignJson } = await import("../lib/carousel-design");
    const out = parseDesignJson(
      '[{"layout":"cover","background":"white"},{"layout":"bogus","background":"kit"},{"layout":"cta","background":"#FF0000"}]',
    );
    assert.deepEqual(out, [
      { layout: "cover", background: "#ffffff" },
      { layout: "content", background: null },
      { layout: "cta", background: "#ff0000" },
    ]);
  });

  it("reads fenced arrays and rejects junk", async () => {
    const { parseDesignJson } = await import("../lib/carousel-design");
    const fenced = parseDesignJson('```json\n[{"layout":"photo","background":"gradient"}]\n```');
    assert.deepEqual(fenced, [{ layout: "photo", background: "gradient" }]);
    assert.throws(() => parseDesignJson("no json here"), /design JSON/);
    assert.throws(() => parseDesignJson('{"nope":1}'), /not an array/);
  });
});

describe("fallbackDesigns", () => {
  it("anchors cover/cta, keeps photo slides on the kit, varies text slides", async () => {
    const { fallbackDesigns } = await import("../lib/carousel-design");
    const out = fallbackDesigns(5, [false, false, true, false, false]);
    assert.deepEqual(out[0], { layout: "cover", background: "gradient" });
    assert.deepEqual(out[4], { layout: "cta", background: "#111111" });
    assert.deepEqual(out[2], { layout: "content", background: null });
    const varied = new Set(fallbackDesigns(7, Array(7).fill(false)).map((d) => String(d.background)));
    assert.ok(varied.size >= 3);
  });
});

describe("runAutoDesign offline", () => {
  it("designs every slide without a model call", async () => {
    const { addSlide, createProject, listSlides } = await import("../lib/carousel");
    const { runAutoDesign } = await import("../lib/carousel-design");
    const project = createProject({ title: "design" });
    for (let i = 0; i < 4; i++) addSlide(project.id, { heading: `H${i}`, body: `B${i}` });
    const out = await runAutoDesign(project.id);
    assert.equal(out.designed, 4);
    assert.equal(out.fallback, true);
    const slides = listSlides(project.id);
    assert.equal(slides[0].layout, "cover");
    assert.equal(slides[0].background, "gradient");
    assert.equal(slides[3].layout, "cta");
  });

  it("rejects unknown projects", async () => {
    const { runAutoDesign } = await import("../lib/carousel-design");
    await assert.rejects(() => runAutoDesign(randomUUID()), /not found/);
  });
});

describe("carousel shell plus finish", () => {
  it("parses slides, plans images, and designs without review gaps", async () => {
    const { getDb, nowIso } = await import("../lib/db");
    const { createCarouselShellFromSlot, finishCarouselBuild } = await import("../lib/carousel-copy");
    const { listSlides } = await import("../lib/carousel");
    const db = getDb();
    const slotId = randomUUID();
    const draftId = randomUUID();
    const ts = nowIso();
    db.prepare(
      `INSERT INTO queue_slots (id, scheduled_at, content_type, platforms, status, created_at)
       VALUES (?, ?, 'carousel', '[]', 'green', ?)`,
    ).run(slotId, "2026-11-01T09:00:00.000Z", ts);
    db.prepare(
      `INSERT INTO drafts (id, slot_id, kind, body, status, created_at) VALUES (?, ?, 'carousel', ?, 'draft', ?)`,
    ).run(draftId, slotId, "Stop doing this\n\nReason one is clear.\n\nReason two is clearer.\n\nFollow along", ts);
    db.prepare(
      `UPDATE queue_slots SET approved_draft_id = ?, approved_option = 0 WHERE id = ?`,
    ).run(draftId, slotId);
    const shell = createCarouselShellFromSlot(slotId);
    assert.equal(shell.slides, 4);
    const out = await finishCarouselBuild(shell.projectId);
    assert.equal(out.slides, 4);
    assert.equal(out.picks, 0);
    assert.equal(out.requested, 4);
    assert.equal(out.designFallback, true);
    const slides = listSlides(shell.projectId);
    assert.equal(slides[0].layout, "cover");
    assert.equal(slides[0].background, "gradient");
    assert.equal(slides[3].layout, "cta");
    const reqs = db.prepare(`SELECT COUNT(*) AS n FROM gen_requests WHERE project_id = ?`).get(shell.projectId) as {
      n: number;
    };
    assert.equal(reqs.n, 4);
    const status = db.prepare(`SELECT status FROM queue_slots WHERE id = ?`).get(slotId) as { status: string };
    assert.equal(status.status, "orange");
  });
});

describe("house image style", () => {
  it("locks every prompt to the anime style, exactly once", async () => {
    const { HOUSE_IMAGE_STYLE, withHouseStyle } = await import("../lib/house-style");
    assert.match(HOUSE_IMAGE_STYLE, /Pantheon/);
    assert.match(HOUSE_IMAGE_STYLE, /bold outlines/);
    assert.match(HOUSE_IMAGE_STYLE, /no text in the image/);
    const styled = withHouseStyle("a jar of cookies");
    assert.match(styled, /a jar of cookies/);
    assert.match(styled, /Pantheon/);
    assert.equal(withHouseStyle(styled), styled);
    assert.equal(withHouseStyle("   "), HOUSE_IMAGE_STYLE);
  });

  it("locks style at generation while plans stay content-only", async () => {
    const { buildImagePrompt } = await import("../lib/carousel-plan");
    const { styledImagePrompt } = await import("../lib/carousel-image");
    assert.equal(
      buildImagePrompt({ heading: "H", body: "B", image_prompt: "a kitchen scene" }),
      "a kitchen scene",
    );
    const styled = styledImagePrompt("a kitchen scene");
    assert.match(styled, /a kitchen scene/);
    assert.match(styled, /Pantheon/);
    assert.match(styled, /bold outlines/);
    assert.equal(styledImagePrompt(styled), styled);
  });
});

describe("parseStoryJson", () => {
  it("keeps valid entries and drops malformed ones", async () => {
    const { parseStoryJson } = await import("../lib/carousel-plan");
    assert.deepEqual(parseStoryJson('[{"slide":3,"prompt":"the jar"}]'), [{ slide: 3, prompt: "the jar" }]);
    assert.deepEqual(parseStoryJson('```json\n[{"slide":1,"prompt":"x"}]\n```'), [{ slide: 1, prompt: "x" }]);
    assert.deepEqual(
      parseStoryJson('[{"slide":0,"prompt":"bad"},{"slide":2},{"slide":"3","prompt":"bad"},{"slide":2,"prompt":"ok"}]'),
      [{ slide: 2, prompt: "ok" }],
    );
    assert.throws(() => parseStoryJson("nope"), /story JSON/);
    assert.throws(() => parseStoryJson('{"a":1}'), /not an array/);
  });
});

describe("story-aware planning offline", () => {
  it("leaves prompts to the heuristic without a model call", async () => {
    const { addSlide, createProject, listSlides } = await import("../lib/carousel");
    const { planStoryPrompts } = await import("../lib/carousel-plan");
    const project = createProject({ title: "story" });
    const a = addSlide(project.id, { heading: "Jar", body: "cookies" });
    const out = await planStoryPrompts(project.id, [a.id]);
    assert.deepEqual(out, { planned: 0, fallback: true });
    assert.equal(listSlides(project.id)[0].image_prompt, null);
    assert.deepEqual(await planStoryPrompts(project.id, []), { planned: 0, fallback: false });
  });

  it("files content-only requests for unmatched slides", async () => {
    const { getDb } = await import("../lib/db");
    const { addSlide, createProject } = await import("../lib/carousel");
    const { runPlanImages } = await import("../lib/carousel-plan");
    const project = createProject({ title: "plan" });
    addSlide(project.id, { heading: "Cookie jar", body: "oatmeal at the bottom" });
    addSlide(project.id, { heading: "Taste test", body: "dig down" });
    const out = await runPlanImages(project.id);
    assert.equal(out.attached, 0);
    assert.equal(out.requested, 2);
    assert.equal(out.story, 0);
    assert.equal(out.storyFallback, true);
    const rows = getDb()
      .prepare(`SELECT prompt FROM gen_requests WHERE project_id = ? ORDER BY created_at ASC`)
      .all(project.id) as Array<{ prompt: string }>;
    assert.equal(rows.length, 2);
    assert.match(rows[0].prompt, /Cookie jar/);
    assert.match(rows[0].prompt, /no text in the image/);
    assert.match(rows[1].prompt, /Taste test/);
  });
});

describe("resolveSlotOutline", () => {
  async function seedSlot(withPin: boolean): Promise<string> {
    const { getDb, nowIso } = await import("../lib/db");
    const db = getDb();
    const slotId = randomUUID();
    const ts = nowIso();
    db.prepare(
      `INSERT INTO queue_slots (id, scheduled_at, content_type, platforms, status, created_at)
       VALUES (?, ?, 'carousel', '[]', 'orange', ?)`,
    ).run(slotId, "2026-11-01T09:00:00.000Z", ts);
    const struct = JSON.stringify({
      layout: "pick-one",
      options: [
        { label: "A", body: "Caption A\n\nSLIDE 1: hook A" },
        { label: "B", body: "Caption B\n\nSLIDE 1: hook B" },
      ],
    });
    const oldId = randomUUID();
    db.prepare(
      `INSERT INTO drafts (id, slot_id, kind, body, status, created_at, structure, selection)
       VALUES (?, ?, 'carousel', 'old', 'draft', ?, ?, '1')`,
    ).run(oldId, slotId, "2026-11-01T08:00:00.000Z", struct);
    if (withPin) {
      db.prepare(`UPDATE queue_slots SET approved_draft_id = ?, approved_option = 1 WHERE id = ?`).run(
        oldId,
        slotId,
      );
    }
    return slotId;
  }

  it("prefers the approved pick", async () => {
    const { resolveSlotOutline } = await import("../lib/carousel-copy");
    const slotId = await seedSlot(true);
    assert.match(resolveSlotOutline(slotId), /hook B/);
  });

  it("falls back to the newest draft's selection", async () => {
    const { getDb } = await import("../lib/db");
    const { resolveSlotOutline } = await import("../lib/carousel-copy");
    const slotId = await seedSlot(false);
    // Newest unapproved draft has selection=1 -> option B.
    assert.match(resolveSlotOutline(slotId), /hook B/);
    // Whole-body prose (structure cleared by edit) comes back whole.
    getDb()
      .prepare(`UPDATE drafts SET body = ?, structure = NULL, selection = NULL WHERE slot_id = ?`)
      .run("My revised outline\n\nSLIDE 1: mine", slotId);
    assert.equal(resolveSlotOutline(slotId), "My revised outline\n\nSLIDE 1: mine");
  });

  it("returns empty when the slot has no drafts", async () => {
    const { getDb, nowIso } = await import("../lib/db");
    const { resolveSlotOutline } = await import("../lib/carousel-copy");
    const slotId = randomUUID();
    getDb()
      .prepare(
        `INSERT INTO queue_slots (id, scheduled_at, content_type, platforms, status, created_at)
         VALUES (?, ?, 'carousel', '[]', 'red', ?)`,
      )
      .run(slotId, "2026-11-01T09:00:00.000Z", nowIso());
    assert.equal(resolveSlotOutline(slotId), "");
  });
});

describe("edit_slide agent tool", () => {
  it("edits layout and background as well as copy", async () => {
    const { AGENT_TOOLS } = await import("../lib/agent-tools");
    const { addSlide, createProject, listSlides } = await import("../lib/carousel");
    const project = createProject({ title: "agent" });
    const slide = addSlide(project.id, { heading: "h", body: "b" });
    const tool = AGENT_TOOLS.find((t) => t.name === "edit_slide");
    assert.ok(tool);
    const res = (await tool.run({ slideId: slide.id, layout: "cover", background: "black" })) as {
      ok: boolean;
      error?: string;
    };
    assert.equal(res.ok, true);
    const after = listSlides(project.id)[0];
    assert.equal(after.layout, "cover");
    assert.equal(after.background, "#111111");
    const bad = (await tool.run({ slideId: slide.id, layout: "nope" })) as { ok: boolean; error?: string };
    assert.equal(bad.ok, false);
    assert.match(bad.error ?? "", /unknown layout/);
  });

  it("auto-designs a project through the agent tool", async () => {
    const { AGENT_TOOLS } = await import("../lib/agent-tools");
    const { addSlide, createProject } = await import("../lib/carousel");
    const project = createProject({ title: "agent-design" });
    addSlide(project.id, { heading: "h" });
    addSlide(project.id, { heading: "h2" });
    const tool = AGENT_TOOLS.find((t) => t.name === "carousel_auto_design");
    assert.ok(tool);
    const res = await tool.run({ projectId: project.id });
    assert.equal(res.ok, true);
    assert.equal((res.data as { designed: number }).designed, 2);
  });
});
