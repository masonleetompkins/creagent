// Hyperframes animated overlays: composition HTML staged per graphics clip,
// rendered once to transparent .mov (cached by hash), composited in export.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ffmpegPath, toolsBinDir } from "./tools";

export function hfDir(): string {
  const dir =
    process.env.CREAGENT_HF_DIR ?? join(homedir(), ".config", "creagent", "hyperframes");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

export type HfStageOptions = {
  width: number;
  height: number;
  durationMs: number;
  fps: number;
  quality?: string;
};

export function hfHash(html: string, opts: HfStageOptions): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        html,
        opts.width,
        opts.height,
        opts.durationMs,
        opts.fps,
        opts.quality ?? "standard",
      ]),
    )
    .digest("hex")
    .slice(0, 32);
}

export function cachedMov(hash: string): string {
  return join(hfDir(), `${hash}.mov`);
}

export function posterPath(hash: string): string {
  return join(hfDir(), `${hash}-poster.png`);
}

// Vendor GSAP beside staged projects so renders never depend on a CDN.
export function ensureGsap(): string | null {
  const dest = join(hfDir(), "gsap.min.js");
  if (existsSync(dest)) return dest;
  try {
    const res = spawnSync(
      "curl",
      ["-fsSL", "--max-time", "60", "https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js", "-o", dest],
      { timeout: 90000 },
    );
    if (res.status === 0 && existsSync(dest)) return dest;
  } catch {
    /* offline: leave CDN tags alone */
  }
  try {
    rmSync(dest, { force: true });
  } catch {
    /* ignore */
  }
  return null;
}

// Rewrite the standalone root's geometry/duration and point GSAP at the
// vendored copy. Pure string transform (unit-tested); gsapPath null keeps tags.
export function prepareComposition(
  html: string,
  opts: HfStageOptions,
  gsapPath: string | null,
): string {
  let out = html;
  const durSec = (opts.durationMs / 1000).toFixed(3).replace(/\.?0+$/, "");
  const rootOpen = out.match(/<div[^>]*data-composition-id[^>]*>/);
  if (rootOpen) {
    let tag = rootOpen[0];
    const setAttr = (name: string, value: string): void => {
      const re = new RegExp(`${name}="[^"]*"`);
      if (re.test(tag)) tag = tag.replace(re, `${name}="${value}"`);
      else tag = tag.replace(/>$/, ` ${name}="${value}">`);
    };
    setAttr("data-duration", durSec);
    setAttr("data-width", String(opts.width));
    setAttr("data-height", String(opts.height));
    out = out.replace(rootOpen[0], tag);
  }
  if (gsapPath) {
    out = out.replace(
      /<script\s+src="https:\/\/cdn\.jsdelivr\.net\/npm\/gsap@[^"]*\/dist\/gsap\.min\.js"><\/script>/g,
      `<script src="./gsap.min.js"></script>`,
    );
  }
  return out;
}

export function stageProject(html: string, opts: HfStageOptions): { dir: string; hash: string } {
  const hash = hfHash(html, opts);
  const dir = join(hfDir(), `stage-${hash}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const gsap = ensureGsap();
  writeFileSync(join(dir, "index.html"), prepareComposition(html, opts, gsap));
  if (gsap) {
    try {
      writeFileSync(join(dir, "gsap.min.js"), readFileSync(gsap));
    } catch {
      /* render falls back to CDN */
    }
  }
  return { dir, hash };
}

function hfEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  env.PATH = `${toolsBinDir()}:${process.env.PATH ?? ""}`;
  env.HYPERFRAMES_RUN_ID = process.env.HYPERFRAMES_RUN_ID ?? `creagent-${Date.now()}`;
  return env;
}

export function lintComposition(dir: string): { ok: boolean; errors: number; output: string } {
  try {
    const out = execFileSync("npx", ["-y", "hyperframes", "lint", "--json"], {
      cwd: dir,
      encoding: "utf8",
      timeout: 180000,
      maxBuffer: 4 * 1024 * 1024,
      env: hfEnv(),
    });
    const start = out.indexOf("{");
    const parsed = JSON.parse(out.slice(start)) as { ok?: unknown; errorCount?: unknown };
    return {
      ok: parsed.ok === true,
      errors: typeof parsed.errorCount === "number" ? parsed.errorCount : 1,
      output: out.slice(0, 2000),
    };
  } catch (error) {
    return { ok: false, errors: 1, output: String((error as Error).message).slice(0, 2000) };
  }
}

export function renderComposition(
  dir: string,
  outPath: string,
  fps: number,
  quality = "standard",
): void {
  const res = spawnSync(
    "npx",
    [
      "-y",
      "hyperframes",
      "render",
      dir,
      "--format",
      "mov",
      "--fps",
      String(fps),
      "--quality",
      quality,
      "-o",
      outPath,
    ],
    { encoding: "utf8", timeout: 30 * 60 * 1000, maxBuffer: 16 * 1024 * 1024, env: hfEnv() },
  );
  if (res.status !== 0 || !existsSync(outPath)) {
    const tail = `${res.stderr ?? ""}\n${res.stdout ?? ""}`.slice(-1500);
    throw new Error(`hyperframes render failed: ${tail}`);
  }
}

// Render once per unique composition; later exports reuse the cached .mov.
export function renderHyperframes(html: string, opts: HfStageOptions): string {
  const hash = hfHash(html, opts);
  const out = cachedMov(hash);
  if (existsSync(out)) return out;
  const { dir } = stageProject(html, opts);
  try {
    renderComposition(dir, out, opts.fps, opts.quality ?? "standard");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return out;
}

export function extractPoster(movPath: string, hash: string): string {
  const ffmpeg = ffmpegPath();
  if (!ffmpeg) throw new Error("ffmpeg is missing (run scripts/ensure-tools.sh)");
  const poster = posterPath(hash);
  execFileSync(ffmpeg, ["-y", "-v", "error", "-ss", "0.5", "-i", movPath, "-frames:v", "1", poster], {
    timeout: 60000,
  });
  return poster;
}
