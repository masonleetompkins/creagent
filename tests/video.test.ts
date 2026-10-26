import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.SQLITE_PATH = join(mkdtempSync(join(tmpdir(), "creagent-video-")), "test.sqlite");

before(async () => {
  await import("../scripts/migrate");
});

async function libs() {
  const video = await import("../lib/video");
  const autocut = await import("../lib/autocut");
  const db = await import("../lib/db");
  return { video, autocut, db };
}

describe("timeline ripple ops", () => {
  it("appends clips end to end and ripples an insert", async () => {
    const { video, db } = await libs();
    const projectId = `p-${Date.now()}-a`;
    db.getDb().prepare(
      `INSERT INTO video_projects (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)`,
    ).run(projectId, "t", db.nowIso(), db.nowIso());
    const track = video.addTrack(projectId, "video", "V1");
    const a = video.addClip({ trackId: track.id, name: "a", durationMs: 1000 });
    const b = video.addClip({ trackId: track.id, name: "b", durationMs: 1000 });
    assert.equal(a.start_ms, 0);
    assert.equal(b.start_ms, 1000);
    const mid = video.addClip({ trackId: track.id, name: "mid", durationMs: 500, atMs: 1000 });
    assert.equal(mid.start_ms, 1000);
    const after = video.getClip(b.id);
    assert.equal(after?.start_ms, 1500);
  });

  it("ripple trims pull later clips; delete closes the gap", async () => {
    const { video, db } = await libs();
    const projectId = `p-${Date.now()}-b`;
    db.getDb().prepare(
      `INSERT INTO video_projects (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)`,
    ).run(projectId, "t", db.nowIso(), db.nowIso());
    const track = video.addTrack(projectId, "video", "V1");
    const a = video.addClip({ trackId: track.id, name: "a", durationMs: 1000 });
    const b = video.addClip({ trackId: track.id, name: "b", durationMs: 1000 });
    video.trimClip(a.id, { durationMs: 600 });
    assert.equal(video.getClip(b.id)?.start_ms, 600);
    video.trimClip(a.id, { durationMs: 1000 });
    assert.equal(video.getClip(b.id)?.start_ms, 1000);
    video.deleteClip(a.id);
    assert.equal(video.getClip(b.id)?.start_ms, 0);
  });

  it("ripple in-point trim moves the head and later clips together", async () => {
    const { video, db } = await libs();
    const projectId = `p-${Date.now()}-c`;
    db.getDb().prepare(
      `INSERT INTO video_projects (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)`,
    ).run(projectId, "t", db.nowIso(), db.nowIso());
    const track = video.addTrack(projectId, "video", "V1");
    const a = video.addClip({ trackId: track.id, name: "a", durationMs: 1000 });
    const b = video.addClip({ trackId: track.id, name: "b", durationMs: 1000 });
    video.trimClip(a.id, { inMs: 200 });
    const trimmed = video.getClip(a.id);
    assert.equal(trimmed?.in_ms, 200);
    assert.equal(trimmed?.start_ms, 200);
    assert.equal(trimmed?.duration_ms, 800);
    assert.equal(video.getClip(b.id)?.start_ms, 1200);
  });

  it("splits inside a clip and refuses outside splits", async () => {
    const { video, db } = await libs();
    const projectId = `p-${Date.now()}-d`;
    db.getDb().prepare(
      `INSERT INTO video_projects (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)`,
    ).run(projectId, "t", db.nowIso(), db.nowIso());
    const track = video.addTrack(projectId, "video", "V1");
    const a = video.addClip({ trackId: track.id, name: "a", inMs: 500, durationMs: 1000 });
    const { left, right } = video.splitClip(a.id, 400);
    assert.equal(left.duration_ms, 400);
    assert.equal(right.start_ms, 400);
    assert.equal(right.duration_ms, 600);
    assert.equal(right.in_ms, 900);
    assert.throws(() => video.splitClip(a.id, 5000), /inside the clip/);
  });

  it("move clamps out of overlaps without pushing siblings", async () => {
    const { video, db } = await libs();
    const projectId = `p-${Date.now()}-e`;
    db.getDb().prepare(
      `INSERT INTO video_projects (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)`,
    ).run(projectId, "t", db.nowIso(), db.nowIso());
    const track = video.addTrack(projectId, "video", "V1");
    const a = video.addClip({ trackId: track.id, name: "a", durationMs: 1000 });
    const b = video.addClip({ trackId: track.id, name: "b", durationMs: 1000 });
    const moved = video.moveClip(b.id, 500);
    assert.equal(moved.start_ms, 1000);
    assert.equal(video.getClip(a.id)?.start_ms, 0);
    const gap = video.moveClip(a.id, 5000);
    assert.equal(gap.start_ms, 5000);
  });
});

describe("detectTakes", () => {
  function words(text: string, startAt = 0, conf = 0.9) {
    let t = startAt;
    return text.split(" ").map((word, i) => {
      const w = { word, start_ms: t, end_ms: t + 200, conf };
      t += 300;
      void i;
      return w;
    });
  }

  it("keeps the best take and cuts the rest", async () => {
    const { autocut } = await libs();
    const first = words("hello world today.", 0, 0.6);
    const second = words("hello world today.", 5000, 0.95);
    const takes = autocut.detectTakes([...first, ...second]);
    const verdicts = takes.filter((t) => t.label.startsWith("take")).map((t) => t.verdict);
    assert.deepEqual(verdicts, ["cut", "keep"]);
    assert.match(takes.find((t) => t.verdict === "keep")?.label ?? "", /best/);
  });

  it("flags long silence as cut regions", async () => {
    const { autocut } = await libs();
    const takes = autocut.detectTakes(words("one two.", 0).concat(words("three four.", 10000)));
    const silence = takes.filter((t) => t.label.startsWith("silence"));
    assert.equal(silence.length, 1);
    assert.equal(silence[0].verdict, "cut");
  });

  it("marks low-confidence lines unsure instead of cutting", async () => {
    const { autocut } = await libs();
    const takes = autocut.detectTakes(words("mumble mumble.", 0, 0.1));
    assert.equal(takes[0].verdict, "unsure");
  });
});
