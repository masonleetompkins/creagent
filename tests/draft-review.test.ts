import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseStructure, splitLegacyOptions } from "../components/draft-review";

describe("parseStructure", () => {
  it("accepts valid structures and rejects garbage", () => {
    assert.equal(parseStructure(null), null);
    assert.equal(parseStructure(""), null);
    assert.equal(parseStructure("{nope"), null);
    assert.equal(parseStructure(JSON.stringify({ layout: "pick-one", options: [] })), null);
    const ok = parseStructure(
      JSON.stringify({
        layout: "hooks-plus-body",
        options: [{ label: "Bold claim", body: "H" }],
        body: "2. post",
      }),
    );
    assert.equal(ok?.layout, "hooks-plus-body");
    assert.equal(ok?.options[0].label, "Bold claim");
    // Unknown layouts and missing labels degrade, never crash.
    const weird = parseStructure(JSON.stringify({ layout: "zzz", options: [{ body: "B" }] }));
    assert.equal(weird?.layout, "prose");
    assert.equal(weird?.options[0].label, "Option");
  });
});

describe("splitLegacyOptions", () => {
  it("splits Variant/Option soup into cards", () => {
    const split = splitLegacyOptions("Variant 1:\nFirst post here\n\n---\n\nVariant 2:\nSecond post here");
    assert.equal(split?.length, 2);
    assert.equal(split?.[0].body, "First post here");
    assert.equal(split?.[1].label, "Option 2");
    assert.equal(splitLegacyOptions("Just one plain post."), null);
    assert.equal(splitLegacyOptions("Option 1 (Contrarian):\nOnly one"), null);
  });
});
