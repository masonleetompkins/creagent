import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";

describe("probeViaFfmpeg", () => {
  it("reads duration, size, fps, and audio presence without ffprobe", async () => {
    const { probeViaFfmpeg } = await import("../lib/media");
    const { ffmpegPath, ffprobePath } = await import("../lib/tools");
    if (!ffmpegPath() || !existsSync("/tmp/exp/main.mp4")) {
      console.log("skip: no ffmpeg or fixture");
      return;
    }
    if (ffprobePath()) {
      // Force the fallback path by testing the function directly.
      void 0;
    }
    const probe = probeViaFfmpeg("/tmp/exp/main.mp4");
    assert.ok(probe);
    assert.equal(probe.duration_ms, 12000);
    assert.equal(probe.width, 1080);
    assert.equal(probe.height, 1920);
    assert.equal(probe.fps, 30);
    assert.equal(probe.has_audio, true);
    const silent = probeViaFfmpeg("/tmp/exp/broll.mp4");
    assert.equal(silent?.has_audio, false);
  });
});
