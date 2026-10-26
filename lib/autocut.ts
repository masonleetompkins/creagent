// Auto-cut: find repeated takes in a transcript, keep the best of each,
// cut silence. Heuristic (offline, instant): sentence clustering by token
// overlap + confidence/completeness scoring. Pure core is unit-tested.
import { randomUUID } from "node:crypto";
import { getDb, nowIso, withTransaction } from "./db";
import type { Word } from "./transcribe";
import { addClip } from "./video";

export type TakeVerdict = "keep" | "cut" | "unsure";

export type Take = {
  id: string;
  label: string;
  start_ms: number;
  end_ms: number;
  text: string;
  score: number | null;
  verdict: TakeVerdict;
};

type Sentence = {
  words: Word[];
  text: string;
  tokens: string[];
  start_ms: number;
  end_ms: number;
  meanConf: number;
};

const END_PUNCT = /[.!?…]+$/;

function normalize(word: string): string {
  return word.toLowerCase().replace(/[^a-z0-9'\- ]/g, "").trim();
}

function splitSentences(words: Word[]): Sentence[] {
  const out: Sentence[] = [];
  let current: Word[] = [];
  const flush = (): void => {
    if (current.length === 0) return;
    const text = current.map((w) => w.word).join(" ").replace(/\s+([,.;!?…])/g, "$1");
    const tokens = current
      .map((w) => normalize(w.word))
      .join(" ")
      .split(/\s+/)
      .filter(Boolean);
    const confs = current.map((w) => w.conf ?? 0.5);
    out.push({
      words: current,
      text,
      tokens,
      start_ms: current[0].start_ms,
      end_ms: current[current.length - 1].end_ms,
      meanConf: confs.reduce((a, b) => a + b, 0) / confs.length,
    });
    current = [];
  };
  for (const w of words) {
    current.push(w);
    if (END_PUNCT.test(w.word.trim()) || /[.!?]/.test(w.word)) flush();
  }
  flush();
  return out;
}

function overlap(a: Sentence, b: Sentence): number {
  if (a.tokens.length === 0 || b.tokens.length === 0) return 0;
  const setB = new Set(b.tokens);
  const hit = a.tokens.filter((t) => setB.has(t)).length;
  return hit / Math.max(a.tokens.length, b.tokens.length);
}

// Pure: cluster sentences into takes and score them.
export function detectTakes(
  words: Word[],
  options?: { similarity?: number; silenceMs?: number; handleMs?: number; minConf?: number },
): Take[] {
  const similarity = options?.similarity ?? 0.75;
  const silenceMs = options?.silenceMs ?? 1200;
  const handleMs = options?.handleMs ?? 120;
  const minConf = options?.minConf ?? 0.3;
  const takes: Take[] = [];
  const sentences = splitSentences(words).filter((s) => s.tokens.length > 0);

  // Cluster near-duplicate sentences (repeated takes of the same line).
  const clusterOf = new Array<number>(sentences.length).fill(-1);
  let clusterCount = 0;
  for (let i = 0; i < sentences.length; i++) {
    if (clusterOf[i] !== -1) continue;
    clusterOf[i] = clusterCount;
    for (let j = i + 1; j < sentences.length; j++) {
      if (clusterOf[j] !== -1) continue;
      if (overlap(sentences[i], sentences[j]) >= similarity) clusterOf[j] = clusterCount;
    }
    clusterCount++;
  }

  const byCluster = new Map<number, number[]>();
  sentences.forEach((_, i) => {
    const list = byCluster.get(clusterOf[i]) ?? [];
    list.push(i);
    byCluster.set(clusterOf[i], list);
  });

  for (const [, members] of [...byCluster.entries()].sort((a, b) => a[0] - b[0])) {
    if (members.length === 1) {
      const s = sentences[members[0]];
      takes.push({
        id: randomUUID(),
        label: "line",
        start_ms: Math.max(0, s.start_ms - handleMs),
        end_ms: s.end_ms + handleMs,
        text: s.text,
        score: s.meanConf,
        verdict: s.meanConf >= minConf ? "keep" : "unsure",
      });
      continue;
    }
    const maxTokens = Math.max(...members.map((i) => sentences[i].tokens.length));
    let best = members[0];
    let bestScore = -1;
    for (const i of members) {
      const s = sentences[i];
      const completeness = s.tokens.length / maxTokens;
      const score = s.meanConf * 0.5 + completeness * 0.5 + i * 1e-6;
      if (score > bestScore) {
        bestScore = score;
        best = i;
      }
    }
    members.forEach((i, takeNo) => {
      const s = sentences[i];
      const isBest = i === best;
      takes.push({
        id: randomUUID(),
        label: `take ${takeNo + 1} of ${members.length}${isBest ? " (best)" : ""}`,
        start_ms: Math.max(0, s.start_ms - handleMs),
        end_ms: s.end_ms + handleMs,
        text: s.text,
        score: Math.round((s.meanConf * 0.5 + (s.tokens.length / maxTokens) * 0.5) * 1000) / 1000,
        verdict: isBest ? "keep" : "cut",
      });
    });
  }

  // Silence between consecutive words becomes cut regions.
  for (let i = 1; i < words.length; i++) {
    const gap = words[i].start_ms - words[i - 1].end_ms;
    if (gap >= silenceMs) {
      takes.push({
        id: randomUUID(),
        label: `silence ${(gap / 1000).toFixed(1)}s`,
        start_ms: words[i - 1].end_ms,
        end_ms: words[i].start_ms,
        text: "",
        score: null,
        verdict: "cut",
      });
    }
  }

  return takes.sort((a, b) => a.start_ms - b.start_ms);
}

export function saveTakes(transcriptId: string, takes: Take[]): Take[] {
  const db = getDb();
  withTransaction(() => {
    db.prepare(`DELETE FROM takes WHERE transcript_id = ?`).run(transcriptId);
    const insert = db.prepare(
      `INSERT INTO takes (id, transcript_id, label, start_ms, end_ms, text, score, verdict, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const ts = nowIso();
    for (const t of takes) {
      insert.run(t.id, transcriptId, t.label, t.start_ms, t.end_ms, t.text, t.score, t.verdict, ts);
    }
  });
  return takes;
}

export function getTakes(transcriptId: string): Take[] {
  return getDb()
    .prepare(
      `SELECT id, label, start_ms, end_ms, text, score, verdict FROM takes
       WHERE transcript_id = ? ORDER BY start_ms ASC`,
    )
    .all(transcriptId) as Take[];
}

export function getTakesByAsset(assetId: string): { transcriptId: string | null; takes: Take[] } {
  const t = getDb()
    .prepare(`SELECT id FROM transcripts WHERE asset_id = ?`)
    .get(assetId) as { id: string } | undefined;
  if (!t) return { transcriptId: null, takes: [] };
  return { transcriptId: t.id, takes: getTakes(t.id) };
}

// Replace the target track's contents with one clip per kept take.
export function applyTakesToTrack(
  trackId: string,
  assetId: string,
  takes: Take[],
): { clips: number } {
  const db = getDb();
  const kept = takes.filter((t) => t.verdict === "keep");
  withTransaction(() => {
    db.prepare(`DELETE FROM video_clips WHERE track_id = ?`).run(trackId);
  });
  kept.forEach((t, i) => {
    addClip({
      trackId,
      assetId,
      name: t.label,
      inMs: t.start_ms,
      durationMs: Math.max(1, t.end_ms - t.start_ms),
      atMs: undefined,
    });
    void i;
  });
  return { clips: kept.length };
}
