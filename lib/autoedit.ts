// Agent video autonomy: approved script + attached footage -> rough cut.
// For each new video attachment on the slot: register, transcribe, auto-cut
// takes against the script, lay keeps on the Main track, then generate
// captions for the fresh cut. Slot goes orange for user review.
import { randomUUID } from "node:crypto";
import { getDb, nowIso } from "./db";
import { detectTakes, saveTakes } from "./autocut";
import { clearCaptions, generateCaptions } from "./captions";
import { resolveSlotOutline } from "./carousel-plan";
import { registerLocalFile } from "./media";
import { detectSilences, getTranscript, runTranscription, type Silence, type Word } from "./transcribe";
import { attachmentPath, listAttachments } from "./uploads";
import { addClip, addTrack } from "./video";

export const VIDEO_SLOT_TYPES = ["video_trend", "video_series", "video_yap", "long_video", "clip"];

export type AutoEditResult = {
  slotId: string;
  projectId: string;
  assets: number;
  clips: number;
  takes: number;
};

export function findOrCreateVideoProject(slotId: string, title: string): string {
  const db = getDb();
  const existing = db
    .prepare(`SELECT id FROM video_projects WHERE slot_id = ? ORDER BY created_at ASC LIMIT 1`)
    .get(slotId) as { id: string } | undefined;
  if (existing) return existing.id;
  const id = randomUUID();
  const ts = nowIso();
  db.prepare(
    `INSERT INTO video_projects (id, slot_id, title, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(id, slotId, title, ts, ts);
  return id;
}

function mainTrackId(projectId: string): string {
  const db = getDb();
  const main = db
    .prepare(
      `SELECT id FROM video_tracks WHERE project_id = ? AND kind = 'video'
       ORDER BY CASE WHEN name = 'Main' THEN 0 ELSE 1 END, position ASC LIMIT 1`,
    )
    .get(projectId) as { id: string } | undefined;
  if (main) return main.id;
  return addTrack(projectId, "video", "Main").id;
}

function assetOnTimeline(projectId: string, assetId: string): boolean {
  const hit = getDb()
    .prepare(
      `SELECT c.id FROM video_clips c JOIN video_tracks t ON t.id = c.track_id
       WHERE t.project_id = ? AND c.asset_id = ? LIMIT 1`,
    )
    .get(projectId, assetId) as { id: string } | undefined;
  return !!hit;
}

export async function runSlotAutoEdit(
  slotId: string,
  onStage?: (stage: string, label: string) => void,
): Promise<AutoEditResult> {
  const db = getDb();
  const slot = db
    .prepare(`SELECT id, content_type, scheduled_at FROM queue_slots WHERE id = ?`)
    .get(slotId) as { id: string; content_type: string; scheduled_at: string } | undefined;
  if (!slot) throw new Error("slot not found");
  if (!VIDEO_SLOT_TYPES.includes(slot.content_type)) {
    throw new Error("auto-edit needs a video slot");
  }
  const footage = listAttachments(slotId).filter((a) => a.kind === "video");
  if (footage.length === 0) throw new Error("attach footage to the slot first");
  const date = new Date(slot.scheduled_at).toLocaleDateString();
  const projectId = findOrCreateVideoProject(slotId, `Video — ${slot.content_type} — ${date}`);
  const trackId = mainTrackId(projectId);

  // The approved script steers take selection; a missing/failed lookup
  // just means no script check, never a failed cut.
  let script = "";
  try {
    script = resolveSlotOutline(slotId);
  } catch {
    script = "";
  }

  let assets = 0;
  let clips = 0;
  let takes = 0;
  let done = 0;
  const captioned: Array<{ assetId: string; words: Word[] }> = [];
  for (const file of footage) {
    const disk = attachmentPath(file.id);
    if (!disk) continue;
    const existing = db
      .prepare(`SELECT id FROM media_assets WHERE path = ?`)
      .get(disk) as { id: string } | undefined;
    const asset = existing ?? registerLocalFile(disk);
    if (assetOnTimeline(projectId, asset.id)) continue;
    assets++;
    done++;
    onStage?.("transcribe", `Transcribing ${file.filename} (${done}/${footage.length})`);
    await runTranscription(asset.id);
    onStage?.("takes", `Detecting takes in ${file.filename}`);
    const { transcript, words } = getTranscript(asset.id);
    // Measured pauses steer sentence splits and silence cuts — best
    // effort, the word-timing heuristics still run without them.
    let silences: Silence[] = [];
    try {
      silences = detectSilences(disk);
    } catch {
      silences = [];
    }
    const detected = transcript ? saveTakes(transcript.id, detectTakes(words, { script, silences })) : [];
    const kept = detected.filter((t) => t.verdict === "keep");
    takes += kept.length > 0 ? kept.length : 0;
    onStage?.("timeline", "Laying keeps on the Main track");
    if (kept.length > 0) {
      kept.forEach((t) => {
        addClip({
          trackId,
          assetId: asset.id,
          name: t.label,
          inMs: t.start_ms,
          durationMs: Math.max(1, t.end_ms - t.start_ms),
        });
        clips++;
      });
    } else {
      const fallback =
        words.length > 0 ? words[words.length - 1].end_ms : 10000;
      addClip({ trackId, assetId: asset.id, name: file.filename, inMs: 0, durationMs: fallback });
      clips++;
    }
    captioned.push({ assetId: asset.id, words });
  }
  // Fresh cut, fresh captions: replace any stale blocks, then caption each
  // newly cut asset from its transcript mapped onto the timeline.
  if (captioned.length > 0) {
    onStage?.("captions", "Generating captions for the cut");
    clearCaptions(projectId);
    for (const c of captioned) {
      generateCaptions(projectId, c.assetId, c.words);
    }
  }
  db.prepare(`UPDATE queue_slots SET status = 'orange' WHERE id = ?`).run(slotId);
  return { slotId, projectId, assets, clips, takes };
}
