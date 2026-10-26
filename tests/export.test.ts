import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.SQLITE_PATH = join(mkdtempSync(join(tmpdir(), "creagent-exp-")), "test.sqlite");

before(async () => {
  await import("../scripts/migrate");
});

function plan(overrides = {}) {
  return {
    projectId: "p",
    width: 1080,
    height: 1920,
    fps: 30,
    duration_ms: 6000,
    style: { caption_font: "system", heading_font: "system-black" },
    videoTracks: [],
    audioTracks: [],
    mainAudio: [],
    captions: [],
    graphics: [],
    hyperframes: [],
    ...overrides,
  };
}

describe("export builder", () => {
  it("writes valid SRT with escaped markup", async () => {
    const { buildSrt } = await import("../lib/export");
    const srt = buildSrt([
      { start_ms: 100, end_ms: 1500, lines: ["Hello <world>", "second line"] },
      { start_ms: 2000, end_ms: 2500, lines: ["Bye"] },
    ]);
    assert.equal(
      srt,
      "1\n00:00:00,100 --> 00:00:01,500\nHello &lt;world&gt;\nsecond line\n\n2\n00:00:02,000 --> 00:00:02,500\nBye\n",
    );
  });

  it("concats clips with black gap fillers and pads the tail", async () => {
    const { buildFfmpegArgs } = await import("../lib/export");
    const { filter, inputCount } = buildFfmpegArgs(
      plan({
        videoTracks: [
          [
            { assetPath: "/v/a.mp4", assetKind: "video", hasAudio: false, start_ms: 1000, duration_ms: 2000, in_ms: 0 },
            { assetPath: "/v/b.mp4", assetKind: "video", hasAudio: false, start_ms: 4000, duration_ms: 1000, in_ms: 500 },
          ],
        ],
      }),
      null,
      "/o/out.mp4",
    );
    assert.equal(inputCount, 2);
    // Leading gap, middle gap, tail pad: three black fillers + concat of 5.
    assert.equal((filter.match(/color=black/g) ?? []).length, 3);
    assert.match(filter, /concat=n=5:v=1:a=0\[vtrack0\]/);
    assert.match(filter, /scale=1080:1920/);
  });

  it("stacks a subject track over the base with overlay", async () => {
    const { buildFfmpegArgs } = await import("../lib/export");
    const clip = (start_ms: number) => ({
      assetPath: "/v/a.mp4",
      assetKind: "video",
      hasAudio: false,
      start_ms,
      duration_ms: 2000,
      in_ms: 0,
    });
    const { filter } = buildFfmpegArgs(
      plan({ videoTracks: [[clip(0)], [clip(0)]] }),
      null,
      "/o/out.mp4",
    );
    assert.match(filter, /\[vtrack1\]\[vtrack0\]overlay=0:0:eof_action=pass\[vstack\]/);
  });

  it("fills overlay-track gaps transparently and base gaps black", async () => {
    const { buildFfmpegArgs } = await import("../lib/export");
    const { filter } = buildFfmpegArgs(
      plan({
        videoTracks: [
          [
            {
              assetPath: "/v/top.mp4",
              assetKind: "video",
              hasAudio: false,
              start_ms: 2000,
              duration_ms: 2000,
              in_ms: 0,
            },
          ],
          [
            {
              assetPath: "/v/base.mp4",
              assetKind: "video",
              hasAudio: false,
              start_ms: 1000,
              duration_ms: 2000,
              in_ms: 0,
            },
          ],
        ],
      }),
      null,
      "/o/out.mp4",
    );
    assert.match(filter, /color=black@0:size=1080x1920[^\[]*\[vg0_0\]/);
    assert.match(filter, /\[0:v\]scale=[^\[]*format=rgba\[vv0_0\]/);
    assert.match(filter, /color=black:size=1080x1920[^\[]*\[vg1_0\]/);
    assert.doesNotMatch(filter, /\[1:v\]scale=[^\[]*rgba/);
  });

  it("burns captions, draws graphics, and mixes audio", async () => {
    const { buildFfmpegArgs } = await import("../lib/export");
    const { filter, args } = buildFfmpegArgs(
      plan({
        videoTracks: [
          [{ assetPath: "/v/a.mp4", assetKind: "video", hasAudio: false, start_ms: 0, duration_ms: 6000, in_ms: 0 }],
        ],
        audioTracks: [
          [{ assetPath: "/a/m.mp3", assetKind: "audio", hasAudio: false, start_ms: 0, duration_ms: 6000, in_ms: 0 }],
        ],
        mainAudio: [
          { assetPath: "/v/a.mp4", assetKind: "video", hasAudio: true, start_ms: 0, duration_ms: 6000, in_ms: 0 },
        ],
        captions: [{ start_ms: 0, end_ms: 1000, lines: ["Hi"] }],
        graphics: [
          { start_ms: 0, end_ms: 2000, text: "Title: it's", y_pct: 12, fontsize: 72, color: "white", box: true },
        ],
      }),
      "/o/caps.srt",
      "/o/out.mp4",
      { headingFace: "Arial Black", captionFace: "Helvetica" },
    );
    assert.match(filter, /subtitles='\/o\/caps\.srt'/);
    assert.match(filter, /FontName=Helvetica/);
    assert.match(filter, /drawtext=font='Arial Black':text='Title\\: it\\'s'/);
    assert.match(filter, /amix=inputs=2:duration=longest\[aout\]/);
    assert.ok(args.includes("-map") && args.includes("[aout]"));
    assert.ok(args.includes("libx264") && args.includes("yuv420p"));
  });

  it("escapes drawtext metacharacters", async () => {
    const { buildFfmpegArgs } = await import("../lib/export");
    const { filter } = buildFfmpegArgs(
      plan({
        graphics: [
          { start_ms: 0, end_ms: 1000, text: "a:b\\c'd", y_pct: 50, fontsize: 40, color: "white", box: false },
        ],
      }),
      null,
      "/o/out.mp4",
    );
    assert.match(filter, /text='a\\:b\\\\c\\'d'/);
  });

  it("writes a fontconfig pointing at system font dirs", async () => {
    const { ensureFontconfig } = await import("../lib/export");
    const { readFileSync } = await import("node:fs");
    const conf = ensureFontconfig();
    const body = readFileSync(conf, "utf8");
    assert.match(body, /<fontconfig>/);
    assert.match(body, /\/System\/Library\/Fonts/);
    assert.match(body, /\/usr\/share\/fonts/);
  });

  it("composites hyperframes renders with offset timestamps and windows", async () => {
    const { buildFfmpegArgs } = await import("../lib/export");
    const { filter, inputCount } = buildFfmpegArgs(
      plan({
        videoTracks: [
          [
            {
              assetPath: "/v/a.mp4",
              assetKind: "video",
              hasAudio: false,
              start_ms: 0,
              duration_ms: 6000,
              in_ms: 0,
            },
          ],
        ],
      }),
      null,
      "/o/out.mp4",
      { hyperframes: [{ path: "/h/gfx.mov", start_ms: 2000, end_ms: 5000 }] },
    );
    assert.equal(inputCount, 2);
    assert.match(filter, /\[1:v\]format=rgba,setpts=PTS-STARTPTS\+2\.000\/TB\[hf0\]/);
    assert.match(filter, /overlay=0:0:enable='between\(t,2\.000,5\.000\)':eof_action=pass\[vhf0\]/);
  });

  it("plans hyperframes clips from graphics payloads", async () => {
    const { planExport } = await import("../lib/export");
    const video = await import("../lib/video");
    const db = await import("../lib/db");
    const conn = db.getDb();
    const projectId = `p-${Date.now()}-hf`;
    conn.prepare(
      `INSERT INTO video_projects (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)`,
    ).run(projectId, "t", db.nowIso(), db.nowIso());
    const main = video.addTrack(projectId, "video", "Main");
    const gfx = video.addTrack(projectId, "graphics", "Graphics");
    const src = join(mkdtempSync(join(tmpdir(), "hf-src-")), "clip.mp4");
    writeFileSync(src, Buffer.from("FAKE"));
    const assetId = `a-${Date.now()}-hf`;
    conn.prepare(
      `INSERT INTO media_assets (id, kind, path, filename, created_at) VALUES (?, ?, ?, ?, ?)`,
    ).run(assetId, "video", src, "clip.mp4", db.nowIso());
    video.addClip({ trackId: main.id, assetId, durationMs: 6000 });
    video.addClip({
      trackId: gfx.id,
      name: "hf",
      durationMs: 3000,
      atMs: 1000,
      payload: { kind: "hyperframes", html: "<div>hi</div>" },
    });
    const planned = planExport(projectId);
    assert.equal(planned.hyperframes.length, 1);
    assert.equal(planned.hyperframes[0].start_ms, 1000);
    assert.equal(planned.hyperframes[0].end_ms, 4000);
  });

  it("plans from the DB with main-track audio and text cards", async () => {
    const { planExport } = await import("../lib/export");
    const video = await import("../lib/video");
    const db = await import("../lib/db");
    const conn = db.getDb();
    const projectId = `p-${Date.now()}`;
    conn.prepare(
      `INSERT INTO video_projects (id, title, style, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
    ).run(projectId, "t", JSON.stringify({ caption_font: "helvetica", heading_font: "anton" }), db.nowIso(), db.nowIso());
    const main = video.addTrack(projectId, "video", "Main");
    video.addTrack(projectId, "audio", "A1");
    const gfx = video.addTrack(projectId, "graphics", "Graphics");
    const src = join(mkdtempSync(join(tmpdir(), "exp-src-")), "clip.mp4");
    writeFileSync(src, Buffer.from("FAKE"));
    const assetId = `a-${Date.now()}`;
    conn.prepare(
      `INSERT INTO media_assets (id, kind, path, filename, has_audio, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(assetId, "video", src, "clip.mp4", 1, db.nowIso());
    video.addClip({ trackId: main.id, assetId, durationMs: 3000 });
    conn.prepare(
      `INSERT INTO video_clips (id, track_id, name, start_ms, duration_ms, in_ms, payload, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(`c-${Date.now()}`, gfx.id, "card", 0, 2000, 0, JSON.stringify({ text: "Hello", y_pct: 20 }), db.nowIso());
    const planned = planExport(projectId);
    assert.equal(planned.duration_ms, 3000);
    assert.equal(planned.videoTracks.length, 1);
    assert.equal(planned.mainAudio.length, 1);
    assert.equal(planned.graphics.length, 1);
    assert.equal(planned.graphics[0].text, "Hello");
    assert.equal(planned.style.caption_font, "helvetica");
  });
});
