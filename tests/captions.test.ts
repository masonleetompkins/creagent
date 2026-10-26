import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.SQLITE_PATH = join(mkdtempSync(join(tmpdir(), "creagent-caps-")), "test.sqlite");

before(async () => {
  await import("../scripts/migrate");
});

async function libs() {
  const captions = await import("../lib/captions");
  const video = await import("../lib/video");
  const db = await import("../lib/db");
  return { captions, video, db };
}

function timed(text: string, startAt = 0, step = 300) {
  let t = startAt;
  return text.split(" ").map((word) => {
    const w = { word, start_ms: t, end_ms: t + 200, conf: 0.9 as number | null, timeline_ms: t };
    t += step;
    return w;
  });
}

describe("captions", () => {
  it("groups words into blocks split by gaps and line limits", async () => {
    const { captions } = await libs();
    const blocks = captions.groupWords(
      [...timed("one two three four", 0), ...timed("five six seven eight", 10000)],
      { wordsPerLine: 2, maxLines: 2 },
    );
    assert.equal(blocks.length, 2);
    assert.deepEqual(
      blocks[0].lines.map((l) => l.text),
      ["one two", "three four"],
    );
    assert.equal(blocks[1].start_ms, 10000);
  });

  it("reflows a block to a new words-per-line", async () => {
    const { captions } = await libs();
    const [block] = captions.groupWords(timed("a b c d e f", 0), { wordsPerLine: 6, maxLines: 1 });
    const words = block.lines.flatMap((l) => {
      const tokens = l.text.split(" ");
      return tokens.map((word, i) => ({
        word,
        start_ms: l.start_ms + i,
        end_ms: l.start_ms + i + 1,
        conf: null,
      }));
    });
    const reflowed = captions.reflowLines(block.lines, words, 2);
    assert.deepEqual(
      reflowed.map((l) => l.text),
      ["a b", "c d", "e f"],
    );
  });

  it("moves words across line boundaries and drops emptied lines", async () => {
    const { captions } = await libs();
    const lines = [
      { text: "hello world", start_ms: 0, end_ms: 400 },
      { text: "foo bar", start_ms: 400, end_ms: 800 },
    ];
    const down = captions.moveWordAcrossLines(lines, 0, 1, 1);
    assert.deepEqual(
      down.map((l) => l.text),
      ["hello", "world foo bar"],
    );
    const up = captions.moveWordAcrossLines(lines, 1, 0, -1);
    assert.deepEqual(
      up.map((l) => l.text),
      ["hello world foo", "bar"],
    );
    const noop = captions.moveWordAcrossLines(lines, 0, 0, -1);
    assert.deepEqual(
      noop.map((l) => l.text),
      ["hello world", "foo bar"],
    );
  });

  it("generates timeline-mapped captions and splits blocks", async () => {
    const { captions, video, db } = await libs();
    const conn = db.getDb();
    const projectId = `p-${Date.now()}`;
    conn.prepare(
      `INSERT INTO video_projects (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)`,
    ).run(projectId, "t", db.nowIso(), db.nowIso());
    const track = video.addTrack(projectId, "video", "V1");
    const assetId = `a-${Date.now()}`;
    conn.prepare(
      `INSERT INTO media_assets (id, kind, path, filename, created_at) VALUES (?, ?, ?, ?, ?)`,
    ).run(assetId, "video", "/tmp/x.mp4", "x.mp4", db.nowIso());
    // Timeline places source [2000,7000] at [0,5000].
    video.addClip({ trackId: track.id, assetId, durationMs: 5000, inMs: 2000 });
    const words = timed("one two three four five six", 2000).map((w) => ({
      word: w.word,
      start_ms: w.start_ms,
      end_ms: w.end_ms,
      conf: w.conf,
    }));
    const blocks = captions.generateCaptions(projectId, assetId, words, { wordsPerLine: 3 });
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].start_ms, 0);
    assert.deepEqual(
      blocks[0].lines.map((l) => l.text),
      ["one two three", "four five six"],
    );
    const split = captions.splitCaption(blocks[0].id, 1);
    assert.ok(split);
    assert.equal(split.left.lines.length, 1);
    assert.equal(split.right.lines.length, 1);
    assert.equal(captions.listCaptions(projectId).length, 2);
    const updated = captions.updateCaption(split.left.id, { enabled: 0 });
    assert.equal(updated?.enabled, 0);
  });
});
