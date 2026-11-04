// Whisper transcription with word-level timecodes into transcripts/words.
// Audio is normalized to 16kHz mono WAV (via ffmpeg, or direct when the
// source already qualifies), then whisper-cli -ml 1 -ojf does the rest.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDb, nowIso } from "./db";
import { getMedia } from "./media";
import { ffmpegPath, whisperModelPath, whisperPath } from "./tools";

export type Word = { word: string; start_ms: number; end_ms: number; conf: number | null };

type WhisperToken = {
  text: string;
  offsets: { from: number; to: number };
  p?: number;
};

type WhisperSegment = {
  text: string;
  offsets: { from: number; to: number };
  tokens?: WhisperToken[];
};

function isSpecial(text: string): boolean {
  return /^\[.*\]$/.test(text.trim()) || text.trim().length === 0;
}

// With -ml 1 each segment is ~one word; take segment text/offsets and the
// best token confidence. Pure: covered by tests/transcribe.test.ts.
export function parseWhisperJson(input: unknown): { words: Word[]; text: string } {
  const words: Word[] = [];
  const segs = (input as { transcription?: unknown })?.transcription;
  if (!Array.isArray(segs)) return { words, text: "" };
  const usable = (segs as WhisperSegment[]).filter((raw) => !isSpecial(raw.text ?? ""));
  // whisper.cpp -ml 1 emits one BPE token per segment: token texts carry
  // their own leading space, and subwords ("hel" + "lo") must merge or
  // captions show spaces inside words. Full-sentence segments have no
  // leading spaces and split on whitespace with interpolated timings.
  const tokenMode = usable.some((raw, i) => i > 0 && /^\s/.test(raw.text ?? ""));
  const pushWord = (word: string, start_ms: number, end_ms: number, conf: number | null): void => {
    const clean = word.trim();
    if (clean) words.push({ word: clean, start_ms, end_ms, conf });
  };
  const segConf = (raw: WhisperSegment): number | null => {
    let conf: number | null = null;
    if (Array.isArray(raw.tokens)) {
      for (const t of raw.tokens) {
        if (typeof t.p === "number" && (conf === null || t.p < conf)) conf = t.p;
      }
    }
    return conf;
  };
  if (tokenMode) {
    for (const raw of usable) {
      const piece = raw.text ?? "";
      const from = Math.max(0, Math.round(raw.offsets?.from ?? 0));
      const to = Math.max(from, Math.round(raw.offsets?.to ?? from));
      const conf = segConf(raw);
      const last = words[words.length - 1];
      if (last && !/^\s/.test(piece) && piece.trim()) {
        last.word += piece.trim();
        last.end_ms = to;
        if (conf !== null) last.conf = last.conf === null ? conf : Math.min(last.conf, conf);
      } else {
        pushWord(piece, from, to, conf);
      }
    }
  } else {
    for (const raw of usable) {
      const text = (raw.text ?? "").trim();
      const from = Math.max(0, Math.round(raw.offsets?.from ?? 0));
      const to = Math.max(from, Math.round(raw.offsets?.to ?? from));
      const conf = segConf(raw);
      const tokens = text.split(/\s+/).filter(Boolean);
      if (tokens.length <= 1) {
        pushWord(text, from, to, conf);
        continue;
      }
      const total = tokens.reduce((n, t) => n + t.length, 0) || 1;
      let cursor = from;
      tokens.forEach((token, i) => {
        const share = Math.round(((to - from) * token.length) / total);
        const end = i === tokens.length - 1 ? to : cursor + share;
        pushWord(token, cursor, end, conf);
        cursor = end;
      });
    }
  }
  return { words, text: words.map((w) => w.word).join(" ") };
}

// True when the file is already 16kHz mono PCM WAV (whisper-ready).
function isWhisperReadyWav(path: string): boolean {
  try {
    const buf = readFileSync(path);
    if (buf.length < 44) return false;
    if (buf.subarray(0, 4).toString("ascii") !== "RIFF") return false;
    if (buf.subarray(8, 12).toString("ascii") !== "WAVE") return false;
    const channels = buf.readUInt16LE(22);
    const sampleRate = buf.readUInt32LE(24);
    const format = buf.readUInt16LE(20);
    return format === 1 && channels === 1 && sampleRate === 16000;
  } catch {
    return false;
  }
}

function extractAudio(input: string, output: string): void {
  const ffmpeg = ffmpegPath();
  if (!ffmpeg) throw new Error("ffmpeg is missing (run scripts/ensure-tools.sh)");
  execFileSync(
    ffmpeg,
    ["-y", "-v", "error", "-i", input, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", output],
    { timeout: 30 * 60 * 1000, maxBuffer: 4 * 1024 * 1024 },
  );
}

function runWhisper(wav: string, outBase: string, lang: string): void {
  const whisper = whisperPath();
  const model = whisperModelPath();
  if (!whisper) throw new Error("whisper-cli is missing (run scripts/ensure-tools.sh)");
  if (!model) throw new Error("whisper model is missing (run scripts/ensure-tools.sh)");
  const args = ["-m", model, "-f", wav, "-l", lang, "-ml", "1", "-ojf", "-of", outBase];
  try {
    execFileSync(whisper, args, { timeout: 60 * 60 * 1000, maxBuffer: 4 * 1024 * 1024 });
  } catch (error) {
    const stderr = (error as { stderr?: unknown }).stderr;
    const text = typeof stderr === "string" ? stderr : String(stderr ?? error);
    if (/metal|MTL|GPU|ggml.*buffer/i.test(text)) {
      execFileSync(whisper, [...args, "-ng"], {
        timeout: 60 * 60 * 1000,
        maxBuffer: 4 * 1024 * 1024,
      });
      return;
    }
    throw error;
  }
  if (!existsSync(`${outBase}.json`)) {
    throw new Error("whisper produced no JSON output");
  }
}

export type TranscribeResult = {
  assetId: string;
  words: number;
  chars: number;
};

export async function runTranscription(assetId: string, lang = "en"): Promise<TranscribeResult> {
  const asset = getMedia(assetId);
  if (!asset) throw new Error("media asset not found");
  const tag = randomUUID();
  const wav = isWhisperReadyWav(asset.path)
    ? asset.path
    : join(tmpdir(), `creagent-${tag}.wav`);
  if (wav !== asset.path) extractAudio(asset.path, wav);
  const outBase = join(tmpdir(), `creagent-${tag}`);
  try {
    runWhisper(wav, outBase, lang);
    const parsed = parseWhisperJson(
      JSON.parse(readFileSync(`${outBase}.json`, "utf8")) as unknown,
    );
    const db = getDb();
    const ts = nowIso();
    const existing = db
      .prepare(`SELECT id FROM transcripts WHERE asset_id = ?`)
      .get(assetId) as { id: string } | undefined;
    const transcriptId = existing?.id ?? randomUUID();
    if (existing) {
      db.prepare(`UPDATE transcripts SET full_text = ? WHERE id = ?`).run(parsed.text, transcriptId);
      db.prepare(`DELETE FROM transcript_words WHERE transcript_id = ?`).run(transcriptId);
    } else {
      db.prepare(
        `INSERT INTO transcripts (id, asset_id, lang, full_text, created_at) VALUES (?, ?, ?, ?, ?)`,
      ).run(transcriptId, assetId, lang, parsed.text, ts);
    }
    const insert = db.prepare(
      `INSERT INTO transcript_words (id, transcript_id, idx, word, start_ms, end_ms, conf)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    parsed.words.forEach((w, i) => {
      insert.run(randomUUID(), transcriptId, i, w.word, w.start_ms, w.end_ms, w.conf);
    });
    return { assetId, words: parsed.words.length, chars: parsed.text.length };
  } finally {
    if (wav !== asset.path) rmSync(wav, { force: true });
    rmSync(`${outBase}.json`, { force: true });
  }
}

export function getTranscript(assetId: string): {
  transcript: { id: string; full_text: string; lang: string } | null;
  words: Word[];
} {
  const db = getDb();
  const t = db
    .prepare(`SELECT id, full_text, lang FROM transcripts WHERE asset_id = ?`)
    .get(assetId) as { id: string; full_text: string; lang: string } | undefined;
  if (!t) return { transcript: null, words: [] };
  const words = db
    .prepare(
      `SELECT word, start_ms, end_ms, conf FROM transcript_words
       WHERE transcript_id = ? ORDER BY idx ASC`,
    )
    .all(t.id) as Word[];
  return { transcript: t, words };
}
