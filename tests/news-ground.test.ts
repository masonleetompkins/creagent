import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildNewsSection,
  needsNews,
  newsQueries,
  newsTopic,
  parseNewsResults,
} from "../lib/news-ground";

describe("news detection and queries", () => {
  it("detects news pillars and derives clean topics", () => {
    assert.equal(needsNews("AI News Roundup", "Daily drops"), true);
    assert.equal(needsNews("Morning Briefing", null), true);
    assert.equal(needsNews("ELI5 Mental Models", "made simple"), false);
    assert.equal(needsNews(null, null), false);
    assert.equal(newsTopic("AI News Roundup"), "AI");
    assert.deepEqual(newsQueries("AI News Roundup"), ["AI news today", "latest AI announcements"]);
    // Nothing distinctive left — fall back to the full name.
    assert.equal(newsTopic("Daily News"), "Daily News");
  });
});

describe("parseNewsResults + buildNewsSection", () => {
  it("parses Brave results and bounds the section", () => {
    const items = parseNewsResults({
      web: {
        results: [
          { title: "  Big Model Drop  ", description: "<strong>A new 70B model.</strong> It&#x27;s big.", age: "2 hours ago" },
          { title: "", description: "skipped" },
          { nope: true },
        ],
      },
    });
    assert.equal(items.length, 1);
    assert.equal(items[0].title, "Big Model Drop");
    assert.equal(items[0].snippet, "A new 70B model. It's big.");
    const section = buildNewsSection(items);
    assert.match(section, /LIVE NEWS/);
    assert.match(section, /never invent drops/);
    assert.match(section, /2 hours ago/);
    assert.match(buildNewsSection([]), /evergreen angles only/);
  });
});
