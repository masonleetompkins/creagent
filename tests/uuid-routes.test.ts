import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// Every route-level UUID guard must accept real UUIDs and reject junk.
// Three malformed guards shipped before this test existed (two in demo
// triage, one in plan-images) — all with the same "bad id" symptom.
const VALID = "70bb06fa-9dab-47e8-9d72-9275ec20d1aa";

function routeFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...routeFiles(full));
    else if (entry === "route.ts") out.push(full);
  }
  return out;
}

describe("route UUID guards", () => {
  it("accept valid UUIDs and reject bad ids in every route", () => {
    const files = routeFiles(join(process.cwd(), "app", "api"));
    assert.ok(files.length > 30, `expected dozens of routes, found ${files.length}`);
    let guards = 0;
    const broken: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      const match = text.match(/const UUID = \/(.+)\/([a-z]*);/);
      if (!match) continue;
      guards++;
      const re = new RegExp(match[1], match[2]);
      if (!re.test(VALID) || re.test("not-a-uuid") || re.test(VALID.slice(0, 8))) {
        broken.push(file);
      }
    }
    assert.ok(guards > 30, `expected dozens of UUID guards, found ${guards}`);
    assert.deepEqual(broken, []);
  });
});
