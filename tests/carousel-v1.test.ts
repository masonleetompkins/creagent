import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.SQLITE_PATH = join(mkdtempSync(join(tmpdir(), "creagent-carousel-v1-")), "test.sqlite");
process.env.PHOTOS_DIR = mkdtempSync(join(tmpdir(), "creagent-photos-"));

before(async () => {
  await import("../scripts/migrate");
});

describe("splitApprovedCopy", () => {
  it("turns blank-line blocks into cover/content/cta slides", async () => {
    const { splitApprovedCopy } = await import("../lib/carousel-copy");
    const slides = splitApprovedCopy(
      "Hook line here\n\nFirst point with some detail.\n\nSecond point.\n\nFollow for more",
    );
    assert.equal(slides.length, 4);
    assert.equal(slides[0].layout, "cover");
    assert.equal(slides[3].layout, "cta");
    assert.equal(slides[0].heading, "Hook line here");
    assert.match(slides[1].heading, /First point/);
  });

  it("splits over-long blocks into continuation slides", async () => {
    const { splitApprovedCopy } = await import("../lib/carousel-copy");
    const long = `Title\n${"word ".repeat(120)}`;
    const slides = splitApprovedCopy(long);
    assert.ok(slides.length >= 2);
    assert.ok(slides.every((s) => s.body.length <= 240));
    assert.match(slides[1].heading, /cont\./);
  });

  it("drops the caption and splits on SLIDE markers", async () => {
    const { splitApprovedCopy } = await import("../lib/carousel-copy");
    const slides = splitApprovedCopy(
      "Hook line here. Agree? #a #b\n\nSLIDE 1: Cover hook opens loop\n\nSLIDE 2: Because of that, point two.\n\nSLIDE 3: Payoff plus comment CTA",
    );
    assert.equal(slides.length, 3);
    assert.ok(!slides.some((s) => `${s.heading} ${s.body}`.includes("#a")));
    assert.ok(!slides.some((s) => s.heading.toLowerCase().startsWith("slide")));
    assert.equal(slides[0].layout, "cover");
    assert.equal(slides[2].layout, "cta");
    assert.match(slides[0].heading, /Cover hook/);
  });

  it("caps at ten slides and never returns empties", async () => {
    const { splitApprovedCopy } = await import("../lib/carousel-copy");
    const many = Array.from({ length: 14 }, (_, i) => `Point ${i + 1}`).join("\n\n");
    const slides = splitApprovedCopy(many);
    assert.equal(slides.length, 10);
    assert.equal(splitApprovedCopy("   \n\n  ").length, 0);
  });
});

describe("clearBand / bandTopClearOf", () => {
  it("sits at the bottom when nothing is marked", async () => {
    const { clearBand } = await import("../lib/photo-regions");
    const { bandTopClearOf } = await import("../lib/carousel-render");
    assert.deepEqual(clearBand([], 0.4), { top: 0.6, bottom: true });
    assert.equal(bandTopClearOf([], 0.4), 0.6);
  });

  it("climbs above a bottom region, server and client agreeing", async () => {
    const { clearBand } = await import("../lib/photo-regions");
    const { bandTopClearOf } = await import("../lib/carousel-render");
    const regions = [{ id: "r", url: "u", x: 0, y: 0.6, w: 1, h: 0.4, label: "face", created_at: "" }];
    assert.deepEqual(clearBand(regions, 0.3), { top: 0.3, bottom: false });
    assert.equal(bandTopClearOf(regions, 0.3), 0.3);
  });

  it("falls back to the bottom when fully covered", async () => {
    const { clearBand } = await import("../lib/photo-regions");
    const regions = [{ id: "r", url: "u", x: 0, y: 0, w: 1, h: 1, label: "", created_at: "" }];
    assert.deepEqual(clearBand(regions, 0.3), { top: 0.7, bottom: true });
  });
});

describe("photo regions", () => {
  it("adds, lists, and deletes zones; rejects out-of-bounds boxes", async () => {
    const { addRegion, deleteRegion, listRegions } = await import("../lib/photo-regions");
    const url = `local:${randomUUID()}.jpg`;
    assert.throws(() => addRegion(url, { x: 0.8, y: 0.8, w: 0.3, h: 0.3 }), /fit inside/);
    const row = addRegion(url, { x: 0.1, y: 0.1, w: 0.3, h: 0.3, label: "face" });
    assert.equal(listRegions(url).length, 1);
    assert.equal(listRegions("local:other.jpg").length, 0);
    assert.equal(deleteRegion(row.id), true);
    assert.equal(deleteRegion(row.id), false);
  });
});

describe("photo uploads", () => {
  it("saves bytes to disk and registers an empty label row", async () => {
    const { savePhotoUpload, listPhotos, readLocalPhoto } = await import("../lib/photos");
    const u8 = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
    const { url } = await savePhotoUpload({
      name: "shot.jpg",
      size: u8.length,
      arrayBuffer: async () => u8.buffer as ArrayBuffer,
    });
    assert.ok(url.startsWith("local:"));
    const hit = readLocalPhoto(url);
    assert.ok(hit && hit.mime === "image/jpeg");
    assert.deepEqual([...hit.data.subarray(0, 4)], [0xff, 0xd8, 0xff, 0xd9]);
    assert.ok(listPhotos().some((p) => p.url === url && p.source === "upload"));
  });

  it("deletes uploads from disk and hides ingested URLs forever", async () => {
    const { savePhotoUpload, deletePhoto, listPhotos, readLocalPhoto } = await import("../lib/photos");
    const { getDb, nowIso } = await import("../lib/db");
    const u8 = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
    const { url } = await savePhotoUpload({
      name: "gone.jpg",
      size: u8.length,
      arrayBuffer: async () => u8.buffer as ArrayBuffer,
    });
    assert.ok(readLocalPhoto(url));
    deletePhoto(url);
    assert.equal(readLocalPhoto(url), null);
    assert.ok(!listPhotos().some((p) => p.url === url));
    // Ingested URL: hidden survives re-derivation from the asset row.
    const db = getDb();
    const assetId = "asset-hide-test";
    db.prepare(
      `INSERT OR REPLACE INTO assets (id, source, title, metadata, created_at) VALUES (?, 'x', 't', ?, ?)`,
    ).run(assetId, JSON.stringify({ raw: { image: "https://cdn.example/hide-me.jpg" } }), nowIso());
    assert.ok(listPhotos(200).some((p) => p.url === "https://cdn.example/hide-me.jpg"));
    deletePhoto("https://cdn.example/hide-me.jpg");
    assert.ok(!listPhotos(200).some((p) => p.url === "https://cdn.example/hide-me.jpg"));
    db.prepare(`DELETE FROM assets WHERE id = ?`).run(assetId);
  });

  it("rejects empty and oversized files", async () => {
    const { savePhotoUpload } = await import("../lib/photos");
    await assert.rejects(
      savePhotoUpload({ name: "e.jpg", size: 0, arrayBuffer: async () => new ArrayBuffer(0) }),
      /empty/,
    );
    await assert.rejects(
      savePhotoUpload({
        name: "big.jpg",
        size: 26 * 1024 * 1024,
        arrayBuffer: async () => new ArrayBuffer(0),
      }),
      /25MB/,
    );
  });
});

describe("slidePhotoUrl", () => {
  it("resolves photo:, asset:, and generated sources", async () => {
    const { slidePhotoUrl } = await import("../lib/carousel-image");
    assert.equal(slidePhotoUrl({ image_source: "photo:local:abc.jpg" }), "local:abc.jpg");
    assert.equal(slidePhotoUrl({ image_source: null }), null);
    assert.equal(slidePhotoUrl({ image_source: "gen:req-1" }), null);
    assert.equal(slidePhotoUrl({ image_source: "asset:missing" }), null);
  });
});

describe("downloadPhotoForSlide with uploads", () => {
  it("copies a local: photo onto the slide without an asset", async () => {
    const { savePhotoUpload } = await import("../lib/photos");
    const { createProject, addSlide, getSlide } = await import("../lib/carousel");
    const { downloadPhotoForSlide } = await import("../lib/carousel-image");
    const u8 = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const { url } = await savePhotoUpload({
      name: "art.png",
      size: u8.length,
      arrayBuffer: async () => u8.buffer as ArrayBuffer,
    });
    const project = createProject({ title: "t" });
    const slide = addSlide(project.id, { heading: "H" });
    await downloadPhotoForSlide(slide.id, null, url);
    const after = getSlide(slide.id);
    assert.ok(after?.image_path?.endsWith(".png"));
    assert.equal(after?.image_source, `photo:${url}`);
  });
});

describe("draftCarouselFromSlot", () => {
  it("builds slides from approved copy with no library matches", async () => {
    const { getDb, nowIso } = await import("../lib/db");
    const { draftCarouselFromSlot } = await import("../lib/carousel-copy");
    const { listSlides } = await import("../lib/carousel");
    const db = getDb();
    const slotId = randomUUID();
    const draftId = randomUUID();
    const ts = nowIso();
    db.prepare(
      `INSERT INTO queue_slots (id, scheduled_at, content_type, platforms, status, created_at)
       VALUES (?, ?, 'carousel', '[]', 'green', ?)`,
    ).run(slotId, "2026-11-01T09:00:00.000Z", ts);
    db.prepare(
      `INSERT INTO drafts (id, slot_id, kind, body, status, created_at) VALUES (?, ?, 'carousel', ?, 'draft', ?)`,
    ).run(draftId, slotId, "Stop doing this\n\nReason one is clear.\n\nReason two is clearer.\n\nFollow along", ts);
    db.prepare(
      `UPDATE queue_slots SET approved_draft_id = ?, approved_option = 0 WHERE id = ?`,
    ).run(draftId, slotId);
    const out = await draftCarouselFromSlot(slotId);
    assert.equal(out.slides, 4);
    assert.equal(out.picks, 0);
    assert.equal(out.unmatched.length, 4);
    assert.equal(listSlides(out.projectId).length, 4);
    const status = db.prepare(`SELECT status FROM queue_slots WHERE id = ?`).get(slotId) as {
      status: string;
    };
    assert.equal(status.status, "orange");
  });

  it("refuses slots without an approval", async () => {
    const { getDb, nowIso } = await import("../lib/db");
    const { draftCarouselFromSlot } = await import("../lib/carousel-copy");
    const slotId = randomUUID();
    getDb()
      .prepare(
        `INSERT INTO queue_slots (id, scheduled_at, content_type, platforms, status, created_at)
         VALUES (?, ?, 'carousel', '[]', 'red', ?)`,
      )
      .run(slotId, "2026-11-01T09:00:00.000Z", nowIso());
    await assert.rejects(() => draftCarouselFromSlot(slotId), /approve/);
    await assert.rejects(() => draftCarouselFromSlot(randomUUID()), /not found/);
  });
});

describe("avenir fonts", () => {
  it("lists all eight Avenir Next weights", async () => {
    const { HEADING_FONTS, BODY_FONTS } = await import("../lib/fonts");
    const ids = [...HEADING_FONTS, ...BODY_FONTS].map((f) => f.id);
    for (const id of [
      "avenir-black", "avenir-heavy", "avenir-bold", "avenir-demi",
      "avenir-regular", "avenir-medium", "avenir-light", "avenir-ultralight",
    ]) {
      assert.ok(ids.includes(id), `missing ${id}`);
    }
  });
});
