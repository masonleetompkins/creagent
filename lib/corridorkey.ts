// Client for the CorridorKey 2.0 sidecar (sidecar/corridorkey_server.py).
// Keys the full source file, registers the keyed render, and drops it on the
// Subject track above the graphics stack. fetch is injectable for tests.
import { spawn, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { extname, join } from "node:path";
import { getDb, nowIso } from "./db";
import { registerLocalFile } from "./media";
import { addClip, getClip } from "./video";

type FetchImpl = typeof fetch;

export function sidecarUrl(): string {
  return (process.env.CORRIDORKEY_URL ?? "").replace(/\/+$/, "");
}

// Local checkout lives with the project (vendor/, gitignored); override with
// CORRIDORKEY_ROOT. Remote sidecars skip all of this via CORRIDORKEY_URL.
export function ckRoot(): string {
  return process.env.CORRIDORKEY_ROOT ?? join(process.cwd(), "vendor", "corridorkey");
}

export function localRepoDir(): string {
  return join(ckRoot(), "repo");
}

function venvPython(): string {
  return join(ckRoot(), ".venv", "bin", "python");
}

export function localReady(): boolean {
  return existsSync(join(localRepoDir(), "infer.py")) && existsSync(venvPython());
}

export function sidecarScript(): string {
  return process.env.CORRIDORKEY_SERVER ?? join(process.cwd(), "sidecar", "corridorkey_server.py");
}

export function setupScript(): string {
  return join(process.cwd(), "scripts", "setup-corridorkey.sh");
}

export type SetupState = "not-installed" | "installing" | "ready" | "failed";

export function setupState(): { state: SetupState; updated_at: string | null; error?: string } {
  if (localReady()) return { state: "ready", updated_at: null };
  try {
    const raw = JSON.parse(readFileSync(join(ckRoot(), "setup.json"), "utf8")) as {
      state?: unknown;
      updated_at?: unknown;
      error?: unknown;
    };
    const state = raw.state;
    if (state === "installing" || state === "failed" || state === "not-installed") {
      return {
        state,
        updated_at: typeof raw.updated_at === "string" ? raw.updated_at : null,
        error: typeof raw.error === "string" ? raw.error : undefined,
      };
    }
  } catch {
    /* no record yet */
  }
  return { state: "not-installed", updated_at: null };
}

export function writeSetupState(state: SetupState, error?: string): void {
  mkdirSync(ckRoot(), { recursive: true });
  writeFileSync(
    join(ckRoot(), "setup.json"),
    JSON.stringify({ state, updated_at: nowIso(), error: error ?? null }),
  );
}

export function setupLogPath(): string {
  return join(ckRoot(), "setup.log");
}

export function runKeyingSetup(): { logPath: string } {
  writeSetupState("installing");
  const logPath = setupLogPath();
  mkdirSync(ckRoot(), { recursive: true });
  try {
    const out = execFileSync("bash", [setupScript()], {
      timeout: 90 * 60 * 1000,
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, CORRIDORKEY_ROOT: ckRoot() },
    });
    writeFileSync(logPath, out);
  } catch (error) {
    const msg = (error as Error).message;
    const stderr = Buffer.isBuffer((error as { stderr?: unknown }).stderr)
      ? String((error as { stderr: Buffer }).stderr)
      : "";
    writeFileSync(logPath, `${msg}\n${stderr}`.slice(-20000));
    writeSetupState("failed", msg.slice(0, 500));
    throw error;
  }
  if (!localReady()) {
    writeSetupState("failed", "installer finished but infer.py or the venv is missing");
    throw new Error("installer finished but the checkout is incomplete");
  }
  writeSetupState("ready");
  return { logPath };
}

export function managedPort(): number {
  const port = Number(process.env.CORRIDORKEY_PORT ?? 8099);
  return Number.isFinite(port) && port > 0 ? port : 8099;
}

function managedBase(): string {
  return `http://127.0.0.1:${managedPort()}`;
}

async function healthy(base: string, fetchImpl: FetchImpl): Promise<boolean> {
  try {
    const res = await fetchImpl(`${base}/health`);
    if (!res.ok) return false;
    return ((await res.json()) as { ok?: unknown }).ok === true;
  } catch {
    return false;
  }
}

// Resolve a sidecar URL, starting the managed local one on demand. Remote
// CORRIDORKEY_URL always wins when set.
export async function ensureSidecarUrl(
  fetchImpl: FetchImpl = fetch,
): Promise<{ url: string; managed: boolean }> {
  const env = sidecarUrl();
  if (env) return { url: env, managed: false };
  if (!localReady()) {
    throw new Error(
      "CorridorKey is not installed (one-click Install in the Key dialog, or run scripts/setup-corridorkey.sh)",
    );
  }
  const base = managedBase();
  if (await healthy(base, fetchImpl)) return { url: base, managed: true };
  const server = sidecarScript();
  if (!existsSync(server)) throw new Error(`sidecar server missing: ${server}`);
  const logPath = join(ckRoot(), "sidecar.log");
  const logFd = openSync(logPath, "a");
  const child = spawn(venvPython(), [server], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: {
      ...process.env,
      CORRIDORKEY_DIR: localRepoDir(),
      CORRIDORKEY_PORT: String(managedPort()),
    },
  });
  child.unref();
  writeFileSync(join(ckRoot(), "sidecar.pid"), String(child.pid ?? ""));
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    if (await healthy(base, fetchImpl)) return { url: base, managed: true };
  }
  throw new Error(`managed sidecar did not start (see ${logPath})`);
}

export type KeyStatus = {
  configured: boolean;
  reachable: boolean;
  managed: boolean;
  setup: SetupState;
  url: string | null;
  error?: string;
};

export async function keyStatus(fetchImpl: FetchImpl = fetch): Promise<KeyStatus> {
  const setup = setupState().state;
  const env = sidecarUrl();
  if (env) {
    const ok = await healthy(env, fetchImpl);
    return {
      configured: true,
      reachable: ok,
      managed: false,
      setup,
      url: env,
      error: ok ? undefined : "remote sidecar not responding",
    };
  }
  if (!localReady()) {
    return { configured: false, reachable: false, managed: true, setup, url: null };
  }
  const base = managedBase();
  const ok = await healthy(base, fetchImpl);
  return {
    configured: true,
    reachable: ok,
    managed: true,
    setup: "ready",
    url: base,
    error: ok ? undefined : "managed sidecar is asleep (it starts on the next key request)",
  };
}

function keyedDir(): string {
  const dir = join(homedir(), ".config", "creagent", "keyed");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function subjectTrackId(projectId: string): string {
  const db = getDb();
  const named = db
    .prepare(
      `SELECT id FROM video_tracks WHERE project_id = ? AND kind = 'video' AND name LIKE '%ubject%'
       ORDER BY position ASC LIMIT 1`,
    )
    .get(projectId) as { id: string } | undefined;
  if (named) return named.id;
  const first = db
    .prepare(
      `SELECT id FROM video_tracks WHERE project_id = ? AND kind = 'video'
       ORDER BY position ASC LIMIT 1`,
    )
    .get(projectId) as { id: string } | undefined;
  if (!first) throw new Error("project has no video track for the keyed subject");
  return first.id;
}

export type KeyResult = { assetId: string; clipId: string; jobId: string };

export async function requestKey(
  clipId: string,
  hintPath?: string,
  fetchImpl: FetchImpl = fetch,
  pollMs = 5000,
): Promise<KeyResult> {
  const { url: base } = await ensureSidecarUrl(fetchImpl);
  const clip = getClip(clipId);
  if (!clip || !clip.asset_id) throw new Error("clip has no source footage to key");
  const asset = getDb()
    .prepare(`SELECT path, filename FROM media_assets WHERE id = ?`)
    .get(clip.asset_id) as { path: string; filename: string } | undefined;
  if (!asset) throw new Error("source asset not found");

  const form = new FormData();
  form.append(
    "video",
    new Blob([readFileSync(asset.path)], { type: "video/mp4" }),
    asset.filename || "input.mp4",
  );
  if (hintPath) {
    form.append("hint", new Blob([readFileSync(hintPath)], { type: "image/png" }), "hint.png");
  }
  const started = await fetchImpl(`${base}/key`, { method: "POST", body: form });
  if (!started.ok) throw new Error(`sidecar refused job: HTTP ${started.status}`);
  const { job_id: jobId } = (await started.json()) as { job_id: string };

  for (;;) {
    await new Promise((r) => setTimeout(r, pollMs));
    const poll = await fetchImpl(`${base}/jobs/${jobId}`);
    if (!poll.ok) throw new Error(`sidecar lost job ${jobId}`);
    const status = (await poll.json()) as { state: string; error?: string };
    if (status.state === "failed") throw new Error(`keying failed: ${status.error ?? "unknown"}`);
    if (status.state === "done") break;
  }
  const result = await fetchImpl(`${base}/jobs/${jobId}/result`);
  if (!result.ok) throw new Error("sidecar has no result file");
  const ext = extname(asset.filename) || ".mp4";
  const outPath = join(keyedDir(), `${randomUUID()}${ext}`);
  writeFileSync(outPath, Buffer.from(await result.arrayBuffer()));

  const keyed = registerLocalFile(outPath);
  // The key covers the full source, so the timeline mapping carries over.
  const keyedClip = addClip({
    trackId: subjectTrackId(clip.project_id),
    assetId: keyed.id,
    name: `Keyed ${asset.filename}`,
    inMs: clip.in_ms,
    durationMs: clip.duration_ms,
    atMs: clip.start_ms,
  });
  return { assetId: keyed.id, clipId: keyedClip.id, jobId };
}
