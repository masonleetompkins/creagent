// Auto-graphics: script + transcript -> anime scene cutaways, one per
// spoken statement, laid on a top Scenes track so each statement plays
// over its own illustration. Prompts are story-planned like carousel
// images; generation reuses the locked house style.
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { generateStyledImageBytes } from "./carousel-image";
import { resolveSlotOutline } from "./carousel-plan";
import { getDb } from "./db";
import { loadKeys } from "./keys";
import { mediaDir, registerLocalFile } from "./media";
import { getMetaClient, metaTextModel } from "./meta";
import { getTranscript, type Word } from "./transcribe";
import { addClip, addTrack, deleteClip, getProjectDetail } from "./video";

export type Statement = {
  index: number;
  text: string;
  assetId: string;
  startAssetMs: number;
  endAssetMs: number;
  startMs: number;
  durationMs: number;
};

// Pure: split timed words into sentences, keeping asset timings.
export function statementsFromWords(
  words: Word[],
): Array<Pick<Statement, "index" | "text" | "assetId" | "startAssetMs" | "endAssetMs">> {
  const out: Array<{ text: string; assetMs: [number, number]; words: Word[] }> = [];
  let current: Word[] = [];
  const flush = (): void => {
    if (current.length === 0) return;
    out.push({
      text: current.map((w) => w.word).join(" "),
      assetMs: [current[0].start_ms, current[current.length - 1].end_ms],
      words: current,
    });
    current = [];
  };
  for (const w of words) {
    current.push(w);
    if (/[.!?…]\s*$/.test(w.word)) flush();
  }
  flush();
  return out
    .filter((s) => s.text.trim().length > 0)
    .map((s, i) => ({
      index: i,
      text: s.text,
      assetId: "",
      startAssetMs: s.assetMs[0],
      endAssetMs: s.assetMs[1],
    }));
}

// Map an asset-time range onto the Main track timeline via the clip that
// contains the statement start; statements fully in cut gaps map to null.
export function collectStatements(projectId: string): Statement[] {
  const detail = getProjectDetail(projectId);
  if (!detail) throw new Error("video project not found");
  const main =
    detail.tracks.find((t) => t.kind === "video" && t.name === "Main") ??
    detail.tracks.find((t) => t.kind === "video");
  if (!main) return [];
  const clips = [...main.clips].sort((a, b) => a.start_ms - b.start_ms);
  const seenAssets = new Set<string>();
  const out: Statement[] = [];
  for (const clip of clips) {
    if (!clip.asset_id || seenAssets.has(clip.asset_id)) continue;
    seenAssets.add(clip.asset_id);
    const { words } = getTranscript(clip.asset_id);
    for (const st of statementsFromWords(words)) {
      const host = clips.find(
        (c) =>
          c.asset_id === clip.asset_id &&
          st.startAssetMs >= c.in_ms &&
          st.startAssetMs < c.in_ms + c.duration_ms,
      );
      if (!host) continue;
      const startMs = host.start_ms + (st.startAssetMs - host.in_ms);
      const durationMs = Math.min(st.endAssetMs - st.startAssetMs, host.in_ms + host.duration_ms - st.startAssetMs);
      if (durationMs < 400) continue;
      out.push({
        index: out.length,
        text: st.text,
        assetId: clip.asset_id,
        startAssetMs: st.startAssetMs,
        endAssetMs: st.endAssetMs,
        startMs: Math.round(startMs),
        durationMs: Math.round(durationMs),
      });
    }
  }
  return out.sort((a, b) => a.startMs - b.startMs).map((s, i) => ({ ...s, index: i }));
}

export type ScenePrompt = { statement: number; prompt: string };

export function parseSceneJson(text: string): ScenePrompt[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    const match = text.match(/```json\s*([\s\S]*?)```/) ?? text.match(/\[[\s\S]*\]/);
    if (!match) throw new Error("model did not return scene JSON");
    parsed = JSON.parse(match[1] ?? match[0]) as unknown;
  }
  const list = Array.isArray(parsed) ? parsed : (parsed as { scenes?: unknown }).scenes;
  if (!Array.isArray(list)) throw new Error("scene JSON is not an array");
  const out: ScenePrompt[] = [];
  for (const item of list) {
    const o = (item ?? {}) as Record<string, unknown>;
    if (typeof o.statement !== "number" || !Number.isInteger(o.statement) || o.statement < 1) continue;
    if (typeof o.prompt !== "string" || !o.prompt.trim()) continue;
    out.push({ statement: o.statement, prompt: o.prompt });
  }
  return out;
}

export function heuristicScenePrompt(statement: string): string {
  return `Vertical 9:16 full-frame illustration, composed for a phone screen with the subject clear of the top and bottom thirds, continuing the narration at this moment: ${statement.slice(0, 220)}`;
}

export async function planScenePrompts(
  projectId: string,
  statements: Statement[],
  script: string,
): Promise<Map<number, string>> {
  const prompts = new Map<number, string>();
  if (statements.length === 0) return prompts;
  const metaKey = loadKeys().meta;
  if (!metaKey || process.env.CREAGENT_MODEL_OFFLINE === "1") {
    for (const s of statements) prompts.set(s.index, heuristicScenePrompt(s.text));
    return prompts;
  }
  try {
    const roster = statements.map((s) => `${s.index + 1}. ${s.text.slice(0, 240)}`).join("\n");
    const client = getMetaClient(metaKey);
    const resp = await client.responses.create(
      {
        model: metaTextModel(),
        input: `You art-direct cutaway illustrations for a narrated video. Recurring subjects, objects, and settings must stay consistent across scenes so they read as one visual story following the narration.
${script ? `\nFULL SCRIPT:\n${script.slice(0, 5000)}\n` : ""}
STATEMENTS (in order):
${roster}

Write one image prompt per statement: a vivid paragraph describing the scene that should fill the screen while those words play. Compose every scene as a vertical 9:16 full-frame illustration for a phone screen, keeping the subject clear of the top and bottom thirds. House style is applied automatically — describe content only, never lettering. Respond with ONLY a JSON array, no prose:
[{"statement": 1, "prompt": "..."}]`,
        reasoning: { effort: "medium" },
      },
      { timeout: 120000 },
    );
    for (const w of parseSceneJson(resp.output_text)) {
      const st = statements[w.statement - 1];
      if (!st || prompts.has(st.index)) continue;
      const clean = w.prompt.trim().slice(0, 900);
      if (clean) prompts.set(st.index, clean);
    }
  } catch {
    // Fall through to heuristics for anything missing.
  }
  for (const s of statements) {
    if (!prompts.has(s.index)) prompts.set(s.index, heuristicScenePrompt(s.text));
  }
  return prompts;
}

function scenesTrackId(projectId: string): string {
  const db = getDb();
  const existing = db
    .prepare(`SELECT id FROM video_tracks WHERE project_id = ? AND kind = 'video' AND name = 'Scenes' LIMIT 1`)
    .get(projectId) as { id: string } | undefined;
  if (existing) {
    for (const clip of db
      .prepare(`SELECT id FROM video_clips WHERE track_id = ?`)
      .all(existing.id) as Array<{ id: string }>) {
      deleteClip(clip.id, false);
    }
    return existing.id;
  }
  const track = addTrack(projectId, "video", "Scenes");
  // Opaque cutaways sit on top: position 0 renders above Main.
  db.prepare(`UPDATE video_tracks SET position = position + 1 WHERE project_id = ? AND id != ?`).run(
    projectId,
    track.id,
  );
  db.prepare(`UPDATE video_tracks SET position = 0 WHERE id = ?`).run(track.id);
  return track.id;
}

export type SceneBuildResult = { scenes: number; statements: number };

export async function generateScenes(
  projectId: string,
  onStage?: (stage: string, label: string) => void,
): Promise<SceneBuildResult> {
  const detail = getProjectDetail(projectId);
  if (!detail) throw new Error("video project not found");
  const statements = collectStatements(projectId);
  if (statements.length === 0) throw new Error("no spoken statements on the timeline — transcribe first");
  onStage?.("plan", `Planning ${statements.length} scenes from the script`);
  const script = detail.project.slot_id ? resolveSlotOutline(detail.project.slot_id) : "";
  const prompts = await planScenePrompts(projectId, statements, script);
  const trackId = scenesTrackId(projectId);
  let scenes = 0;
  for (const st of statements) {
    onStage?.("generate", `Generating scene ${scenes + 1}/${statements.length}`);
    const { bytes, ext } = await generateStyledImageBytes(prompts.get(st.index) ?? heuristicScenePrompt(st.text));
    const filename = `scene-${randomUUID()}${ext}`;
    writeFileSync(join(mediaDir(), filename), bytes);
    const asset = registerLocalFile(join(mediaDir(), filename));
    addClip({
      trackId,
      assetId: asset.id,
      name: `Scene ${st.index + 1}`,
      inMs: 0,
      durationMs: st.durationMs,
      atMs: st.startMs,
    });
    scenes++;
  }
  return { scenes, statements: statements.length };
}
