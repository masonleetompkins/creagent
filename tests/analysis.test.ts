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

describe("planCorpus", () => {
  it("routes long transcripts to digest and respects the budget", async () => {
    const { planCorpus, DIGEST_CHARS } = await import("../lib/analysis");
    const row = (id: string, chars: number) => ({
      id,
      source: "x",
      title: null,
      transcript: "x".repeat(chars),
    });
    const short = row("s", 1000);
    const long = row("l", 50000);
    const plan = planCorpus([short, long]);
    assert.deepEqual(plan.direct.map((r) => r.id), ["s"]);
    assert.deepEqual(plan.digest.map((r) => r.id), ["l"]);
    assert.ok(DIGEST_CHARS <= 8000);
    // Budget overflow stops the pick: fill ~80k with shorts, the tail waits.
    const many = Array.from({ length: 40 }, (_, i) => row(`m${i}`, 3000));
    const full = planCorpus([...many, row("tail", 100)]);
    assert.ok(full.direct.length < 41);
    assert.deepEqual(full.digest, []);
    const ids = new Set(full.direct.map((r) => r.id));
    assert.ok(!ids.has("tail"));
    assert.equal(planCorpus([]).direct.length, 0);
  });
});

describe("digest cache", () => {
  it("round-trips and invalidates on length change", async () => {
    const { readDigestCache, writeDigestCache } = await import("../lib/analysis");
    const { getDb } = await import("../lib/db");
    const db = getDb();
    db.prepare(
      `INSERT INTO assets (id, source, kind, title, transcript, metadata, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run("dc1", "x", "x", "t", "hello", "{}", "2026-01-01T00:00:00.000Z");
    assert.equal(readDigestCache(db, "dc1", 5), null);
    writeDigestCache(db, "dc1", 5, "greeting");
    assert.equal(readDigestCache(db, "dc1", 5), "greeting");
    assert.equal(readDigestCache(db, "dc1", 6), null);
    assert.equal(readDigestCache(db, "missing", 5), null);
  });
});

describe("extractJson", () => {
  it("tolerates fences, prose, and trailing garbage", async () => {
    const { extractJson } = await import("../lib/analysis");
    assert.deepEqual(extractJson(`{"a": 1}`), { a: 1 });
    assert.deepEqual(extractJson("```json\n{\"a\": 1}\n```"), { a: 1 });
    assert.deepEqual(extractJson('Here you go: {"a": 1}'), { a: 1 });
    // The live failure: valid object + trailing commentary with a stray brace.
    assert.deepEqual(extractJson('{"a": 1} hope this helps } bye'), { a: 1 });
    // Braces and escaped quotes inside strings don't break balancing.
    assert.deepEqual(extractJson('{"a": "x { y } \\"q\\""} trailing'), { a: 'x { y } "q"' });
    // Nested objects stay intact.
    assert.deepEqual(extractJson('{"a": {"b": [1, {"c": 2}]}}'), { a: { b: [1, { c: 2 }] } });
    // First parseable balanced block wins.
    assert.deepEqual(extractJson('{oops} {"a": 1}'), { a: 1 });
    assert.throws(() => extractJson("no json here"), /did not return JSON/);
    assert.throws(() => extractJson('{"a": 1'), /did not return JSON/);
  });
});

describe("mapAssignments", () => {
  it("resolves names case-insensitively and drops junk", async () => {
    const { mapAssignments } = await import("../lib/analysis");
    const ids = new Map([
      ["alpha", "id-a"],
      ["beta", "id-b"],
    ]);
    const out = mapAssignments({ "1": "Alpha", "2": "BETA ", "3": "nope", "9": "Alpha", "x": "Alpha" }, 3, ids);
    assert.deepEqual([...out.entries()], [
      [1, "id-a"],
      [2, "id-b"],
    ]);
    assert.equal(mapAssignments(null, 3, ids).size, 0);
    assert.equal(mapAssignments([], 3, ids).size, 0);
  });
});

describe("mergeNameMatchesIntoConfirmed", () => {
  it("folds same-name suggestions into confirmed pillars", async () => {
    const { mergeNameMatchesIntoConfirmed } = await import("../lib/analysis");
    const { getDb } = await import("../lib/db");
    const db = getDb();
    db.prepare(
      `INSERT INTO pillars (id, name, description, voice_notes, confirmed, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("mc1", "Zebra Merge", "mine", "v", 1, "2026-01-01T00:00:00.000Z");
    db.prepare(
      `INSERT INTO pillars (id, name, description, voice_notes, confirmed, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("mc2", "zebra merge", "dup", "", 0, "2026-01-02T00:00:00.000Z");
    db.prepare(
      `INSERT INTO assets (id, source, kind, title, transcript, metadata, pillar_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("ma1", "x", "x", "t", "", "{}", "mc2", "2026-01-03T00:00:00.000Z");
    assert.equal(mergeNameMatchesIntoConfirmed(), 1);
    assert.equal(mergeNameMatchesIntoConfirmed(), 0);
    const asset = db.prepare(`SELECT pillar_id FROM assets WHERE id = ?`).get("ma1") as {
      pillar_id: string;
    };
    assert.equal(asset.pillar_id, "mc1");
    const gone = db.prepare(`SELECT id FROM pillars WHERE id = ?`).get("mc2");
    assert.equal(gone, undefined);
  });
});

describe("applyConsolidation", () => {
  it("merges losers into survivors and re-points every link", async () => {
    const { applyConsolidation } = await import("../lib/analysis");
    const { getDb } = await import("../lib/db");
    const db = getDb();
    const mkpillar = db.prepare(
      `INSERT INTO pillars (id, name, description, voice_notes, confirmed, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    );
    mkpillar.run("ca", "Alpha", "da", "", 0, "2026-01-01T00:00:00.000Z");
    mkpillar.run("cb", "Beta", "db", "", 0, "2026-01-02T00:00:00.000Z");
    mkpillar.run("cc", "Confirmed", "dc", "vc", 1, "2026-01-03T00:00:00.000Z");
    mkpillar.run("cd", "Delta", "dd", "", 0, "2026-01-04T00:00:00.000Z");
    const mkasset = db.prepare(
      `INSERT INTO assets (id, source, kind, title, transcript, metadata, pillar_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    mkasset.run("caa1", "x", "x", "t", "", "{}", "cb", "2026-01-05T00:00:00.000Z");
    mkasset.run("caa2", "x", "x", "t", "", "{}", "cb", "2026-01-06T00:00:00.000Z");
    mkasset.run("caa3", "x", "x", "t", "", "{}", "ca", "2026-01-07T00:00:00.000Z");
    db.prepare(
      `INSERT INTO queue_slots (id, scheduled_at, pillar_id, content_type, created_at) VALUES (?, ?, ?, ?, ?)`,
    ).run("cs1", "2026-02-01T00:00:00.000Z", "ca", "post", "2026-01-08T00:00:00.000Z");
    db.prepare(
      `INSERT INTO queue_templates (id, weekday, time, pillar_id, content_type, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("ct1", 1, "09:00", "ca", "post", "2026-01-08T00:00:00.000Z");
    const res = applyConsolidation([
      { name: "Alpha Prime", description: "merged", voiceNotes: "loud", absorbs: ["alpha", "BETA", "Ghost"] },
      { name: "Confirmed", description: "evil", voiceNotes: "x", absorbs: ["Confirmed"] },
    ]);
    assert.deepEqual(res.unmapped, ["Ghost"]);
    assert.equal(res.merged, 1);
    assert.equal(res.canonical, 1);
    // Survivor keeps the richest id (cb had 2 assets), renamed.
    const survivor = db.prepare(`SELECT id, name, description, voice_notes FROM pillars WHERE id = ?`).get("cb") as {
      id: string;
      name: string;
      description: string;
      voice_notes: string;
    };
    assert.equal(survivor.name, "Alpha Prime");
    assert.equal(survivor.description, "merged");
    assert.equal(survivor.voice_notes, "loud");
    assert.equal(db.prepare(`SELECT id FROM pillars WHERE id = ?`).get("ca"), undefined);
    const links = db.prepare(`SELECT pillar_id FROM assets WHERE id = ?`).get("caa3") as { pillar_id: string };
    assert.equal(links.pillar_id, "cb");
    const slot = db.prepare(`SELECT pillar_id FROM queue_slots WHERE id = ?`).get("cs1") as { pillar_id: string };
    assert.equal(slot.pillar_id, "cb");
    const tmpl = db.prepare(`SELECT pillar_id FROM queue_templates WHERE id = ?`).get("ct1") as { pillar_id: string };
    assert.equal(tmpl.pillar_id, "cb");
    // Confirmed pillar and untouched suggestion survive verbatim.
    const conf = db.prepare(`SELECT description FROM pillars WHERE id = ?`).get("cc") as { description: string };
    assert.equal(conf.description, "dc");
    assert.ok(db.prepare(`SELECT id FROM pillars WHERE id = ?`).get("cd"));
    const vault = db.prepare(`SELECT title, body FROM vault_docs WHERE doc_type = 'pillar' AND lower(title) = ?`).get("alpha prime") as {
      title: string;
      body: string;
    };
    assert.equal(vault.title, "Alpha Prime");
    assert.ok(vault.body.includes("merged"));
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
