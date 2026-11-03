import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.SQLITE_PATH = join(mkdtempSync(join(tmpdir(), "creagent-fit-")), "test.sqlite");

before(async () => {
  await import("../scripts/migrate");
});

async function seed() {
  const { getDb, nowIso } = await import("../lib/db");
  const db = getDb();
  const pillar = randomUUID();
  db.prepare(`INSERT INTO pillars (id, name, created_at) VALUES (?, 'ELI5 Money', ?)`).run(
    pillar,
    nowIso(),
  );
  const asset = (
    source: string,
    multiplier: number | null,
    title: string,
    pillarId: string | null = pillar,
  ) => {
    db.prepare(
      `INSERT INTO assets (id, source, title, created_at, is_reply, pillar_id, multiplier)
       VALUES (?, ?, ?, ?, 0, ?, ?)`,
    ).run(randomUUID(), source, title, nowIso(), pillarId, multiplier);
  };
  // Pillar flops on TikTok, wins on X.
  asset("zernio_tiktok", 0.3, "coins explained slowly");
  asset("zernio_tiktok", 0.5, "budget talk flop");
  asset("zernio_twitter", 2.4, "money thread banger");
  // Platform-native winners from other pillars.
  asset("zernio_tiktok", 4.1, "pov you check your balance", null);
  asset("zernio_tiktok", 3.3, "day trader morning routine", null);
  return pillar;
}

describe("platformFitFor", () => {
  it("reports per-platform multiples, winners, and guides", async () => {
    const pillar = await seed();
    const { platformFitFor } = await import("../lib/platform-fit");
    const fits = platformFitFor(pillar, ["tiktok", "x"], "short_post");
    assert.equal(fits.length, 2);
    const tiktok = fits.find((f) => f.platform === "tiktok")!;
    assert.equal(tiktok.pillarPosts, 2);
    assert.equal(tiktok.pillarMultiple, 0.4);
    assert.equal(tiktok.winners.length, 2);
    assert.equal(tiktok.winners[0].title, "pov you check your balance");
    assert.ok((tiktok.guide ?? "").length > 50);
    const x = fits.find((f) => f.platform === "x")!;
    assert.equal(x.pillarMultiple, 2.4);
  });

  it("picks the YouTube guide by content type", async () => {
    const pillar = await seed();
    const { platformFitFor } = await import("../lib/platform-fit");
    const shorts = platformFitFor(pillar, ["youtube"], "video_yap");
    assert.equal(shorts.length, 1);
    assert.match(shorts[0].guide ?? "", /Shorts feed/);
    const community = platformFitFor(pillar, ["youtube"], "short_post");
    assert.equal(community.length, 1);
    assert.match(community[0].guide ?? "", /See More/);
  });

  it("skips platforms with no data at all", async () => {
    const { platformFitFor } = await import("../lib/platform-fit");
    assert.deepEqual(platformFitFor(randomUUID(), ["blog"], "short_post"), []);
    assert.deepEqual(platformFitFor(randomUUID(), [], "short_post"), []);
  });
});

describe("buildFitSection", () => {
  it("flags weak fits and shows winners", async () => {
    const pillar = await seed();
    const { platformFitFor, buildFitSection } = await import("../lib/platform-fit");
    const section = buildFitSection(platformFitFor(pillar, ["tiktok", "x"], "short_post"), "ELI5 Money");
    assert.match(section, /PLATFORM FIT/);
    assert.match(section, /TikTok.*"ELI5 Money" — WEAK FIT \(0\.4x/);
    assert.match(section, /pov you check your balance.*4\.1x/);
    assert.match(section, /X.*"ELI5 Money" — strong fit \(2\.4x/);
  });

  it("isWeakFit matches the WEAK verdict boundary", async () => {
    const pillar = await seed();
    const { platformFitFor, isWeakFit } = await import("../lib/platform-fit");
    const fits = platformFitFor(pillar, ["tiktok", "x"], "short_post");
    assert.equal(isWeakFit(fits.find((f) => f.platform === "tiktok")!), true);
    assert.equal(isWeakFit(fits.find((f) => f.platform === "x")!), false);
    assert.equal(isWeakFit({ pillarMultiple: null, pillarPosts: 0 } as never), false);
  });

  it("returns empty when there is nothing to say", async () => {
    const { buildFitSection } = await import("../lib/platform-fit");
    assert.equal(buildFitSection([], "ELI5 Money"), "");
  });
});

describe("pillar exemplars and tic bans", () => {
  it("shows pillar winners and bans tics the pillar never uses", async () => {
    const { getDb, nowIso } = await import("../lib/db");
    const { buildPillarSection, pillarTicBans } = await import("../lib/platform-fit");
    const db = getDb();
    const pillar = randomUUID();
    db.prepare(`INSERT INTO pillars (id, name, created_at) VALUES (?, 'News', ?)`).run(pillar, nowIso());
    for (let i = 0; i < 6; i++) {
      db.prepare(
        `INSERT INTO assets (id, source, title, created_at, is_reply, pillar_id, multiplier)
         VALUES (?, 'zernio_twitter', ?, ?, 0, ?, ?)`,
      ).run(randomUUID(), `news post ${i}`, nowIso(), pillar, 2 + i * 0.1);
    }
    assert.deepEqual(pillarTicBans(pillar), ["the 'Explain like I'm five' opener"]);
    const { section, hasFormat } = buildPillarSection(pillar, "News", ["x"]);
    assert.equal(hasFormat, true);
    assert.match(section, /THIS PILLAR'S WINNERS/);
    assert.match(section, /news post 5.*2\.5x/);
    assert.match(section, /HARD RULE: this pillar never uses/);
  });

  it("picks a high-effort flop as contrast, never a lazy one", async () => {
    const { getDb, nowIso } = await import("../lib/db");
    const { pillarFlop } = await import("../lib/platform-fit");
    const db = getDb();
    const pillar = randomUUID();
    db.prepare(`INSERT INTO pillars (id, name, created_at) VALUES (?, 'Flop', ?)`).run(pillar, nowIso());
    const asset = (title: string, mult: number, video = 0, pad = "") => {
      db.prepare(
        `INSERT INTO assets (id, source, title, transcript, is_video, created_at, is_reply, pillar_id, multiplier)
         VALUES (?, 'zernio_twitter', ?, ?, ?, ?, 0, ?, ?)`,
      ).run(randomUUID(), title, pad, video, nowIso(), pillar, mult);
    };
    asset("winner", 3.0);
    asset("mid", 1.0);
    asset("lazy flop", 0.1);
    asset("tryhard flop with a long thoughtful take", 0.2, 0, "x".repeat(2000));
    asset("video mid", 1.2, 1);
    const flop = pillarFlop(pillar);
    assert.equal(flop?.multiple, 0.2);
    assert.match(flop?.title ?? "", /tryhard flop/);
    assert.equal(pillarFlop(randomUUID()), null);
  });

  it("leaves ELI5 pillars alone and stays silent without data", async () => {
    const { getDb, nowIso } = await import("../lib/db");
    const { buildPillarSection, pillarTicBans } = await import("../lib/platform-fit");
    const db = getDb();
    const pillar = randomUUID();
    db.prepare(`INSERT INTO pillars (id, name, created_at) VALUES (?, 'ELI5', ?)`).run(pillar, nowIso());
    for (let i = 0; i < 5; i++) {
      db.prepare(
        `INSERT INTO assets (id, source, title, created_at, is_reply, pillar_id, multiplier)
         VALUES (?, 'zernio_twitter', ?, ?, 0, ?, 1.5)`,
      ).run(randomUUID(), `Explain like I'm five: thing ${i}`, nowIso(), pillar);
    }
    assert.deepEqual(pillarTicBans(pillar), []);
    assert.equal(buildPillarSection(randomUUID(), null, ["x"]).section, "");
  });
});
