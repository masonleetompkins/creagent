import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.SQLITE_PATH = join(
  mkdtempSync(join(tmpdir(), "creagent-analysis-")),
  "test.sqlite",
);

before(async () => {
  await import("../scripts/migrate");
});

describe("countUnanalyzed", () => {
  it("counts only assets missing analyzed_at", async () => {
    const { countUnanalyzed } = await import("../lib/analysis");
    const { getDb } = await import("../lib/db");
    const db = getDb();
    assert.equal(countUnanalyzed(), 0);
    const insert = db.prepare(
      `INSERT INTO assets (id, source, kind, title, transcript, metadata, created_at, analyzed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    insert.run("a1", "x_posts", "x_posts", "t", "", "{}", "2026-01-01T00:00:00.000Z", null);
    insert.run(
      "a2",
      "x_posts",
      "x_posts",
      "t",
      "",
      "{}",
      "2026-01-01T00:00:00.000Z",
      "2026-01-02T00:00:00.000Z",
    );
    assert.equal(countUnanalyzed(), 1);
  });
});
