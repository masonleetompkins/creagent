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

  it("reads the Instagram items shape (live probe)", async () => {
    const { parseTranscript } = await import("../lib/transcript-backfill");
    assert.deepEqual(
      parseTranscript({
        found: true,
        data: {
          items: [
            {
              shortcode: "Dc4A15nSDli",
              text: "Explain like I'm five. AI agents.",
              source: "audio_asr",
              segments: [{ text: "Explain like I'm five.", start: 0.16, end: 1.12 }],
            },
          ],
        },
      }),
      { text: "Explain like I'm five. AI agents." },
    );
    assert.deepEqual(
      parseTranscript({
        data: { items: [{ segments: [{ text: "a" }, { text: "b" }] }] },
      }),
      { text: "a b" },
    );
    assert.deepEqual(parseTranscript({ items: [{ text: "top-level items" }] }), {
      text: "top-level items",
    });
    assert.equal(parseTranscript({ data: { items: [{ views: 3 }] } }), null);
    assert.equal(parseTranscript({ data: { items: [] } }), null);
  });
});

describe("photo guards + empty strikes", () => {
  it("spots photo posts by url and raw markers", async () => {
    const { isPhotoUrl, isPhotoRaw } = await import("../lib/transcript-backfill");
    assert.equal(isPhotoUrl("tiktok_videos", "https://www.tiktok.com/@u/photo/123"), true);
    assert.equal(isPhotoUrl("tiktok_videos", "https://www.tiktok.com/@u/video/123"), false);
    assert.equal(isPhotoUrl("x_posts", "https://www.tiktok.com/@u/photo/123"), false);
    assert.equal(isPhotoRaw({ productType: "carousel_container" }), true);
    assert.equal(isPhotoRaw({ productType: "feed" }), true);
    assert.equal(isPhotoRaw({ mediaType: "photo" }), true);
    assert.equal(isPhotoRaw({ productType: "carousel_container", durationSeconds: 10 }), false);
    assert.equal(isPhotoRaw({ productType: "clips", durationSeconds: 89 }), false);
    assert.equal(isPhotoRaw({ productType: "clips" }), false);
    assert.equal(isPhotoRaw(null), false);
    assert.equal(isPhotoRaw({}), false);
  });

  it("counts clean-empty results per asset", async () => {
    const { storeAsset } = await import("../lib/ingest");
    const { noteEmptyResult } = await import("../lib/transcript-backfill");
    const { getDb } = await import("../lib/db");
    const db = getDb();
    storeAsset(db, {
      source: "tiktok_videos",
      sourceUrl: "https://tiktok.com/@u/video/9",
      title: "v9",
      transcript: "",
      metadata: {},
      postedAt: null,
      isReply: false,
      isVideo: true,
      transcribedAt: "2026-01-01T00:00:00.000Z",
    });
    const row = db
      .prepare(`SELECT id FROM assets WHERE source_url = ?`)
      .get("https://tiktok.com/@u/video/9") as { id: string };
    assert.equal(noteEmptyResult(db, row.id), 1);
    assert.equal(noteEmptyResult(db, row.id), 2);
    const meta = db.prepare(`SELECT metadata FROM assets WHERE id = ?`).get(row.id) as {
      metadata: string;
    };
    assert.equal((JSON.parse(meta.metadata) as { transcript_empty_hits: number }).transcript_empty_hits, 2);
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
