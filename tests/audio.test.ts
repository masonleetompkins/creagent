import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { commonsSearchUrl, parseCommonsResponse } from "../lib/audio";

const SAMPLE = {
  query: {
    pages: {
      "1": {
        title: "File:Thunder.wav",
        imageinfo: [
          {
            url: "https://upload.wikimedia.org/wikipedia/commons/1/1b/Thunder.wav",
            size: 6190364,
            duration: 35.059,
            extmetadata: {
              LicenseShortName: { value: "CC BY-SA 4.0" },
              LicenseUrl: { value: "https://creativecommons.org/licenses/by-sa/4.0" },
              Artist: { value: "<bdi>Subhashish Panigrahi</bdi>" },
              ImageDescription: { value: "Recording of thunder." },
            },
          },
        ],
      },
      "2": { title: "File:NoInfo.ogg" },
    },
  },
};

describe("commons audio", () => {
  it("builds a filetype-scoped search URL", () => {
    const url = commonsSearchUrl("thunder storm", 5);
    assert.match(url, /commons\.wikimedia\.org\/w\/api\.php/);
    assert.ok(url.includes("gsrsearch=filetype%3Aaudio+thunder+storm") || url.includes("filetype"));
    assert.match(url, /gsrlimit=5/);
  });

  it("parses pages into results and strips HTML", () => {
    const results = parseCommonsResponse(SAMPLE);
    assert.equal(results.length, 1);
    assert.deepEqual(results[0], {
      title: "Thunder.wav",
      url: "https://upload.wikimedia.org/wikipedia/commons/1/1b/Thunder.wav",
      size: 6190364,
      duration_ms: 35059,
      license: "CC BY-SA 4.0",
      license_url: "https://creativecommons.org/licenses/by-sa/4.0",
      artist: "Subhashish Panigrahi",
      description: "Recording of thunder.",
    });
  });

  it("returns empty on malformed responses", () => {
    assert.deepEqual(parseCommonsResponse({}), []);
    assert.deepEqual(parseCommonsResponse(null), []);
  });
});
