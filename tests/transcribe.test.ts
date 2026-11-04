import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseSilenceOutput, parseWhisperJson } from "../lib/transcribe";

const SAMPLE = {
  transcription: [
    { text: "", offsets: { from: 0, to: 0 }, tokens: [{ text: "[_BEG_]", offsets: { from: 0, to: 0 }, p: 0.2 }] },
    { text: " And", offsets: { from: 100, to: 330 }, tokens: [{ text: " And", offsets: { from: 100, to: 240 }, p: 0.708 }] },
    { text: " so", offsets: { from: 330, to: 410 }, tokens: [{ text: " so", offsets: { from: 330, to: 410 }, p: 0.994 }] },
  ],
};

describe("parseWhisperJson", () => {
  it("extracts trimmed words with ms timecodes and confidence", () => {
    const { words, text } = parseWhisperJson(SAMPLE);
    assert.deepEqual(words, [
      { word: "And", start_ms: 100, end_ms: 330, conf: 0.708 },
      { word: "so", start_ms: 330, end_ms: 410, conf: 0.994 },
    ]);
    assert.equal(text, "And so");
  });

  it("skips special tokens and empty segments", () => {
    const { words } = parseWhisperJson({
      transcription: [
        { text: "[_BEG_]", offsets: { from: 0, to: 0 }, tokens: [] },
        { text: "  ", offsets: { from: 0, to: 10 }, tokens: [] },
      ],
    });
    assert.deepEqual(words, []);
  });

  it("returns empty on malformed input instead of throwing", () => {
    assert.deepEqual(parseWhisperJson({}), { words: [], text: "" });
    assert.deepEqual(parseWhisperJson(null), { words: [], text: "" });
  });

  it("merges BPE subwords so captions never split mid-word", () => {
    const { words, text } = parseWhisperJson({
      transcription: [
        { text: "Hel", offsets: { from: 0, to: 120 }, tokens: [{ text: "Hel", p: 0.9 }] },
        { text: "lo", offsets: { from: 120, to: 200 }, tokens: [{ text: "lo", p: 0.8 }] },
        { text: " world", offsets: { from: 200, to: 400 }, tokens: [{ text: " world", p: 0.95 }] },
        { text: "!", offsets: { from: 400, to: 430 }, tokens: [{ text: "!", p: 0.99 }] },
      ],
    });
    assert.deepEqual(words, [
      { word: "Hello", start_ms: 0, end_ms: 200, conf: 0.8 },
      { word: "world!", start_ms: 200, end_ms: 430, conf: 0.95 },
    ]);
    assert.equal(text, "Hello world!");
  });

  it("splits full-sentence segments with interpolated timings", () => {
    const { words, text } = parseWhisperJson({
      transcription: [{ text: "one two", offsets: { from: 0, to: 600 }, tokens: [] }],
    });
    assert.equal(words.length, 2);
    assert.equal(words[0].word, "one");
    assert.equal(words[1].word, "two");
    assert.equal(words[0].start_ms, 0);
    assert.equal(words[1].end_ms, 600);
    assert.ok(words[0].end_ms <= words[1].end_ms);
    assert.equal(text, "one two");
  });
});

describe("parseSilenceOutput", () => {
  it("pairs starts with ends, filters short and unclosed intervals", () => {
    const stderr = [
      "[silencedetect @ 0x1] silence_start: 0",
      "[silencedetect @ 0x1] silence_end: 3.1115 | silence_duration: 3.1115",
      "[silencedetect @ 0x1] silence_start: 18.657958",
      "[silencedetect @ 0x1] silence_end: 19.077854 | silence_duration: 0.419896",
      "[silencedetect @ 0x1] silence_start: 99.0",
    ].join("\n");
    assert.deepEqual(parseSilenceOutput(stderr, 400), [
      { start_ms: 0, end_ms: 3112 },
      { start_ms: 18658, end_ms: 19078 },
    ]);
    assert.deepEqual(parseSilenceOutput(stderr, 1000), [{ start_ms: 0, end_ms: 3112 }]);
    assert.deepEqual(parseSilenceOutput("no silence here", 400), []);
  });
});
