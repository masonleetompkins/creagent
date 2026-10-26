// Programmatic captions: generated from transcript words mapped onto the
// timeline, then fully editable (retime, reflow, split, move words, disable).
// Block lines carry their own timecodes so edits never lose sync.
import { randomUUID } from "node:crypto";
import { getDb, nowIso } from "./db";
import type { Word } from "./transcribe";

export type CaptionLine = { text: string; start_ms: number; end_ms: number };

export type CaptionBlock = {
  id: string;
  project_id: string;
  track_id: string | null;
  start_ms: number;
  end_ms: number;
  lines: CaptionLine[];
  enabled: number;
};

type ClipSpan = { clip_start: number; in_ms: number; duration_ms: number };

export function clipsForAsset(projectId: string, assetId: string): ClipSpan[] {
  return getDb()
    .prepare(
      `SELECT c.start_ms AS clip_start, c.in_ms, c.duration_ms
       FROM video_clips c JOIN video_tracks t ON t.id = c.track_id
       WHERE t.project_id = ? AND c.asset_id = ?
         AND t.kind IN ('video', 'audio')
       ORDER BY c.start_ms ASC`,
    )
    .all(projectId, assetId) as ClipSpan[];
}

type TimedWord = Word & { timeline_ms: number };

function mapToTimeline(words: Word[], spans: ClipSpan[]): TimedWord[] {
  const out: TimedWord[] = [];
  for (const w of words) {
    const span = spans.find((s) => w.start_ms >= s.in_ms && w.start_ms < s.in_ms + s.duration_ms);
    if (!span) continue;
    out.push({ ...w, timeline_ms: span.clip_start + (w.start_ms - span.in_ms) });
  }
  return out;
}

export type GenerateOptions = {
  wordsPerLine?: number;
  maxLines?: number;
  maxGapMs?: number;
  minDurationMs?: number;
};

// Pure: group timeline-mapped words into caption blocks.
export function groupWords(
  timed: TimedWord[],
  options?: GenerateOptions,
): Omit<CaptionBlock, "id" | "project_id" | "track_id">[] {
  const wordsPerLine = options?.wordsPerLine ?? 4;
  const maxLines = options?.maxLines ?? 2;
  const maxGapMs = options?.maxGapMs ?? 600;
  const blocks: Omit<CaptionBlock, "id" | "project_id" | "track_id">[] = [];
  let current: TimedWord[] = [];
  const flush = (): void => {
    if (current.length === 0) return;
    const lines: CaptionLine[] = [];
    for (let i = 0; i < current.length; i += wordsPerLine) {
      const chunk = current.slice(i, i + wordsPerLine);
      lines.push({
        text: chunk.map((w) => w.word).join(" ").replace(/\s+([,.;!?…])/g, "$1"),
        start_ms: chunk[0].timeline_ms,
        end_ms: chunk[chunk.length - 1].timeline_ms + 200,
      });
    }
    blocks.push({
      start_ms: current[0].timeline_ms,
      end_ms: current[current.length - 1].timeline_ms + 200,
      lines,
      enabled: 1,
    });
    current = [];
  };
  for (const w of timed) {
    const prev = current[current.length - 1];
    if (
      prev &&
      (w.timeline_ms - (prev.timeline_ms + 200) > maxGapMs ||
        current.length >= wordsPerLine * maxLines)
    ) {
      flush();
    }
    current.push(w);
  }
  flush();
  return blocks;
}

// Pure: reflow a block's words into lines of N words.
export function reflowLines(lines: CaptionLine[], words: Word[], wordsPerLine: number): CaptionLine[] {
  const flat = words.length > 0 ? words : lines.flatMap((l) => splitLineWords(l));
  const out: CaptionLine[] = [];
  for (let i = 0; i < flat.length; i += wordsPerLine) {
    const chunk = flat.slice(i, i + wordsPerLine);
    out.push({
      text: chunk.map((w) => w.word).join(" ").replace(/\s+([,.;!?…])/g, "$1"),
      start_ms: chunk[0].start_ms,
      end_ms: chunk[chunk.length - 1].end_ms,
    });
  }
  return out;
}

function splitLineWords(line: CaptionLine): Word[] {
  const tokens = line.text.split(/\s+/).filter(Boolean);
  const span = Math.max(1, line.end_ms - line.start_ms);
  return tokens.map((word, i) => ({
    word,
    start_ms: Math.round(line.start_ms + (span * i) / tokens.length),
    end_ms: Math.round(line.start_ms + (span * (i + 1)) / tokens.length),
    conf: null,
  }));
}

export function blockWords(block: CaptionBlock): Word[] {
  return block.lines.flatMap((l) => splitLineWords(l));
}

// Pure: move a word across a line boundary. dir -1 pulls the word up to the
// previous line's end, +1 pushes it down to the next line's start.
export function moveWordAcrossLines(
  lines: CaptionLine[],
  lineIndex: number,
  wordIndex: number,
  dir: -1 | 1,
): CaptionLine[] {
  const wordsPerLine = lines.map((l) => splitLineWords(l));
  const target = lineIndex + dir;
  if (target < 0 || target >= wordsPerLine.length) return lines;
  if (dir === -1) {
    if (wordIndex !== 0) return lines;
    const [moved] = wordsPerLine[lineIndex].splice(0, 1);
    if (!moved) return lines;
    wordsPerLine[target].push(moved);
  } else {
    const last = wordsPerLine[lineIndex].length - 1;
    if (wordIndex !== last) return lines;
    const [moved] = wordsPerLine[lineIndex].splice(last, 1);
    if (!moved) return lines;
    wordsPerLine[target].unshift(moved);
  }
  if (wordsPerLine[lineIndex].length === 0) wordsPerLine.splice(lineIndex, 1);
  return wordsPerLine.map((chunk) => ({
    text: chunk.map((w) => w.word).join(" ").replace(/\s+([,.;!?…])/g, "$1"),
    start_ms: chunk[0].start_ms,
    end_ms: chunk[chunk.length - 1].end_ms,
  }));
}

function parseLines(raw: string): CaptionLine[] {
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) return [];
  return (parsed as Array<string | CaptionLine>).map((l) =>
    typeof l === "string" ? { text: l, start_ms: 0, end_ms: 0 } : l,
  );
}

export function listCaptions(projectId: string): CaptionBlock[] {
  const rows = getDb()
    .prepare(
      `SELECT id, project_id, track_id, start_ms, end_ms, lines, enabled
       FROM captions WHERE project_id = ? ORDER BY start_ms ASC`,
    )
    .all(projectId) as Array<Omit<CaptionBlock, "lines"> & { lines: string }>;
  return rows.map((r) => ({ ...r, lines: parseLines(r.lines) }));
}

export function generateCaptions(
  projectId: string,
  assetId: string,
  words: Word[],
  options?: GenerateOptions,
): CaptionBlock[] {
  const spans = clipsForAsset(projectId, assetId);
  const timed = mapToTimeline(words, spans);
  const grouped = groupWords(timed, options);
  const db = getDb();
  const ts = nowIso();
  const track = db
    .prepare(`SELECT id FROM video_tracks WHERE project_id = ? AND kind = 'caption' ORDER BY position ASC LIMIT 1`)
    .get(projectId) as { id: string } | undefined;
  const insert = db.prepare(
    `INSERT INTO captions (id, project_id, track_id, start_ms, end_ms, lines, enabled, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  return grouped.map((g) => {
    const block: CaptionBlock = {
      id: randomUUID(),
      project_id: projectId,
      track_id: track?.id ?? null,
      ...g,
    };
    insert.run(
      block.id,
      projectId,
      block.track_id,
      block.start_ms,
      block.end_ms,
      JSON.stringify(block.lines),
      block.enabled,
      ts,
    );
    return block;
  });
}

export function clearCaptions(projectId: string): { deleted: number } {
  const result = getDb().prepare(`DELETE FROM captions WHERE project_id = ?`).run(projectId);
  return { deleted: Number(result.changes) };
}

export function updateCaption(
  id: string,
  edit: { start_ms?: number; end_ms?: number; lines?: CaptionLine[]; enabled?: number },
): CaptionBlock | null {
  const db = getDb();
  const current = db
    .prepare(`SELECT id, project_id, track_id, start_ms, end_ms, lines, enabled FROM captions WHERE id = ?`)
    .get(id) as (Omit<CaptionBlock, "lines"> & { lines: string }) | undefined;
  if (!current) return null;
  const next = {
    start_ms: edit.start_ms ?? current.start_ms,
    end_ms: edit.end_ms ?? current.end_ms,
    lines: edit.lines ?? parseLines(current.lines),
    enabled: edit.enabled ?? current.enabled,
  };
  db.prepare(`UPDATE captions SET start_ms = ?, end_ms = ?, lines = ?, enabled = ? WHERE id = ?`).run(
    next.start_ms,
    next.end_ms,
    JSON.stringify(next.lines),
    next.enabled,
    id,
  );
  return { ...current, ...next };
}

export function splitCaption(
  id: string,
  atLine: number,
): { left: CaptionBlock; right: CaptionBlock } | null {
  const db = getDb();
  const current = db
    .prepare(`SELECT id, project_id, track_id, start_ms, end_ms, lines, enabled FROM captions WHERE id = ?`)
    .get(id) as (Omit<CaptionBlock, "lines"> & { lines: string }) | undefined;
  if (!current) return null;
  const lines = parseLines(current.lines);
  if (atLine <= 0 || atLine >= lines.length) return null;
  const leftLines = lines.slice(0, atLine);
  const rightLines = lines.slice(atLine);
  const left: CaptionBlock = {
    ...current,
    lines: leftLines,
    start_ms: leftLines[0].start_ms || current.start_ms,
    end_ms: leftLines[leftLines.length - 1].end_ms || current.end_ms,
  };
  const right: CaptionBlock = {
    id: randomUUID(),
    project_id: current.project_id,
    track_id: current.track_id,
    lines: rightLines,
    start_ms: rightLines[0].start_ms || current.start_ms,
    end_ms: rightLines[rightLines.length - 1].end_ms || current.end_ms,
    enabled: current.enabled,
  };
  db.prepare(`UPDATE captions SET start_ms = ?, end_ms = ?, lines = ? WHERE id = ?`).run(
    left.start_ms,
    left.end_ms,
    JSON.stringify(left.lines),
    id,
  );
  db.prepare(
    `INSERT INTO captions (id, project_id, track_id, start_ms, end_ms, lines, enabled, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    right.id,
    right.project_id,
    right.track_id,
    right.start_ms,
    right.end_ms,
    JSON.stringify(right.lines),
    right.enabled,
    nowIso(),
  );
  return { left, right };
}

export function deleteCaption(id: string): boolean {
  const result = getDb().prepare(`DELETE FROM captions WHERE id = ?`).run(id);
  return Number(result.changes) > 0;
}
