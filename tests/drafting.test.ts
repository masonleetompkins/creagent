import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.SQLITE_PATH = join(mkdtempSync(join(tmpdir(), "creagent-draft-")), "test.sqlite");

before(async () => {
  await import("../scripts/migrate");
});

describe("saveDraft", () => {
  it("inserts the draft body and flips the slot orange", async () => {
    const { saveDraft } = await import("../lib/drafting");
    const { getDb, nowIso } = await import("../lib/db");
    const db = getDb();
    const slotId = randomUUID();
    db.prepare(
      `INSERT INTO queue_slots (id, scheduled_at, content_type, platforms, status, brief, created_at)
       VALUES (?, ?, 'short_post', '[]', 'red', '{}', ?)`,
    ).run(slotId, new Date(Date.now() + 3600000).toISOString(), nowIso());
    const draftId = saveDraft(slotId, "short_post", "hello world");
    const draft = db.prepare(`SELECT body, status FROM drafts WHERE id = ?`).get(draftId) as {
      body: string;
      status: string;
    };
    assert.equal(draft.body, "hello world");
    assert.equal(draft.status, "draft");
    const slot = db.prepare(`SELECT status FROM queue_slots WHERE id = ?`).get(slotId) as {
      status: string;
    };
    assert.equal(slot.status, "orange");
  });
});

describe("planner sync", () => {
  it("flows template edits into future red slots only", async () => {
    const { runPlanner } = await import("../lib/planner");
    const { getDb, nowIso } = await import("../lib/db");
    const db = getDb();
    const pillarA = randomUUID();
    const pillarB = randomUUID();
    db.prepare(`INSERT INTO pillars (id, name, created_at) VALUES (?, 'A', ?)`).run(pillarA, nowIso());
    db.prepare(`INSERT INTO pillars (id, name, created_at) VALUES (?, 'B', ?)`).run(pillarB, nowIso());
    const weekday = new Date().getDay();
    const templateId = randomUUID();
    db.prepare(
      `INSERT INTO queue_templates (id, weekday, time, pillar_id, content_type, platforms, created_at)
       VALUES (?, ?, '23:55', ?, 'short_post', '["x"]', ?)`,
    ).run(templateId, weekday, pillarA, nowIso());
    const redId = randomUUID();
    const orangeId = randomUUID();
    const future = new Date(Date.now() + 2 * 3600000).toISOString();
    for (const [id, status] of [
      [redId, "red"],
      [orangeId, "orange"],
    ] as const) {
      db.prepare(
        `INSERT INTO queue_slots (id, scheduled_at, pillar_id, content_type, platforms, status, brief, created_at)
         VALUES (?, ?, ?, 'short_post', '["x"]', ?, ?, ?)`,
      ).run(id, future, pillarA, status, JSON.stringify({ template_id: templateId }), nowIso());
    }
    db.prepare(`UPDATE queue_templates SET pillar_id = ? WHERE id = ?`).run(pillarB, templateId);
    const res = runPlanner(1);
    assert.ok(res.synced >= 1);
    const red = db.prepare(`SELECT pillar_id FROM queue_slots WHERE id = ?`).get(redId) as {
      pillar_id: string;
    };
    assert.equal(red.pillar_id, pillarB);
    const orange = db.prepare(`SELECT pillar_id FROM queue_slots WHERE id = ?`).get(orangeId) as {
      pillar_id: string;
    };
    assert.equal(orange.pillar_id, pillarA);
  });
});

describe("buildDraftContext", () => {
  it("bounds total size and marks truncation", async () => {
    const { buildDraftContext } = await import("../lib/drafting");
    assert.equal(buildDraftContext([]), "(vault is empty)");
    const short = buildDraftContext([{ doc_type: "principle", title: "T", body: "abc" }]);
    assert.ok(short.includes("[principle] T"));
    assert.ok(short.includes("abc"));
    const long = buildDraftContext(
      [
        { doc_type: "a", title: "T1", body: "x".repeat(5000) },
        { doc_type: "b", title: "T2", body: "y".repeat(5000) },
      ],
      1000,
    );
    assert.ok(long.length <= 1000 + 20);
    assert.ok(long.endsWith("…[truncated]"));
    assert.ok(long.includes("[a] T1") && long.includes("[b] T2"));
  });
});

describe("carouselOutlineIssues", () => {
  const good = [
    "Caption: hook line here with a question? #a #b",
    "",
    "SLIDE 1",
    "Cover hook opens the loop",
    "",
    "SLIDE 2",
    "Because of that, point two",
    "",
    "SLIDE 3",
    "So then point three",
    "",
    "SLIDE 4",
    "Now point four payoff",
  ].join("\n");

  it("accepts caption plus slide markers", async () => {
    const { carouselOutlineIssues } = await import("../lib/drafting");
    assert.deepEqual(carouselOutlineIssues(good), []);
    const inline = "My caption text is definitely long enough\n\nSLIDE 1: hook\n\nSLIDE 2: a\n\nSLIDE 3: b\n\nSLIDE 4: c";
    assert.deepEqual(carouselOutlineIssues(inline), []);
  });

  it("flags marker-less prose like the 4-line miss", async () => {
    const { carouselOutlineIssues } = await import("../lib/drafting");
    const trash = [
      "Election Night proved it.",
      "Your feed swore you already won.",
      "You tapped the chocolate-chip posts, trashed the oatmeal ones.",
      "That's confirmation bias: you ate what agreed with you.",
    ].join("\n");
    const issues = carouselOutlineIssues(trash);
    assert.ok(issues.some((i) => i.includes("SLIDE 1")));
    assert.ok(issues.some((i) => i.includes("0 SLIDE markers")));
  });

  it("flags missing captions, short counts, and empties", async () => {
    const { carouselOutlineIssues } = await import("../lib/drafting");
    assert.ok(carouselOutlineIssues("").includes("empty draft"));
    const noCaption = ["SLIDE 1", "hook", "", "SLIDE 2", "a", "", "SLIDE 3", "b", "", "SLIDE 4", "c"].join("\n");
    assert.ok(carouselOutlineIssues(noCaption).some((i) => i.includes("caption")));
    const short = "A caption long enough to pass the check\n\nSLIDE 1\nhook\n\nSLIDE 2\ntail";
    assert.ok(carouselOutlineIssues(short).some((i) => i.includes("2 SLIDE markers")));
  });
});
