import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.CREAGENT_HF_DIR = mkdtempSync(join(tmpdir(), "creagent-hf-"));

const COMP = `<!doctype html><html><body><div data-composition-id="main" data-width="1920" data-height="1080" data-duration="9"><p>hi</p></div><script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script></body></html>`;

describe("hyperframes staging", () => {
  it("hashes composition renders stably", async () => {
    const { hfHash } = await import("../lib/hyperframes");
    const opts = { width: 1080, height: 1920, durationMs: 3000, fps: 30 };
    assert.equal(hfHash(COMP, opts), hfHash(COMP, opts));
    assert.notEqual(hfHash(COMP, opts), hfHash(COMP, { ...opts, durationMs: 4000 }));
  });

  it("rewrites root geometry and vendors gsap", async () => {
    const { prepareComposition } = await import("../lib/hyperframes");
    const out = prepareComposition(
      COMP,
      { width: 1080, height: 1920, durationMs: 2500, fps: 30 },
      "/x/gsap.min.js",
    );
    assert.match(out, /data-duration="2.5"/);
    assert.match(out, /data-width="1080"/);
    assert.match(out, /data-height="1920"/);
    assert.match(out, /<script src="\.\/gsap\.min\.js"><\/script>/);
  });

  it("leaves CDN tags alone when gsap is unavailable", async () => {
    const { prepareComposition } = await import("../lib/hyperframes");
    const out = prepareComposition(
      COMP,
      { width: 1080, height: 1920, durationMs: 2500, fps: 30 },
      null,
    );
    assert.match(out, /cdn\.jsdelivr\.net/);
  });

  it("stages a lint-clean project directory", async () => {
    const { stageProject } = await import("../lib/hyperframes");
    const { readFileSync, existsSync } = await import("node:fs");
    const { dir, hash } = stageProject(COMP, {
      width: 1080,
      height: 1920,
      durationMs: 3000,
      fps: 30,
    });
    assert.equal(hash.length, 32);
    assert.ok(existsSync(join(dir, "index.html")));
    assert.match(readFileSync(join(dir, "index.html"), "utf8"), /data-duration="3"/);
  });
});

describe("hyperframes lint gate", () => {
  it("passes the real CLI lint on a minimal overlay", async () => {
    const { stageProject, lintComposition } = await import("../lib/hyperframes");
    const comp = `<!doctype html>
<html lang="en"><head><meta charset="UTF-8" />
<script src="./gsap.min.js"></script>
<style>body{margin:0;background:transparent}#root{position:relative;width:1080px;height:1920px;overflow:hidden;background:transparent}.clip{position:absolute;inset:0}#box{position:absolute;top:800px;left:0;width:300px;height:300px;background:#ff2233}</style>
</head><body>
<div id="root" data-composition-id="main" data-start="0" data-width="1080" data-height="1920" data-duration="3">
<section id="slide" class="clip" data-start="0" data-duration="3"><div id="box"></div></section>
</div>
<script>
const tl = gsap.timeline({ paused: true });
tl.fromTo("#box", { x: 0 }, { x: 780, duration: 2.6, ease: "power2.inOut" }, 0.2);
window.__timelines["main"] = tl;
</script>
</body></html>`;
    const { dir } = stageProject(comp, { width: 1080, height: 1920, durationMs: 3000, fps: 30 });
    const result = lintComposition(dir);
    assert.equal(result.errors, 0);
    assert.equal(result.ok, true);
  });
});
