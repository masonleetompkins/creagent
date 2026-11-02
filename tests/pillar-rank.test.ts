import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { rankPillars } from "../components/pillars-manager";

describe("rankPillars", () => {
  it("orders highest multiple first, nulls last, ties by posts then name", () => {
    const ranked = rankPillars([
      { name: "mid", multiplier: 2, posts: 10 },
      { name: "unscored", multiplier: null, posts: 99 },
      { name: "top", multiplier: 9.5, posts: 1 },
      { name: "tie-many", multiplier: 2, posts: 30 },
      { name: "alpha", multiplier: 2, posts: 10 },
    ]);
    assert.deepEqual(
      ranked.map((p) => p.name),
      ["top", "tie-many", "alpha", "mid", "unscored"],
    );
  });

  it("does not mutate the input list", () => {
    const input = [
      { name: "b", multiplier: 1 },
      { name: "a", multiplier: 5 },
    ];
    rankPillars(input);
    assert.deepEqual(input.map((p) => p.name), ["b", "a"]);
  });
});
