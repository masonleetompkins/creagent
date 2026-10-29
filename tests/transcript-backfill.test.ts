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
