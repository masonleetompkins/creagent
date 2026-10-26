import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractSlidesJson } from "../lib/carousel-copy";
import { buildImagePrompt } from "../lib/carousel-plan";
import { isHexColor, isLayout } from "../lib/carousel";
import { extractVisionJson } from "../lib/photo-vision";

describe("extractSlidesJson", () => {
  it("parses a raw slide array", () => {
    const slides = extractSlidesJson(
      '[{"heading":"H","body":"B","layout":"cover","image_idea":"sun"}]',
    );
    assert.deepEqual(slides, [
      { heading: "H", body: "B", layout: "cover", image_idea: "sun" },
    ]);
  });

  it("unwraps fenced json and {slides} objects", () => {
    const slides = extractSlidesJson(
      '```json\n{"slides": [{"heading":"H","body":"B"}]}\n```',
    );
    assert.equal(slides.length, 1);
    assert.equal(slides[0].heading, "H");
  });

  it("defaults unknown layouts to content and fills missing fields", () => {
    const slides = extractSlidesJson('[{"heading":"H","layout":"diagonal"}]');
    assert.deepEqual(slides, [
      { heading: "H", body: "", layout: "content", image_idea: "" },
    ]);
  });

  it("throws when the model returns no JSON", () => {
    assert.throws(() => extractSlidesJson("here are your slides, enjoy"), /JSON/);
  });
});

describe("extractVisionJson", () => {
  it("parses raw vision JSON", () => {
    assert.deepEqual(
      extractVisionJson('{"description":"A dog","tags":["dog"],"suggested":"pets"}'),
      { description: "A dog", tags: ["dog"], suggested: "pets" },
    );
  });

  it("falls back to raw text when the model rambles", () => {
    const out = extractVisionJson("a blurry photo of a stage");
    assert.equal(out.description, "a blurry photo of a stage");
    assert.deepEqual(out.tags, []);
  });

  it("fills missing fields instead of crashing", () => {
    assert.deepEqual(extractVisionJson('{"tags":"not-an-array"}'), {
      description: '{"tags":"not-an-array"}',
      tags: [],
      suggested: "",
    });
  });
});

describe("buildImagePrompt", () => {
  it("prefers the slide's own image idea", () => {
    assert.equal(
      buildImagePrompt({ heading: "H", body: "B", image_prompt: "a neon city" }),
      "a neon city",
    );
  });

  it("builds from heading and body otherwise", () => {
    const prompt = buildImagePrompt({ heading: "Hooks", body: "Stop scrolling.", image_prompt: null });
    assert.match(prompt, /Hooks/);
    assert.match(prompt, /Stop scrolling/);
    assert.match(prompt, /no text in the image/);
  });
});

describe("carousel guards", () => {
  it("validates hex colors", () => {
    assert.equal(isHexColor("#0b5fff"), true);
    assert.equal(isHexColor("blue"), false);
    assert.equal(isHexColor("#fff"), false);
  });

  it("validates layouts", () => {
    assert.equal(isLayout("cover"), true);
    assert.equal(isLayout("content"), true);
    assert.equal(isLayout("photo"), true);
    assert.equal(isLayout("cta"), true);
    assert.equal(isLayout("diagonal"), false);
  });
});
