import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.SQLITE_PATH = join(
  mkdtempSync(join(tmpdir(), "creagent-transcript-backfill-")),
  "test.sqlite",
);

before(async () => {
  await import("../scripts/migrate");
});

describe("parseTranscript", () => {
  it("reads transcript shapes and not-found markers", async () => {
    const { parseTranscript } = await import("../lib/transcript-backfill");
    assert.deepEqual(parseTranscript({ data: { transcript: "  hello world  " } }), {
      text: "hello world",
    });
    assert.deepEqual(parseTranscript({ transcript: "top level" }), { text: "top level" });
    assert.deepEqual(
      parseTranscript({ data: { segments: [{ text: "a" }, { text: "b" }, "c"] } }),
      { text: "a b c" },
    );
    assert.deepEqual(parseTranscript({ found: false }), { notFound: true });
    assert.equal(parseTranscript({ data: { views: 10 } }), null);
    assert.equal(parseTranscript(null), null);
    assert.equal(parseTranscript("nope"), null);
  });
});

describe("endpointFor + detectVideo", () => {
  it("maps sources to endpoints and spots video items", async () => {
    const { endpointFor } = await import("../lib/transcript-backfill");
    const { detectVideo } = await import("../lib/ingest");
    assert.equal(endpointFor("tiktok_videos")?.endpoint, "/tiktok.video_transcript_full");
    assert.equal(endpointFor("youtube_transcript")?.route, "badger");
    assert.equal(endpointFor("instagram_posts")?.endpoint, "/instagram.reel_transcript");
    assert.equal(endpointFor("x_posts"), null);
    assert.equal(detectVideo("tiktok_videos", {}), true);
    assert.equal(detectVideo("x_posts", {}), false);
    assert.equal(detectVideo("instagram_posts", { mediaType: "reel" }), true);
    assert.equal(detectVideo("instagram_posts", { mediaType: "photo" }), false);
    assert.equal(detectVideo("instagram_posts", { videoUrl: "https://x/y.mp4" }), true);
  });
});

describe("runPool", () => {
  it("runs every item exactly once across lanes", async () => {
    const { runPool } = await import("../lib/transcript-backfill");
    const seen: number[] = [];
    const items = Array.from({ length: 20 }, (_, i) => i);
    await runPool(items, 4, async (item) => {
      await new Promise((r) => setTimeout(r, Math.random() * 5));
      seen.push(item);
    });
    assert.deepEqual([...seen].sort((a, b) => a - b), items);
  });

  it("caps parallelism but actually runs in parallel", async () => {
    const { runPool } = await import("../lib/transcript-backfill");
    let active = 0;
    let maxActive = 0;
    await runPool(Array.from({ length: 12 }, (_, i) => i), 3, async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 10));
      active--;
    });
    assert.ok(maxActive > 1, `expected parallel lanes, saw max ${maxActive}`);
    assert.ok(maxActive <= 3, `cap exceeded: ${maxActive}`);
  });

  it("handles empty input and degenerate concurrency", async () => {
    const { runPool } = await import("../lib/transcript-backfill");
    let calls = 0;
    await runPool([], 4, async () => {
      calls++;
    });
    assert.equal(calls, 0);
    await runPool([1, 2, 3], 0, async () => {
      calls++;
    });
    assert.equal(calls, 3);
  });

  it("propagates fn errors to the caller", async () => {
    const { runPool } = await import("../lib/transcript-backfill");
    await assert.rejects(
      runPool([1, 2, 3], 2, async (item) => {
        if (item === 2) throw new Error("boom");
      }),
      /boom/,
    );
  });
});

describe("eligibleCount", () => {
  it("counts only untranscribed videos with urls", async () => {
    const { storeAsset } = await import("../lib/ingest");
    const { eligibleCount, eligibleAssets } = await import("../lib/transcript-backfill");
    const { getDb } = await import("../lib/db");
    const db = getDb();
    storeAsset(db, {
      source: "tiktok_videos",
      sourceUrl: "https://tiktok.com/@u/video/1",
      title: "v1",
      transcript: "",
      metadata: {},
      postedAt: null,
      isReply: false,
      isVideo: true,
      transcribedAt: null,
    });
    storeAsset(db, {
      source: "tiktok_videos",
      sourceUrl: "https://tiktok.com/@u/video/2",
      title: "v2",
      transcript: "already",
      metadata: {},
      postedAt: null,
      isReply: false,
      isVideo: true,
      transcribedAt: "2026-01-01T00:00:00.000Z",
    });
    storeAsset(db, {
      source: "x_posts",
      sourceUrl: "https://x.com/u/status/1",
      title: "t",
      transcript: "",
      metadata: {},
      postedAt: null,
      isReply: false,
      isVideo: false,
      transcribedAt: null,
    });
    const counts = eligibleCount();
    assert.equal(counts.total, 1);
    assert.deepEqual(counts.bySource, [{ source: "tiktok_videos", n: 1 }]);
    assert.equal(eligibleAssets(10).length, 1);
  });
});
