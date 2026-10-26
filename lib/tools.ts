// Local video toolchain resolution. Binaries come from PATH first, then
// ~/.config/creagent/bin (populated by scripts/ensure-tools.sh).
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function toolsBinDir(): string {
  return process.env.CREAGENT_BIN ?? join(homedir(), ".config", "creagent", "bin");
}

export function modelsDir(): string {
  return process.env.CREAGENT_MODELS ?? join(homedir(), ".config", "creagent", "models");
}

function onPath(name: string): string | null {
  try {
    const found = execFileSync("command", ["-v", name], { encoding: "utf8" }).trim();
    return found || null;
  } catch {
    return null;
  }
}

function resolveBin(names: string[]): string | null {
  for (const name of names) {
    const viaPath = onPath(name);
    if (viaPath) return viaPath;
    const local = join(toolsBinDir(), name);
    if (existsSync(local)) return local;
  }
  return null;
}

export function ffmpegPath(): string | null {
  return resolveBin(["ffmpeg"]);
}

export function ffprobePath(): string | null {
  const probe = resolveBin(["ffprobe"]);
  if (probe) return probe;
  // Static ffmpeg zips ship ffprobe next to ffmpeg.
  const ff = ffmpegPath();
  if (ff) {
    const sibling = join(ff, "..", "ffprobe");
    if (existsSync(sibling)) return sibling;
  }
  return null;
}

export function whisperPath(): string | null {
  return resolveBin(["whisper-cli", "whisper-cpp"]);
}

export function whisperModelPath(): string | null {
  const p = join(modelsDir(), "ggml-large-v3-turbo.bin");
  return existsSync(p) ? p : null;
}

export function toolsStatus(): {
  ffmpeg: boolean;
  ffprobe: boolean;
  whisper: boolean;
  model: boolean;
} {
  return {
    ffmpeg: ffmpegPath() !== null,
    ffprobe: ffprobePath() !== null,
    whisper: whisperPath() !== null,
    model: whisperModelPath() !== null,
  };
}
