import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.SQLITE_PATH = join(mkdtempSync(join(tmpdir(), "creagent-key-")), "test.sqlite");
process.env.CORRIDORKEY_URL = "http://sidecar:8099";

before(async () => {
  await import("../scripts/migrate");
});

function mockFetch() {
  const calls: string[] = [];
  let polls = 0;
  const impl = (async (url: unknown) => {
    const u = String(url);
    calls.push(u);
    if (u.endsWith("/key")) {
      return { ok: true, status: 200, json: async () => ({ job_id: "abc" }) };
    }
    if (u.endsWith("/jobs/abc")) {
      polls++;
      return {
        ok: true,
        status: 200,
        json: async () => ({ state: polls < 2 ? "running" : "done" }),
      };
    }
    if (u.endsWith("/jobs/abc/result")) {
      return { ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode("KEYED").buffer };
    }
    if (u.endsWith("/health")) {
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe("corridorkey client", () => {
  it("keys a clip and lands the render on the Subject track", async () => {
    const { requestKey, keyStatus } = await import("../lib/corridorkey");
    const video = await import("../lib/video");
    const media = await import("../lib/media");
    const db = await import("../lib/db");
    const conn = db.getDb();
    const projectId = `p-${Date.now()}`;
    conn.prepare(
      `INSERT INTO video_projects (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)`,
    ).run(projectId, "t", db.nowIso(), db.nowIso());
    const subject = video.addTrack(projectId, "video", "Subject (keyed)");
    const main = video.addTrack(projectId, "video", "Main");
    const src = join(mkdtempSync(join(tmpdir(), "ck-src-")), "clip.mp4");
    writeFileSync(src, Buffer.from("FAKEVIDEO"));
    const asset = media.registerLocalFile(src);
    const clip = video.addClip({ trackId: main.id, assetId: asset.id, inMs: 1000, durationMs: 4000 });
    const { impl, calls } = mockFetch();
    const status = await keyStatus(impl);
    assert.equal(status.reachable, true);
    const result = await requestKey(clip.id, undefined, impl, 1);
    assert.ok(calls.some((c) => c.endsWith("/key")));
    assert.ok(calls.some((c) => c.endsWith("/jobs/abc/result")));
    const keyed = video.getClip(result.clipId);
    assert.equal(keyed?.track_id, subject.id);
    assert.equal(keyed?.start_ms, clip.start_ms);
    assert.equal(keyed?.duration_ms, clip.duration_ms);
    assert.equal(keyed?.in_ms, clip.in_ms);
  });

  it("reports unconfigured when CORRIDORKEY_URL is missing", async () => {
    const { keyStatus } = await import("../lib/corridorkey");
    const prev = process.env.CORRIDORKEY_URL;
    const prevRoot = process.env.CORRIDORKEY_ROOT;
    delete process.env.CORRIDORKEY_URL;
    process.env.CORRIDORKEY_ROOT = mkdtempSync(join(tmpdir(), "ck-empty-"));
    try {
      const status = await keyStatus(mockFetch().impl);
      assert.equal(status.configured, false);
      assert.equal(status.reachable, false);
      assert.equal(status.managed, true);
      assert.equal(status.setup, "not-installed");
      assert.equal(status.url, null);
    } finally {
      if (prev === undefined) delete process.env.CORRIDORKEY_URL;
      else process.env.CORRIDORKEY_URL = prev;
      if (prevRoot === undefined) delete process.env.CORRIDORKEY_ROOT;
      else process.env.CORRIDORKEY_ROOT = prevRoot;
    }
  });

  it("prefers CORRIDORKEY_URL verbatim without spawning", async () => {
    const { ensureSidecarUrl } = await import("../lib/corridorkey");
    const resolved = await ensureSidecarUrl(mockFetch().impl);
    assert.deepEqual(resolved, { url: "http://sidecar:8099", managed: false });
  });

  it("refuses to start when nothing is installed", async () => {
    const { ensureSidecarUrl } = await import("../lib/corridorkey");
    const prev = process.env.CORRIDORKEY_URL;
    const prevRoot = process.env.CORRIDORKEY_ROOT;
    delete process.env.CORRIDORKEY_URL;
    process.env.CORRIDORKEY_ROOT = mkdtempSync(join(tmpdir(), "ck-empty-"));
    try {
      await assert.rejects(() => ensureSidecarUrl(mockFetch().impl), /not installed/);
    } finally {
      if (prev === undefined) delete process.env.CORRIDORKEY_URL;
      else process.env.CORRIDORKEY_URL = prev;
      if (prevRoot === undefined) delete process.env.CORRIDORKEY_ROOT;
      else process.env.CORRIDORKEY_ROOT = prevRoot;
    }
  });

  it("round-trips setup state through CORRIDORKEY_ROOT", async () => {
    const { setupState, writeSetupState, localReady } = await import("../lib/corridorkey");
    const prevRoot = process.env.CORRIDORKEY_ROOT;
    process.env.CORRIDORKEY_ROOT = mkdtempSync(join(tmpdir(), "ck-state-"));
    try {
      assert.equal(localReady(), false);
      assert.equal(setupState().state, "not-installed");
      writeSetupState("failed", "boom");
      const back = setupState();
      assert.equal(back.state, "failed");
      assert.equal(back.error, "boom");
    } finally {
      if (prevRoot === undefined) delete process.env.CORRIDORKEY_ROOT;
      else process.env.CORRIDORKEY_ROOT = prevRoot;
    }
  });
});
