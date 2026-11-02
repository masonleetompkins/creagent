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

describe("extractVoiceProfile + buildVoiceMarkdown", () => {
  it("extracts the full schema and tolerates legacy + garbage", async () => {
    const { extractVoiceProfile } = await import("../lib/analysis");
    const full = extractVoiceProfile({
      voice: {
        summary: "s",
        diction: "d",
        syntax: "sy",
        tone: "t",
        structure: "st",
        formatting: "f",
        topics: "to",
        donts: ["d1", "", 42],
        examples: ["e1"],
      },
    });
    assert.equal(full.summary, "s");
    assert.equal(full.formatting, "f");
    assert.deepEqual(full.donts, ["d1"]);
    assert.deepEqual(full.examples, ["e1"]);
    const legacy = extractVoiceProfile({ voice: "  plain string  " });
    assert.equal(legacy.summary, "plain string");
    assert.equal(legacy.diction, "");
    const garbage = extractVoiceProfile({ voice: 42 });
    assert.equal(garbage.summary, "");
    const missing = extractVoiceProfile({});
    assert.equal(missing.summary, "");
  });

  it("renders every section and skips empty ones", async () => {
    const { buildVoiceMarkdown } = await import("../lib/analysis");
    const md = buildVoiceMarkdown(
      {
        summary: "s",
        diction: "",
        syntax: "sy",
        tone: "",
        structure: "",
        formatting: "",
        topics: "",
        donts: ["never hashtag"],
        examples: ["hello world"],
      },
      [
        { name: "P1", voiceNotes: "loud" },
        { name: "P2", voiceNotes: "" },
      ],
    );
    for (const head of ["# Voice profile", "## Summary", "## Syntax & rhythm", "## Never do"]) {
      assert.ok(md.includes(head), `missing ${head}`);
    }
    assert.ok(!md.includes("Diction"), "empty section should be skipped");
    assert.ok(md.includes("### P1") && md.includes("loud"));
    assert.ok(!md.includes("### P2"));
    assert.ok(md.includes('"hello world"'));
  });
});

describe("upsertPillar", () => {
  it("inserts, refreshes suggestions, and preserves confirmed user edits", async () => {
    const { upsertPillar } = await import("../lib/analysis");
    const { getDb } = await import("../lib/db");
    const db = getDb();
    const first = upsertPillar(db, { name: "Energy", description: "d1", voiceNotes: "v1" });
    assert.equal(first.confirmed, 0);
    assert.equal(first.description, "d1");
    const refreshed = upsertPillar(db, { name: "energy", description: "d2", voiceNotes: "v2" });
    assert.equal(refreshed.id, first.id);
    assert.equal(refreshed.description, "d2");
    assert.equal(refreshed.voiceNotes, "v2");
    db.prepare(`UPDATE pillars SET confirmed = 1, description = ? WHERE id = ?`).run(
      "mine",
      first.id,
    );
    const kept = upsertPillar(db, { name: "ENERGY", description: "d3", voiceNotes: "v3" });
    assert.equal(kept.description, "mine");
    assert.equal(kept.voiceNotes, "v2");
    db.prepare(`UPDATE pillars SET voice_notes = '' WHERE id = ?`).run(first.id);
    const filled = upsertPillar(db, { name: "Energy", description: "d4", voiceNotes: "v4" });
    assert.equal(filled.description, "mine");
    assert.equal(filled.voiceNotes, "v4");
  });
});

describe("resetBrain", () => {
  it("wipes vault + analysis marks but keeps every pillar", async () => {
    const { resetBrain } = await import("../lib/analysis");
    const { getDb } = await import("../lib/db");
    const db = getDb();
    db.prepare(
      `INSERT INTO vault_docs (id, doc_type, title, body, created_at) VALUES (?, ?, ?, ?, ?)`,
    ).run("vd1", "voice", "Voice profile", "old", "2026-01-01T00:00:00.000Z");
    db.prepare(
      `INSERT INTO assets (id, source, kind, title, transcript, metadata, created_at, analyzed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("ra1", "x", "x", "t", "", "{}", "2026-01-01T00:00:00.000Z", "2026-01-02T00:00:00.000Z");
    db.prepare(
      `INSERT INTO pillars (id, name, description, voice_notes, confirmed, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("rp1", "Keep", "d", "v", 1, "2026-01-01T00:00:00.000Z");
    db.prepare(
      `INSERT INTO pillars (id, name, description, voice_notes, confirmed, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("rp2", "AlsoKeep", "d", "", 0, "2026-01-01T00:00:00.000Z");
    resetBrain();
    const vault = db.prepare(`SELECT COUNT(*) AS n FROM vault_docs`).get() as { n: number };
    assert.equal(vault.n, 0);
    const asset = db.prepare(`SELECT analyzed_at FROM assets WHERE id = ?`).get("ra1") as {
      analyzed_at: string | null;
    };
    assert.equal(asset.analyzed_at, null);
    const pillars = db.prepare(`SELECT id FROM pillars WHERE id IN ('rp1', 'rp2')`).all() as {
      id: string;
    }[];
    assert.deepEqual(
      pillars.map((p) => p.id).sort(),
      ["rp1", "rp2"],
    );
  });
});
