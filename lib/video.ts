// Timeline engine: magnetic (ripple) clip ops, tracks, notes, captions I/O.
// All edits run in a transaction so trims never strand the track.
import { randomUUID } from "node:crypto";
import type { SQLInputValue } from "node:sqlite";
import { getDb, nowIso, withTransaction } from "./db";

export type TrackKind = "video" | "audio" | "caption" | "graphics" | "review";

export type Clip = {
  id: string;
  track_id: string;
  asset_id: string | null;
  name: string;
  start_ms: number;
  duration_ms: number;
  in_ms: number;
  speed: number;
  payload: string;
};

export type Track = {
  id: string;
  project_id: string;
  kind: TrackKind;
  name: string;
  position: number;
  muted: number;
  hidden: number;
  locked: number;
};

export type ProjectDetail = {
  project: {
    id: string;
    slot_id: string | null;
    title: string;
    width: number;
    height: number;
    fps: number;
    style: string;
    updated_at: string;
  };
  tracks: (Track & {
    clips: (Clip & {
      asset: { filename: string; kind: string; duration_ms: number | null } | null;
    })[];
  })[];
  captions: {
    id: string;
    track_id: string | null;
    start_ms: number;
    end_ms: number;
    lines: { text: string; start_ms: number; end_ms: number }[];
    enabled: number;
  }[];
  notes: {
    id: string;
    start_ms: number;
    end_ms: number;
    body: string;
    status: string;
  }[];
};

function row<T>(sql: string, ...params: SQLInputValue[]): T | undefined {
  return getDb().prepare(sql).get(...params) as T | undefined;
}

function rows<T>(sql: string, ...params: SQLInputValue[]): T[] {
  return getDb().prepare(sql).all(...params) as T[];
}

export type VideoProjectRow = ProjectDetail["project"] & { track_count: number };

export function listProjects(): VideoProjectRow[] {
  return rows<VideoProjectRow>(
    `SELECT p.*, (SELECT COUNT(*) FROM video_tracks t WHERE t.project_id = p.id) AS track_count
     FROM video_projects p ORDER BY p.updated_at DESC`,
  );
}

export function createProject(input: {
  title?: string;
  slot_id?: string | null;
  width?: number;
  height?: number;
  fps?: number;
}): ProjectDetail["project"] {
  const ts = nowIso();
  const project = {
    id: randomUUID(),
    slot_id: input.slot_id ?? null,
    title: input.title?.trim() || "Untitled video",
    width: input.width ?? 1080,
    height: input.height ?? 1920,
    fps: input.fps ?? 30,
  };
  withTransaction(() => {
    const db = getDb();
    db.prepare(
      `INSERT INTO video_projects (id, slot_id, title, width, height, fps, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      project.id,
      project.slot_id,
      project.title,
      project.width,
      project.height,
      project.fps,
      ts,
      ts,
    );
    // Default track stack: keyed subject over graphics over main video, plus audio.
    const tracks: Array<[string, string, number]> = [
      ["video", "Subject (keyed)", 0],
      ["graphics", "Graphics", 1],
      ["video", "Main", 2],
      ["audio", "Audio", 3],
      ["caption", "Captions", 4],
      ["review", "Review", 5],
    ];
    const insertTrack = db.prepare(
      `INSERT INTO video_tracks (id, project_id, kind, name, position, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const [kind, name, position] of tracks) {
      insertTrack.run(randomUUID(), project.id, kind, name, position, ts);
    }
  });
  const created = getProject(project.id);
  if (!created) throw new Error("project insert failed");
  return created;
}

export function deleteProject(projectId: string): boolean {
  const res = getDb().prepare(`DELETE FROM video_projects WHERE id = ?`).run(projectId);
  return res.changes > 0;
}

export function getProject(projectId: string): ProjectDetail["project"] | null {
  const p = row<ProjectDetail["project"]>(
    `SELECT id, slot_id, title, width, height, fps, style, updated_at
     FROM video_projects WHERE id = ?`,
    projectId,
  );
  return p ?? null;
}

export function getProjectDetail(projectId: string): ProjectDetail | null {
  const project = getProject(projectId);
  if (!project) return null;
  const db = getDb();
  const tracks = rows<Track>(
    `SELECT * FROM video_tracks WHERE project_id = ? ORDER BY position ASC`,
    projectId,
  );
  const withClips = tracks.map((t) => ({
    ...t,
    clips: rows<
      Omit<Clip, "payload"> & {
        payload: string;
        asset_filename: string | null;
        asset_kind: string | null;
        asset_duration: number | null;
      }
    >(
      `SELECT c.*, a.filename AS asset_filename, a.kind AS asset_kind,
              a.duration_ms AS asset_duration
       FROM video_clips c LEFT JOIN media_assets a ON a.id = c.asset_id
       WHERE c.track_id = ? ORDER BY c.start_ms ASC`,
      t.id,
    ).map((c) => ({
      id: c.id,
      track_id: c.track_id,
      asset_id: c.asset_id,
      name: c.name,
      start_ms: c.start_ms,
      duration_ms: c.duration_ms,
      in_ms: c.in_ms,
      speed: c.speed,
      payload: c.payload ?? "{}",
      asset: c.asset_filename
        ? {
            filename: c.asset_filename,
            kind: c.asset_kind ?? "video",
            duration_ms: c.asset_duration,
          }
        : null,
    })),
  }));
  const captions = rows<{
    id: string;
    track_id: string | null;
    start_ms: number;
    end_ms: number;
    lines: string;
    enabled: number;
  }>(
    `SELECT id, track_id, start_ms, end_ms, lines, enabled FROM captions
     WHERE project_id = ? ORDER BY start_ms ASC`,
    projectId,
  ).map((c) => ({
    ...c,
    lines: JSON.parse(c.lines) as { text: string; start_ms: number; end_ms: number }[],
  }));
  const notes = rows<ProjectDetail["notes"][number]>(
    `SELECT id, start_ms, end_ms, body, status FROM review_notes
     WHERE project_id = ? ORDER BY start_ms ASC`,
    projectId,
  );
  void db;
  return { project, tracks: withClips, captions, notes };
}

export function addTrack(projectId: string, kind: TrackKind, name?: string): Track {
  const db = getDb();
  const max = row<{ m: number | null }>(
    `SELECT MAX(position) AS m FROM video_tracks WHERE project_id = ?`,
    projectId,
  );
  const track: Track = {
    id: randomUUID(),
    project_id: projectId,
    kind,
    name: name ?? "",
    position: (max?.m ?? -1) + 1,
    muted: 0,
    hidden: 0,
    locked: 0,
  };
  db.prepare(
    `INSERT INTO video_tracks (id, project_id, kind, name, position, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(track.id, projectId, kind, track.name, track.position, nowIso());
  touchProject(projectId);
  return track;
}

function trackEnd(trackId: string): number {
  const end = row<{ e: number | null }>(
    `SELECT MAX(start_ms + duration_ms) AS e FROM video_clips WHERE track_id = ?`,
    trackId,
  );
  return end?.e ?? 0;
}

function shiftLaterClips(
  trackId: string,
  afterStartMs: number,
  excludeId: string,
  deltaMs: number,
): void {
  if (deltaMs === 0) return;
  getDb()
    .prepare(
      `UPDATE video_clips SET start_ms = start_ms + ?
       WHERE track_id = ? AND start_ms >= ? AND id != ?`,
      )
    .run(deltaMs, trackId, afterStartMs, excludeId);
}

function touchProject(projectId: string): void {
  getDb()
    .prepare(`UPDATE video_projects SET updated_at = ? WHERE id = ?`)
    .run(nowIso(), projectId);
}

function projectOfTrack(trackId: string): string {
  const t = row<{ project_id: string }>(
    `SELECT project_id FROM video_tracks WHERE id = ?`,
    trackId,
  );
  if (!t) throw new Error("track not found");
  return t.project_id;
}

export function addClip(input: {
  trackId: string;
  assetId?: string | null;
  name?: string;
  inMs?: number;
  durationMs: number;
  atMs?: number;
  payload?: Record<string, unknown>;
}): Clip {
  const db = getDb();
  const duration = Math.max(1, Math.round(input.durationMs));
  const inMs = Math.max(0, Math.round(input.inMs ?? 0));
  const at = input.atMs === undefined ? trackEnd(input.trackId) : Math.max(0, Math.round(input.atMs));
  const clip: Clip = {
    id: randomUUID(),
    track_id: input.trackId,
    asset_id: input.assetId ?? null,
    name: input.name ?? "",
    start_ms: at,
    duration_ms: duration,
    in_ms: inMs,
    speed: 1,
    payload: JSON.stringify(input.payload ?? {}),
  };
  withTransaction(() => {
    shiftLaterClips(input.trackId, at, clip.id, duration);
    db.prepare(
      `INSERT INTO video_clips (id, track_id, asset_id, name, start_ms, duration_ms, in_ms, payload, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      clip.id,
      clip.track_id,
      clip.asset_id,
      clip.name,
      clip.start_ms,
      clip.duration_ms,
      clip.in_ms,
      clip.payload,
      nowIso(),
    );
  });
  touchProject(projectOfTrack(input.trackId));
  return clip;
}

export function getClip(clipId: string): (Clip & { project_id: string }) | null {
  const c = row<Clip & { project_id: string }>(
    `SELECT c.*, t.project_id FROM video_clips c
     JOIN video_tracks t ON t.id = c.track_id WHERE c.id = ?`,
    clipId,
  );
  return c ?? null;
}

// Ripple trim: out-point changes pull/push every later clip on the track;
// in-point changes move the clip head and ripple the same delta.
export function trimClip(
  clipId: string,
  edit: { inMs?: number; durationMs?: number },
  ripple = true,
): Clip {
  const current = getClip(clipId);
  if (!current) throw new Error("clip not found");
  let { start_ms: start, duration_ms: duration, in_ms: inMs } = current;
  const oldEnd = start + duration;
  if (edit.inMs !== undefined) {
    const nextIn = Math.max(0, Math.round(edit.inMs));
    const dIn = nextIn - inMs;
    if (duration - dIn < 1) throw new Error("trim would collapse the clip");
    inMs = nextIn;
    start += dIn;
    duration -= dIn;
    if (ripple && dIn !== 0) {
      shiftLaterClips(current.track_id, oldEnd, clipId, dIn);
    }
  }
  if (edit.durationMs !== undefined) {
    const nextDuration = Math.max(1, Math.round(edit.durationMs));
    const delta = nextDuration - duration;
    duration = nextDuration;
    if (ripple && delta !== 0) {
      shiftLaterClips(current.track_id, oldEnd, clipId, delta);
    }
  }
  getDb()
    .prepare(`UPDATE video_clips SET start_ms = ?, duration_ms = ?, in_ms = ? WHERE id = ?`)
    .run(start, duration, inMs, clipId);
  touchProject(current.project_id);
  return { ...current, start_ms: start, duration_ms: duration, in_ms: inMs };
}

// Plain move: clamps into free space (no push, no overlap).
export function moveClip(clipId: string, startMs: number): Clip {
  const current = getClip(clipId);
  if (!current) throw new Error("clip not found");
  const siblings = rows<Clip>(
    `SELECT * FROM video_clips WHERE track_id = ? AND id != ? ORDER BY start_ms ASC`,
    current.track_id,
    clipId,
  );
  // Push right past any overlapped sibling until the span is free.
  let start = Math.max(0, Math.round(startMs));
  const dur = current.duration_ms;
  for (let guard = 0; guard <= siblings.length; guard++) {
    const hit = siblings.find(
      (s) => start < s.start_ms + s.duration_ms && start + dur > s.start_ms,
    );
    if (!hit) break;
    start = hit.start_ms + hit.duration_ms;
  }
  getDb().prepare(`UPDATE video_clips SET start_ms = ? WHERE id = ?`).run(start, clipId);
  touchProject(current.project_id);
  return { ...current, start_ms: start };
}

export function deleteClip(clipId: string, ripple = true): { project_id: string } {
  const current = getClip(clipId);
  if (!current) throw new Error("clip not found");
  withTransaction(() => {
    getDb().prepare(`DELETE FROM video_clips WHERE id = ?`).run(clipId);
    if (ripple) {
      shiftLaterClips(
        current.track_id,
        current.start_ms + current.duration_ms,
        clipId,
        -current.duration_ms,
      );
    }
  });
  touchProject(current.project_id);
  return { project_id: current.project_id };
}

export function splitClip(clipId: string, atMs: number): { left: Clip; right: Clip } {
  const current = getClip(clipId);
  if (!current) throw new Error("clip not found");
  const at = Math.round(atMs);
  if (at <= current.start_ms || at >= current.start_ms + current.duration_ms) {
    throw new Error("split point must be inside the clip");
  }
  const leftDuration = at - current.start_ms;
  const right: Clip = {
    id: randomUUID(),
    track_id: current.track_id,
    asset_id: current.asset_id,
    name: current.name,
    start_ms: at,
    duration_ms: current.duration_ms - leftDuration,
    in_ms: current.in_ms + leftDuration,
    speed: current.speed,
    payload: current.payload,
  };
  withTransaction(() => {
    getDb().prepare(`UPDATE video_clips SET duration_ms = ? WHERE id = ?`).run(leftDuration, clipId);
    getDb()
      .prepare(
        `INSERT INTO video_clips (id, track_id, asset_id, name, start_ms, duration_ms, in_ms, speed, payload, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        right.id,
        right.track_id,
        right.asset_id,
        right.name,
        right.start_ms,
        right.duration_ms,
        right.in_ms,
        right.speed,
        right.payload,
        nowIso(),
      );
  });
  touchProject(current.project_id);
  return { left: { ...current, duration_ms: leftDuration }, right };
}

// Used ranges per asset across the project's video/audio tracks: powers RAW view.
export function usedRanges(
  projectId: string,
  assetId: string,
): { start_ms: number; end_ms: number }[] {
  return rows<{ start_ms: number; end_ms: number }>(
    `SELECT c.in_ms AS start_ms, (c.in_ms + c.duration_ms) AS end_ms
     FROM video_clips c JOIN video_tracks t ON t.id = c.track_id
     WHERE t.project_id = ? AND c.asset_id = ?
       AND t.kind IN ('video', 'audio')
     ORDER BY start_ms ASC`,
    projectId,
    assetId,
  );
}

export function addNote(input: {
  projectId: string;
  startMs: number;
  endMs: number;
  body: string;
}): { id: string } {
  const id = randomUUID();
  getDb()
    .prepare(
      `INSERT INTO review_notes (id, project_id, start_ms, end_ms, body, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.projectId,
      Math.max(0, Math.round(input.startMs)),
      Math.max(0, Math.round(input.endMs)),
      input.body,
      nowIso(),
    );
  touchProject(input.projectId);
  return { id };
}

export function setNoteStatus(noteId: string, status: "open" | "done"): void {
  getDb().prepare(`UPDATE review_notes SET status = ? WHERE id = ?`).run(status, noteId);
}

export function deleteNote(noteId: string): void {
  getDb().prepare(`DELETE FROM review_notes WHERE id = ?`).run(noteId);
}

export function updateClipPayload(clipId: string, payload: Record<string, unknown>): Clip | null {
  const current = getClip(clipId);
  if (!current) return null;
  const next = JSON.stringify(payload);
  getDb().prepare(`UPDATE video_clips SET payload = ? WHERE id = ?`).run(next, clipId);
  return { ...current, payload: next };
}

export function updateProjectStyle(
  projectId: string,
  style: { caption_font?: unknown; heading_font?: unknown },
): void {
  const db = getDb();
  const current = row<{ style: string }>(`SELECT style FROM video_projects WHERE id = ?`, projectId);
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(current?.style ?? "{}") as Record<string, unknown>;
  } catch {
    /* reset */
  }
  if (typeof style.caption_font === "string") parsed.caption_font = style.caption_font;
  if (typeof style.heading_font === "string") parsed.heading_font = style.heading_font;
  db.prepare(`UPDATE video_projects SET style = ?, updated_at = ? WHERE id = ?`).run(
    JSON.stringify(parsed),
    nowIso(),
    projectId,
  );
}
