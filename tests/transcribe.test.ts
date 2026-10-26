import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseWhisperJson } from "../lib/transcribe";

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
});
