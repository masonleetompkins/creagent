// H.264 export: timeline -> ffmpeg filtergraph. planExport reads the DB,
// buildSrt + buildFfmpegArgs are pure (unit-tested), runExport shells out.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getDb, nowIso } from "./db";
import { BODY_FONTS, HEADING_FONTS, fontById } from "./fonts";
import { renderHyperframes } from "./hyperframes";
import { ffmpegPath } from "./tools";

export type ExportClip = {
  assetPath: string;
  assetKind: string;
  hasAudio: boolean;
  start_ms: number;
  duration_ms: number;
  in_ms: number;
};

export type ExportGraphic = {
  start_ms: number;
  end_ms: number;
  text: string;
  y_pct: number;
  fontsize: number;
  color: string;
  box: boolean;
};

export type ExportCaption = { start_ms: number; end_ms: number; lines: string[] };

export type ExportPlan = {
  projectId: string;
  width: number;
  height: number;
  fps: number;
  duration_ms: number;
  style: { caption_font: string; heading_font: string };
  videoTracks: ExportClip[][];
  audioTracks: ExportClip[][];
  mainAudio: ExportClip[];
  captions: ExportCaption[];
  graphics: ExportGraphic[];
  hyperframes: { start_ms: number; end_ms: number; html: string }[];
};

export function exportsDir(): string {
  const dir = join(homedir(), ".config", "creagent", "exports");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

export function fontsDir(): string {
  const dir = join(homedir(), ".config", "creagent", "fonts");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

// Static ffmpeg builds ship no fontconfig configuration, which makes libass
// (caption burn-in) render nothing and drawtext font matching fail. Write a
// minimal config pointing at the system font dirs and hand it to ffmpeg.
export function ensureFontconfig(): string {
  if (process.env.FONTCONFIG_FILE && existsSync(process.env.FONTCONFIG_FILE)) {
    return process.env.FONTCONFIG_FILE;
  }
  const dir = fontsDir();
  const cache = join(dir, "cache");
  if (!existsSync(cache)) mkdirSync(cache, { recursive: true });
  const conf = join(dir, "fonts.conf");
  writeFileSync(
    conf,
    `<?xml version="1.0"?>\n<!DOCTYPE fontconfig SYSTEM "fonts.dtd">\n<fontconfig>\n` +
      `  <dir>/System/Library/Fonts</dir>\n  <dir>/Library/Fonts</dir>\n` +
      `  <dir>~/Library/Fonts</dir>\n  <dir>/usr/share/fonts</dir>\n` +
      `  <dir>~/.fonts</dir>\n  <dir>${dir}</dir>\n` +
      `  <cachedir>${cache}</cachedir>\n  <config><rescan><int>30</int></rescan></config>\n</fontconfig>\n`,
  );
  return conf;
}

export function parseStyle(raw: string): { caption_font: string; heading_font: string } {
  try {
    const s = JSON.parse(raw) as { caption_font?: unknown; heading_font?: unknown };
    return {
      caption_font: typeof s.caption_font === "string" ? s.caption_font : "system",
      heading_font: typeof s.heading_font === "string" ? s.heading_font : "system-black",
    };
  } catch {
    return { caption_font: "system", heading_font: "system-black" };
  }
}

export function planExport(projectId: string): ExportPlan {
  const db = getDb();
  const project = db
    .prepare(`SELECT id, width, height, fps, style FROM video_projects WHERE id = ?`)
    .get(projectId) as
    | { id: string; width: number; height: number; fps: number; style: string }
    | undefined;
  if (!project) throw new Error("project not found");
  const tracks = db
    .prepare(`SELECT id, kind, name FROM video_tracks WHERE project_id = ? ORDER BY position ASC`)
    .all(projectId) as { id: string; kind: string; name: string }[];
  const clipRows = db
    .prepare(
      `SELECT c.track_id, c.start_ms, c.duration_ms, c.in_ms, c.payload,
              a.path AS asset_path, a.kind AS asset_kind, a.has_audio
       FROM video_clips c JOIN video_tracks t ON t.id = c.track_id
       LEFT JOIN media_assets a ON a.id = c.asset_id
       WHERE t.project_id = ? ORDER BY t.position ASC, c.start_ms ASC`,
    )
    .all(projectId) as {
    track_id: string;
    start_ms: number;
    duration_ms: number;
    in_ms: number;
    payload: string;
    asset_path: string | null;
    asset_kind: string | null;
    has_audio: number | null;
  }[];

  const videoTracks: ExportClip[][] = [];
  const audioTracks: ExportClip[][] = [];
  const graphics: ExportGraphic[] = [];
  const hyperframes: { start_ms: number; end_ms: number; html: string }[] = [];
  let mainTrackId: string | null = null;
  const videoIds = tracks.filter((t) => t.kind === "video").map((t) => t.id);
  const main = tracks.find((t) => t.kind === "video" && t.name === "Main");
  mainTrackId = main?.id ?? videoIds[videoIds.length - 1] ?? null;

  for (const track of tracks) {
    const rows = clipRows.filter((c) => c.track_id === track.id);
    if (track.kind === "graphics") {
      for (const c of rows) {
        try {
          const p = JSON.parse(c.payload) as {
            kind?: unknown;
            html?: unknown;
            text?: unknown;
            y_pct?: unknown;
            fontsize?: unknown;
            color?: unknown;
            box?: unknown;
          };
          if (p.kind === "hyperframes" && typeof p.html === "string" && p.html.trim()) {
            hyperframes.push({
              start_ms: c.start_ms,
              end_ms: c.start_ms + c.duration_ms,
              html: p.html,
            });
            continue;
          }
          if (typeof p.text === "string" && p.text.trim()) {
            graphics.push({
              start_ms: c.start_ms,
              end_ms: c.start_ms + c.duration_ms,
              text: p.text.slice(0, 500),
              y_pct: typeof p.y_pct === "number" ? p.y_pct : 12,
              fontsize: typeof p.fontsize === "number" ? p.fontsize : 72,
              color: typeof p.color === "string" ? p.color : "white",
              box: p.box !== false,
            });
          }
        } catch {
          /* not a text card */
        }
      }
      continue;
    }
    if (track.kind !== "video" && track.kind !== "audio") continue;
    const clips: ExportClip[] = [];
    for (const c of rows) {
      if (!c.asset_path || !existsSync(c.asset_path)) continue;
      clips.push({
        assetPath: c.asset_path,
        assetKind: c.asset_kind ?? "video",
        hasAudio: (c.has_audio ?? 0) === 1,
        start_ms: c.start_ms,
        duration_ms: c.duration_ms,
        in_ms: c.in_ms,
      });
    }
    if (track.kind === "video") videoTracks.push(clips);
    else audioTracks.push(clips);
  }
  const mainAudio =
    mainTrackId === null
      ? []
      : (clipRows
          .filter((c) => c.track_id === mainTrackId)
          .filter((c) => c.asset_path && existsSync(c.asset_path) && (c.has_audio ?? 0) === 1)
          .map((c) => ({
            assetPath: c.asset_path as string,
            assetKind: c.asset_kind ?? "video",
            hasAudio: true,
            start_ms: c.start_ms,
            duration_ms: c.duration_ms,
            in_ms: c.in_ms,
          })) as ExportClip[]);

  let duration_ms = 0;
  for (const list of [...videoTracks, ...audioTracks]) {
    for (const c of list) duration_ms = Math.max(duration_ms, c.start_ms + c.duration_ms);
  }
  if (duration_ms <= 0) throw new Error("nothing on the timeline to export");

  const capRows = db
    .prepare(
      `SELECT start_ms, end_ms, lines FROM captions
       WHERE project_id = ? AND enabled = 1 ORDER BY start_ms ASC`,
    )
    .all(projectId) as { start_ms: number; end_ms: number; lines: string }[];
  const captions: ExportCaption[] = capRows.map((r) => {
    let lines: string[] = [];
    try {
      const parsed = JSON.parse(r.lines) as Array<string | { text?: unknown }>;
      lines = parsed.map((l) => (typeof l === "string" ? l : String(l?.text ?? ""))).filter(Boolean);
    } catch {
      /* skip */
    }
    return { start_ms: r.start_ms, end_ms: r.end_ms, lines };
  }).filter((c) => c.lines.length > 0);

  return {
    projectId,
    width: project.width,
    height: project.height,
    fps: project.fps,
    duration_ms,
    style: parseStyle(project.style),
    videoTracks,
    audioTracks,
    mainAudio,
    captions,
    graphics,
    hyperframes,
  };
}

function srtTime(ms: number): string {
  const t = Math.max(0, Math.round(ms));
  const h = Math.floor(t / 3600000);
  const m = Math.floor((t % 3600000) / 60000);
  const s = Math.floor((t % 60000) / 1000);
  const milli = t % 1000;
  const pad = (n: number, w: number): string => String(n).padStart(w, "0");
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)},${pad(milli, 3)}`;
}

export function buildSrt(captions: ExportCaption[]): string {
  return (
    captions
      .map((c, i) => {
        const text = c.lines
          .map((l) => l.replace(/</g, "&lt;").replace(/>/g, "&gt;"))
          .join("\n");
        return `${i + 1}\n${srtTime(c.start_ms)} --> ${srtTime(c.end_ms)}\n${text}`;
      })
      .join("\n\n") + (captions.length > 0 ? "\n" : "")
  );
}

// Best-effort TTF/OTF for a font face id (carousel catalog ids double as
// export names). Falls back to fontconfig (font=) when no file matches.
export function resolveExportFont(face: string): { fontfile: string | null; font: string } {
  const dirs = [
    join(homedir(), ".config", "creagent", "fonts"),
    join(homedir(), "Library", "Fonts"),
    "/Library/Fonts",
    "/System/Library/Fonts",
    join(homedir(), ".fonts"),
    "/usr/share/fonts",
  ];
  const needle = face.toLowerCase().replace(/[^a-z0-9]+/g, "");
  const walk = (dir: string, depth: number): string | null => {
    if (depth > 3) return null;
    try {
      const names = readdirSync(dir);
      for (const name of names) {
        const full = join(dir, name);
        if (/\.(ttf|otf|ttc)$/i.test(name)) {
          const norm = name.toLowerCase().replace(/[^a-z0-9]+/g, "");
          if (needle && norm.includes(needle)) return full;
        }
      }
      if (depth < 2) {
        for (const name of names) {
          const full = join(dir, name);
          try {
            if (!/\.(ttf|otf|ttc)$/i.test(name)) {
              const hit = walk(full, depth + 1);
              if (hit) return hit;
            }
          } catch {
            /* skip */
          }
        }
      }
    } catch {
      return null;
    }
    return null;
  };
  for (const dir of dirs) {
    const hit = walk(dir, 0);
    if (hit) return { fontfile: hit, font: face };
  }
  return { fontfile: null, font: face };
}

function escDrawtext(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/:/g, "\\:").replace(/\n/g, " ");
}

export type BuiltExport = { args: string[]; inputCount: number; filter: string };

export function buildFfmpegArgs(
  plan: ExportPlan,
  srtPath: string | null,
  outPath: string,
  options?: {
    burnCaptions?: boolean;
    fontfile?: string | null;
    headingFace?: string;
    captionFace?: string;
    hyperframes?: { path: string; start_ms: number; end_ms: number }[];
  },
): BuiltExport {
  const burn = options?.burnCaptions !== false && srtPath !== null && plan.captions.length > 0;
  const args: string[] = ["-y"];
  const sec = (ms: number): string => (ms / 1000).toFixed(3);
  // One input per clip with -ss/-t seeking (images looped).
  const allVideo: ExportClip[][] = plan.videoTracks;
  const allAudio: ExportClip[][] = [...plan.audioTracks, ...(plan.mainAudio.length > 0 ? [plan.mainAudio] : [])];
  const register = (clip: ExportClip): number => {
    const idx = args.filter((a) => a === "-i").length;
    if (clip.assetKind === "image") {
      args.push("-loop", "1", "-t", sec(clip.duration_ms), "-i", clip.assetPath);
    } else {
      args.push("-ss", sec(clip.in_ms), "-t", sec(clip.duration_ms), "-i", clip.assetPath);
    }
    return idx;
  };
  const vSegs: { input: number; clip: ExportClip }[][] = allVideo.map((track) =>
    track.map((clip) => ({ input: register(clip), clip })),
  );
  const aSegs: { input: number; clip: ExportClip }[][] = allAudio.map((track) =>
    track.map((clip) => ({ input: register(clip), clip })),
  );
  const hfInputs: { input: number; start_ms: number; end_ms: number }[] = [];
  for (const hf of options?.hyperframes ?? []) {
    const idx = args.filter((a) => a === "-i").length;
    args.push("-i", hf.path);
    hfInputs.push({ input: idx, start_ms: hf.start_ms, end_ms: hf.end_ms });
  }

  const filters: string[] = [];
  const W = plan.width;
  const H = plan.height;
  // Video tracks: scale segments, fill gaps with black, concat, pad to full duration.
  const vLabels: string[] = [];
  vSegs.forEach((segs, ti) => {
    // Base (lowest) track fills gaps with black; overlay tracks above it must
    // fill with transparency or they would hide the base where empty.
    const isBase = ti === vSegs.length - 1;
    const filler = (d: string, label: string): string =>
      isBase
        ? `color=black:size=${W}x${H}:rate=${plan.fps}:duration=${d}[${label}]`
        : `color=black@0:size=${W}x${H}:rate=${plan.fps}:duration=${d},format=rgba[${label}]`;
    let cursor = 0;
    const concatInputs: string[] = [];
    segs.forEach((s, si) => {
      if (s.clip.start_ms > cursor) {
        filters.push(filler(sec(s.clip.start_ms - cursor), `vg${ti}_${si}`));
        concatInputs.push(`[vg${ti}_${si}]`);
      }
      filters.push(
        `[${s.input}:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1,fps=${plan.fps}${isBase ? "" : ",format=rgba"}[vv${ti}_${si}]`,
      );
      concatInputs.push(`[vv${ti}_${si}]`);
      cursor = s.clip.start_ms + s.clip.duration_ms;
    });
    if (cursor < plan.duration_ms) {
      filters.push(filler(sec(plan.duration_ms - cursor), `vg${ti}_tail`));
      concatInputs.push(`[vg${ti}_tail]`);
    }
    if (concatInputs.length === 0) {
      filters.push(filler(sec(plan.duration_ms), `vtrack${ti}`));
    } else if (concatInputs.length === 1) {
      filters.push(`${concatInputs[0]}null[vtrack${ti}]`);
    } else {
      filters.push(`${concatInputs.join("")}concat=n=${concatInputs.length}:v=1:a=0[vtrack${ti}]`);
    }
    vLabels.push(`[vtrack${ti}]`);
  });
  if (vLabels.length === 0) {
    filters.push(
      `color=black:size=${W}x${H}:rate=${plan.fps}:duration=${sec(plan.duration_ms)}[vtrack0]`,
    );
    vLabels.push("[vtrack0]");
  }
  // Stack tracks: position 0 is top, so overlay from the bottom up.
  let vcur = vLabels[vLabels.length - 1];
  for (let i = vLabels.length - 2; i >= 0; i--) {
    const out = i === 0 ? "[vstack]" : `[vtmp${i}]`;
    filters.push(`${vcur}${vLabels[i]}overlay=0:0:eof_action=pass${out}`);
    vcur = out;
  }
  // Text graphics.
  let gidx = 0;
  const gfxFont = options?.fontfile
    ? `fontfile='${options.fontfile.replace(/'/g, "\\'")}':`
    : options?.headingFace
      ? `font='${options.headingFace.replace(/'/g, "\\'")}':`
      : "";
  for (const g of plan.graphics) {
    const out = `[vgfx${gidx++}]`;
    const y = `(h-text_h)*${(g.y_pct / 100).toFixed(3)}`;
    filters.push(
      `${vcur}drawtext=${gfxFont}text='${escDrawtext(g.text)}':fontsize=${g.fontsize}:fontcolor=${g.color}:x=(w-text_w)/2:y=${y}:box=${g.box ? 1 : 0}:boxcolor=black@0.6:enable='between(t,${sec(g.start_ms)},${sec(g.end_ms)})'${out}`,
    );
    vcur = out;
  }
  // Hyperframes overlays: offset each render so its t=0 lands on the
  // clip start, then window it. eof_action=pass keeps the base after it ends.
  hfInputs.forEach((hf, i) => {
    const a = sec(hf.start_ms);
    const b = sec(hf.end_ms);
    filters.push(`[${hf.input}:v]format=rgba,setpts=PTS-STARTPTS+${a}/TB[hf${i}]`);
    const out = `[vhf${i}]`;
    filters.push(`${vcur}[hf${i}]overlay=0:0:enable='between(t,${a},${b})':eof_action=pass${out}`);
    vcur = out;
  });
  // Captions burn-in. PlayRes must match the frame or libass scales
  // FontSize/MarginV from its tiny default (384x288) and shoves text off-screen.
  if (burn && srtPath) {
    const fontName = (options?.captionFace ?? "Arial").replace(/'/g, "");
    const size = Math.round(plan.height * 0.045);
    const marginV = Math.round(plan.height * 0.18);
    filters.push(
      `${vcur}subtitles='${srtPath.replace(/'/g, "\\'")}':force_style='FontName=${fontName},FontSize=${size},Alignment=2,MarginV=${marginV},Outline=2,Shadow=0,PlayResX=${W},PlayResY=${H}'[vout]`,
    );
    vcur = "[vout]";
  } else if (vcur !== "[vout]") {
    filters.push(`${vcur}null[vout]`);
    vcur = "[vout]";
  }
  // Audio tracks: per-track concat with silence gaps, then mix.
  const aLabels: string[] = [];
  aSegs.forEach((segs, ti) => {
    const parts: string[] = [];
    let cursor = 0;
    segs.forEach((s, si) => {
      if (s.clip.start_ms > cursor) {
        filters.push(
          `aevalsrc=0:duration=${sec(s.clip.start_ms - cursor)}:sample_rate=44100[ag${ti}_${si}]`,
        );
        parts.push(`[ag${ti}_${si}]`);
      }
      filters.push(`[${s.input}:a]aresample=44100,aformat=channel_layouts=stereo[aa${ti}_${si}]`);
      parts.push(`[aa${ti}_${si}]`);
      cursor = s.clip.start_ms + s.clip.duration_ms;
    });
    if (cursor < plan.duration_ms) {
      filters.push(
        `aevalsrc=0:duration=${sec(plan.duration_ms - cursor)}:sample_rate=44100[ag${ti}_tail]`,
      );
      parts.push(`[ag${ti}_tail]`);
    }
    if (parts.length === 0) return;
    if (parts.length === 1) {
      filters.push(`${parts[0]}anull,aformat=sample_rates=44100:channel_layouts=stereo[atrack${ti}]`);
    } else {
      filters.push(
        `${parts.join("")}concat=n=${parts.length}:v=0:a=1,aformat=sample_rates=44100:channel_layouts=stereo[atrack${ti}]`,
      );
    }
    aLabels.push(`[atrack${ti}]`);
  });
  if (aLabels.length > 1) {
    filters.push(`${aLabels.join("")}amix=inputs=${aLabels.length}:duration=longest[aout]`);
  } else if (aLabels.length === 1) {
    filters.push(`${aLabels[0]}anull[aout]`);
  }
  const filter = filters.join(";");
  args.push("-filter_complex", filter, "-map", "[vout]");
  if (aLabels.length > 0) {
    args.push("-map", "[aout]", "-c:a", "aac", "-b:a", "160k");
  }
  args.push(
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "18",
    "-pix_fmt",
    "yuv420p",
    "-r",
    String(plan.fps),
    "-t",
    sec(plan.duration_ms),
    "-movflags",
    "+faststart",
    outPath,
  );
  return { args, inputCount: args.filter((a) => a === "-i").length, filter };
}

export type ExportResult = { path: string; exportId: string };

export async function runExport(
  projectId: string,
  options?: { burnCaptions?: boolean; onStage?: (stage: string) => void },
): Promise<ExportResult> {
  const ffmpeg = ffmpegPath();
  if (!ffmpeg) throw new Error("ffmpeg is missing (run scripts/ensure-tools.sh)");
  options?.onStage?.("planning");
  const plan = planExport(projectId);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outPath = join(exportsDir(), `${projectId}-${stamp}.mp4`);
  let srtPath: string | null = null;
  if (plan.captions.length > 0 && options?.burnCaptions !== false) {
    srtPath = join(exportsDir(), `${projectId}-${stamp}.srt`);
    writeFileSync(srtPath, buildSrt(plan.captions));
  }
  const headingFace = fontById(HEADING_FONTS, plan.style.heading_font).face;
  const captionFace = fontById(BODY_FONTS, plan.style.caption_font).face;
  const gfxFont = resolveExportFont(headingFace);
  if (plan.hyperframes.length > 0) options?.onStage?.("graphics");
  const hfRenders = plan.hyperframes.map((hf) => ({
    path: renderHyperframes(hf.html, {
      width: plan.width,
      height: plan.height,
      fps: plan.fps,
      durationMs: hf.end_ms - hf.start_ms,
    }),
    start_ms: hf.start_ms,
    end_ms: hf.end_ms,
  }));
  const { args } = buildFfmpegArgs(plan, srtPath, outPath, {
    burnCaptions: options?.burnCaptions,
    fontfile: gfxFont.fontfile,
    headingFace,
    captionFace,
    hyperframes: hfRenders,
  });
  options?.onStage?.("rendering");
  const logPath = join(exportsDir(), `${projectId}-${stamp}.log`);
  const fontconfig = ensureFontconfig();
  await new Promise<void>((resolve, reject) => {
    const child = spawn(ffmpeg, args, {
      stdio: ["ignore", "ignore", "pipe"],
      env: { ...process.env, FONTCONFIG_FILE: fontconfig },
    });
    let stderr = "";
    child.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString();
      if (stderr.length > 20000) stderr = stderr.slice(-20000);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      writeFileSync(logPath, stderr.slice(-20000));
      if (code === 0 && existsSync(outPath)) resolve();
      else reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-800)}`));
    });
  });
  options?.onStage?.("saving");
  const id = randomUUID();
  getDb()
    .prepare(
      `INSERT INTO video_exports (id, project_id, path, width, height, fps, captions, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, projectId, outPath, plan.width, plan.height, plan.fps, srtPath ? 1 : 0, nowIso());
  return { path: outPath, exportId: id };
}

export function listExports(projectId: string): {
  id: string;
  path: string;
  width: number;
  height: number;
  created_at: string;
}[] {
  return getDb()
    .prepare(
      `SELECT id, path, width, height, created_at FROM video_exports
       WHERE project_id = ? ORDER BY created_at DESC`,
    )
    .all(projectId) as {
    id: string;
    path: string;
    width: number;
    height: number;
    created_at: string;
  }[];
}
