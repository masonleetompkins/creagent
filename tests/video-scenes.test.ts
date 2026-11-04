import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.SQLITE_PATH = join(mkdtempSync(join(tmpdir(), "creagent-video-scenes-")), "test.sqlite");
process.env.CREAGENT_MODEL_OFFLINE = "1";

before(async () => {
  await import("../scripts/migrate");
});

describe("statementsFromWords", () => {
  it("splits sentences and keeps asset timings", async () => {
    const { statementsFromWords } = await import("../lib/video-scenes");
    const words = [
      { word: "Hello", start_ms: 0, end_ms: 200, conf: null },
      { word: "there.", start_ms: 200, end_ms: 500, conf: null },
      { word: "How", start_ms: 600, end_ms: 800, conf: null },
      { word: "are", start_ms: 800, end_ms: 1000, conf: null },
      { word: "you?", start_ms: 1000, end_ms: 1300, conf: null },
    ];
    const out = statementsFromWords(words);
    assert.equal(out.length, 2);
    assert.equal(out[0].text, "Hello there.");
    assert.equal(out[0].startAssetMs, 0);
    assert.equal(out[0].endAssetMs, 500);
    assert.equal(out[1].text, "How are you?");
    assert.equal(out[1].startAssetMs, 600);
    assert.equal(out[1].endAssetMs, 1300);
  });

  it("keeps unterminated tails and empties", async () => {
    const { statementsFromWords } = await import("../lib/video-scenes");
    assert.deepEqual(statementsFromWords([]), []);
    const out = statementsFromWords([
      { word: "trailing", start_ms: 0, end_ms: 300, conf: null },
      { word: "thought", start_ms: 300, end_ms: 600, conf: null },
    ]);
    assert.equal(out.length, 1);
    assert.equal(out[0].text, "trailing thought");
  });
});

describe("parseSceneJson", () => {
  it("keeps valid scenes and drops malformed entries", async () => {
    const { parseSceneJson } = await import("../lib/video-scenes");
    assert.deepEqual(parseSceneJson('[{"statement":2,"prompt":"the jar"}]'), [
      { statement: 2, prompt: "the jar" },
    ]);
    assert.deepEqual(parseSceneJson('```json\n[{"statement":1,"prompt":"x"}]\n```'), [
      { statement: 1, prompt: "x" },
    ]);
    assert.deepEqual(
      parseSceneJson(
        '[{"statement":0,"prompt":"bad"},{"statement":2},{"statement":"3","prompt":"bad"},{"statement":2,"prompt":"ok"}]',
      ),
      [{ statement: 2, prompt: "ok" }],
    );
    assert.throws(() => parseSceneJson("nope"), /scene JSON/);
    assert.throws(() => parseSceneJson('{"a":1}'), /not an array/);
  });
});

describe("collectStatements", () => {
  it("maps spoken statements onto Main timeline ranges", async () => {
    const { getDb, nowIso } = await import("../lib/db");
    const { addClip, addTrack, createProject, getProjectDetail } = await import("../lib/video");
    const { collectStatements } = await import("../lib/video-scenes");
    const db = getDb();
    const project = createProject({ title: "scenes" });
    const detail = getProjectDetail(project.id);
    assert.ok(detail);
    const main =
      detail.tracks.find((t) => t.kind === "video" && t.name === "Main") ??
      addTrack(project.id, "video", "Main");
    const assetId = randomUUID();
    const ts = nowIso();
    db.prepare(
      `INSERT INTO media_assets (id, kind, path, filename, mime, duration_ms, created_at)
       VALUES (?, 'video', '/tmp/x.mp4', 'x.mp4', 'video/mp4', 60000, ?)`,
    ).run(assetId, ts);
    const transcriptId = randomUUID();
    db.prepare(`INSERT INTO transcripts (id, asset_id, lang, full_text, created_at) VALUES (?, ?, 'en', '', ?)`).run(
      transcriptId,
      assetId,
      ts,
    );
    const seed = (word: string, start: number, end: number, idx: number): void => {
      db.prepare(
        `INSERT INTO transcript_words (id, transcript_id, idx, word, start_ms, end_ms, conf)
         VALUES (?, ?, ?, ?, ?, ?, NULL)`,
      ).run(randomUUID(), transcriptId, idx, word, start, end);
    };
    seed("Hello", 1000, 1500, 0);
    seed("there.", 1500, 2000, 1);
    seed("Second", 20000, 20500, 2);
    seed("line.", 20500, 21000, 3);
    // Take covers 0-10s on the timeline from asset 0-10s: first statement
    // maps, the 20s statement falls in a cut gap.
    addClip({ trackId: main.id, assetId, name: "take", inMs: 0, durationMs: 10000, atMs: 0 });
    const out = collectStatements(project.id);
    assert.equal(out.length, 1);
    assert.equal(out[0].text, "Hello there.");
    assert.equal(out[0].startMs, 1000);
    assert.equal(out[0].durationMs, 1000);
  });

  it("rejects unknown projects", async () => {
    const { collectStatements } = await import("../lib/video-scenes");
    assert.throws(() => collectStatements(randomUUID()), /not found/);
  });
});

describe("planScenePrompts offline", () => {
  it("falls back to heuristics without a model call", async () => {
    const { heuristicScenePrompt, planScenePrompts } = await import("../lib/video-scenes");
    assert.match(heuristicScenePrompt("Hello there."), /Hello there/);
    assert.match(heuristicScenePrompt("Hello there."), /9:16/);
    const out = await planScenePrompts("whatever", [
      { index: 0, text: "Hello there.", assetId: "a", startAssetMs: 0, endAssetMs: 1, startMs: 0, durationMs: 1 },
    ], "");
    assert.equal(out.size, 1);
    assert.match(out.get(0) ?? "", /Hello there/);
  });
});
