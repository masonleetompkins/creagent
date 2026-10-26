// Media library: footage referenced in place (no copying) or uploaded.
// Metadata comes from ffprobe.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, extname, join } from "node:path";
import { getDb, nowIso } from "./db";
import { ffmpegPath, ffprobePath } from "./tools";

export const MAX_MEDIA_UPLOAD_BYTES = 500 * 1024 * 1024;

const VIDEO_EXTS = new Set([".mp4", ".mov", ".m4v", ".mkv", ".webm", ".avi"]);
const AUDIO_EXTS = new Set([".mp3", ".wav", ".m4a", ".aac", ".ogg", ".flac"]);
const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif", ".heic"]);

export function mediaDir(): string {
  const dir = join(homedir(), ".config", "creagent", "media");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export function kindForPath(path: string, mime = ""): "video" | "audio" | "image" | null {
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("image/")) return "image";
  const ext = extname(path).toLowerCase();
  if (VIDEO_EXTS.has(ext)) return "video";
  if (AUDIO_EXTS.has(ext)) return "audio";
  if (IMAGE_EXTS.has(ext)) return "image";
  return null;
}

export type ProbeResult = {
  duration_ms: number | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  has_audio: boolean;
};

// ffprobe fallback: static builds ship ffmpeg only. `ffmpeg -i` prints the
// same stream facts on stderr (and exits 1 with no outputs, which we expect).
export function probeViaFfmpeg(path: string): ProbeResult | null {
  const ffmpeg = ffmpegPath();
  if (!ffmpeg) return null;
  let stderr = "";
  try {
    execFileSync(ffmpeg, ["-hide_banner", "-i", path], {
      encoding: "utf8",
      timeout: 30000,
      maxBuffer: 1024 * 1024,
      stdio: ["ignore", "ignore", "pipe"],
    });
    return null;
  } catch (error) {
    stderr = String((error as { stderr?: unknown }).stderr ?? "");
    if (!stderr) return null;
  }
  const out: ProbeResult = {
    duration_ms: null,
    width: null,
    height: null,
    fps: null,
    has_audio: false,
  };
  const dur = stderr.match(/Duration: (\d+):(\d+):([\d.]+)/);
  if (dur) {
    out.duration_ms = Math.round(
      (Number(dur[1]) * 3600 + Number(dur[2]) * 60 + Number(dur[3])) * 1000,
    );
  }
  const video = stderr.match(/Stream #\d+:\d+[^:]*: Video:[^\n]*?(\d{3,5})x(\d{3,5})/);
  if (video) {
    out.width = Number(video[1]);
    out.height = Number(video[2]);
  }
  const fps = stderr.match(/(\d+(?:\.\d+)?)\s*(?:fps|tbr)/);
  if (fps) out.fps = Math.round(Number(fps[1]) * 100) / 100;
  out.has_audio = /Stream #\d+:\d+[^:]*: Audio:/.test(stderr);
  return out;
}

export function probeFile(path: string): ProbeResult {
  const out: ProbeResult = {
    duration_ms: null,
    width: null,
    height: null,
    fps: null,
    has_audio: false,
  };
  const ffprobe = ffprobePath();
  if (!ffprobe) return probeViaFfmpeg(path) ?? out;
  try {
    const raw = execFileSync(
      ffprobe,
      ["-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", path],
      { encoding: "utf8", timeout: 30000, maxBuffer: 4 * 1024 * 1024 },
    );
    const info = JSON.parse(raw) as {
      format?: { duration?: string };
      streams?: Array<{
        codec_type?: string;
        width?: number;
        height?: number;
        avg_frame_rate?: string;
        duration?: string;
      }>;
    };
    const streams = info.streams ?? [];
    const video = streams.find((s) => s.codec_type === "video");
    out.has_audio = streams.some((s) => s.codec_type === "audio");
    const dur = Number(info.format?.duration ?? video?.duration ?? NaN);
    if (Number.isFinite(dur)) out.duration_ms = Math.round(dur * 1000);
    if (video?.width) out.width = video.width;
    if (video?.height) out.height = video.height;
    if (video?.avg_frame_rate) {
      const [n, d] = video.avg_frame_rate.split("/").map(Number);
      if (Number.isFinite(n) && Number.isFinite(d) && d !== 0) {
        out.fps = Math.round((n / d) * 100) / 100;
      }
    }
  } catch {
    // Probe failures leave nulls; the file is still usable.
  }
  return out;
}

export type MediaAsset = {
  id: string;
  kind: string;
  path: string;
  filename: string;
  mime: string;
  duration_ms: number | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  has_audio: number;
  created_at: string;
};

function insertAsset(row: Omit<MediaAsset, "id" | "created_at">): MediaAsset {
  const full: MediaAsset = { ...row, id: randomUUID(), created_at: nowIso() };
  getDb()
    .prepare(
      `INSERT INTO media_assets
       (id, kind, path, filename, mime, duration_ms, width, height, fps, has_audio, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      full.id, full.kind, full.path, full.filename, full.mime, full.duration_ms,
      full.width, full.height, full.fps, full.has_audio, full.created_at,
    );
  return full;
}

export function registerLocalFile(absPath: string): MediaAsset {
  if (!absPath.startsWith("/")) throw new Error("path must be absolute");
  if (!existsSync(absPath) || !statSync(absPath).isFile()) {
    throw new Error("file does not exist");
  }
  const kind = kindForPath(absPath);
  if (!kind) throw new Error("unsupported media type");
  const probe = probeFile(absPath);
  return insertAsset({
    kind,
    path: absPath,
    filename: basename(absPath),
    mime: "application/octet-stream",
    duration_ms: probe.duration_ms,
    width: probe.width,
    height: probe.height,
    fps: probe.fps,
    has_audio: probe.has_audio ? 1 : 0,
  });
}

export async function saveMediaUpload(file: {
  name: string;
  type: string;
  size: number;
  arrayBuffer: () => Promise<ArrayBuffer>;
}): Promise<MediaAsset> {
  if (file.size > MAX_MEDIA_UPLOAD_BYTES) {
    throw new Error("file is over the 500MB upload cap (link large footage by path instead)");
  }
  const kind = kindForPath(file.name || "", file.type || "");
  if (!kind) throw new Error("unsupported media type");
  const buf = Buffer.from(await file.arrayBuffer());
  const ext = extname(file.name || "").replace(/[^a-zA-Z0-9.]/g, "").slice(0, 8);
  const id = randomUUID();
  const stored = join(mediaDir(), `${id}${ext}`);
  await writeFile(stored, buf);
  const probe = probeFile(stored);
  return insertAsset({
    kind,
    path: stored,
    filename: (file.name || "file").slice(0, 200),
    mime: file.type || "application/octet-stream",
    duration_ms: probe.duration_ms,
    width: probe.width,
    height: probe.height,
    fps: probe.fps,
    has_audio: probe.has_audio ? 1 : 0,
  });
}

export function listMedia(kind?: string): MediaAsset[] {
  if (kind) {
    return getDb()
      .prepare(`SELECT * FROM media_assets WHERE kind = ? ORDER BY created_at DESC LIMIT 200`)
      .all(kind) as MediaAsset[];
  }
  return getDb()
    .prepare(`SELECT * FROM media_assets ORDER BY created_at DESC LIMIT 200`)
    .all() as MediaAsset[];
}

export function getMedia(id: string): MediaAsset | null {
  return (
    (getDb().prepare(`SELECT * FROM media_assets WHERE id = ?`).get(id) as
      | MediaAsset
      | undefined) ?? null
  );
}
