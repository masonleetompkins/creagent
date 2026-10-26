// SFX + music library: local files plus Wikimedia Commons (free, no key,
// parseable on command). Downloads land in the app data dir and register as
// media assets so they drop straight onto an audio track.
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getDb, nowIso } from "./db";
import { registerLocalFile } from "./media";
import { addClip } from "./video";

export type AudioKind = "sfx" | "music";

export type AudioEntry = {
  id: string;
  kind: AudioKind;
  title: string;
  source: string;
  url: string | null;
  local_path: string | null;
  duration_ms: number | null;
  license: string | null;
  created_at: string;
};

export type CommonsResult = {
  title: string;
  url: string;
  size: number | null;
  duration_ms: number | null;
  license: string | null;
  license_url: string | null;
  artist: string | null;
  description: string | null;
};

export function audioDir(): string {
  const dir = join(homedir(), ".config", "creagent", "audio");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

export function listAudio(kind?: AudioKind): AudioEntry[] {
  const db = getDb();
  if (kind) {
    return db
      .prepare(`SELECT * FROM audio_library WHERE kind = ? ORDER BY created_at DESC`)
      .all(kind) as AudioEntry[];
  }
  return db.prepare(`SELECT * FROM audio_library ORDER BY created_at DESC`).all() as AudioEntry[];
}

export function addLocalAudio(kind: AudioKind, path: string, title?: string): AudioEntry {
  const asset = registerLocalFile(path);
  const entry: AudioEntry = {
    id: randomUUID(),
    kind,
    title: title ?? asset.filename,
    source: "local",
    url: null,
    local_path: path,
    duration_ms: asset.duration_ms,
    license: null,
    created_at: nowIso(),
  };
  getDb()
    .prepare(
      `INSERT INTO audio_library (id, kind, title, source, url, local_path, duration_ms, license, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      entry.id,
      entry.kind,
      entry.title,
      entry.source,
      entry.url,
      entry.local_path,
      entry.duration_ms,
      entry.license,
      entry.created_at,
    );
  return entry;
}

export function deleteAudio(id: string): boolean {
  const result = getDb().prepare(`DELETE FROM audio_library WHERE id = ?`).run(id);
  return Number(result.changes) > 0;
}

export function commonsSearchUrl(query: string, limit = 10): string {
  const params = new URLSearchParams({
    action: "query",
    format: "json",
    prop: "imageinfo",
    iiprop: "url|size|mime|extmetadata",
    generator: "search",
    gsrsearch: `filetype:audio ${query}`,
    gsrnamespace: "6",
    gsrlimit: String(Math.min(50, Math.max(1, limit))),
  });
  return `https://commons.wikimedia.org/w/api.php?${params.toString()}`;
}

function stripHtml(value: string): string {
  return value.replace(/<[^>]*>/g, "").trim().slice(0, 300);
}

// Pure: parse a Commons API response into download candidates.
export function parseCommonsResponse(input: unknown): CommonsResult[] {
  const pages = (input as { query?: { pages?: Record<string, unknown> } })?.query?.pages;
  if (!pages || typeof pages !== "object") return [];
  const out: CommonsResult[] = [];
  for (const page of Object.values(pages)) {
    const p = page as {
      title?: unknown;
      imageinfo?: Array<{
        url?: unknown;
        size?: unknown;
        duration?: unknown;
        extmetadata?: Record<string, { value?: unknown }>;
      }>;
    };
    const info = p.imageinfo?.[0];
    if (typeof p.title !== "string" || typeof info?.url !== "string") continue;
    const meta = info.extmetadata ?? {};
    const text = (key: string): string | null => {
      const v = meta[key]?.value;
      if (typeof v !== "string" || !v.trim()) return null;
      return stripHtml(v);
    };
    out.push({
      title: p.title.replace(/^File:/, ""),
      url: info.url,
      size: typeof info.size === "number" ? info.size : null,
      duration_ms: typeof info.duration === "number" ? Math.round(info.duration * 1000) : null,
      license: text("LicenseShortName"),
      license_url: text("LicenseUrl"),
      artist: text("Artist"),
      description: text("ImageDescription"),
    });
  }
  return out;
}

async function fetchRetry(
  fetchImpl: typeof fetch,
  url: string,
  options: RequestInit,
  attempts = 3,
): Promise<Response> {
  let lastError = "";
  for (let i = 0; i < attempts; i++) {
    try {
      return await fetchImpl(url, options);
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
    }
  }
  throw new Error(`fetch failed after ${attempts} tries: ${lastError}`);
}

export async function searchCommons(
  query: string,
  limit = 10,
  fetchImpl: typeof fetch = fetch,
): Promise<CommonsResult[]> {
  const res = await fetchRetry(fetchImpl, commonsSearchUrl(query, limit), {
    headers: { "User-Agent": "Creagent/1.0 (local-first creator agent)" },
  });
  if (!res.ok) throw new Error(`Commons search failed: HTTP ${res.status}`);
  return parseCommonsResponse((await res.json()) as unknown);
}

export async function fetchCommonsAudio(
  kind: AudioKind,
  result: CommonsResult,
  fetchImpl: typeof fetch = fetch,
): Promise<AudioEntry> {
  const res = await fetchRetry(fetchImpl, result.url, {
    headers: { "User-Agent": "Creagent/1.0 (local-first creator agent)" },
  });
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length === 0) throw new Error("downloaded an empty file");
  if (buf.length > 200 * 1024 * 1024) throw new Error("file is over the 200MB fetch cap");
  const safe = result.title.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 120) || "audio";
  const path = join(audioDir(), `${randomUUID()}-${safe}`);
  writeFileSync(path, buf);
  const asset = registerLocalFile(path);
  const entry: AudioEntry = {
    id: randomUUID(),
    kind,
    title: result.title,
    source: "wikimedia-commons",
    url: result.url,
    local_path: path,
    duration_ms: result.duration_ms ?? asset.duration_ms,
    license: result.license,
    created_at: nowIso(),
  };
  getDb()
    .prepare(
      `INSERT INTO audio_library (id, kind, title, source, url, local_path, duration_ms, license, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      entry.id,
      entry.kind,
      entry.title,
      entry.source,
      entry.url,
      entry.local_path,
      entry.duration_ms,
      entry.license,
      entry.created_at,
    );
  return entry;
}

// Drop a library entry onto an audio track (append, or ripple-insert atMs).
export function audioToTimeline(
  entryId: string,
  projectId: string,
  atMs?: number,
): { clipId: string } {
  const db = getDb();
  const entry = db
    .prepare(`SELECT * FROM audio_library WHERE id = ?`)
    .get(entryId) as AudioEntry | undefined;
  if (!entry || !entry.local_path) throw new Error("audio entry not found or not downloaded");
  const asset = db
    .prepare(`SELECT id, duration_ms FROM media_assets WHERE path = ?`)
    .get(entry.local_path) as { id: string; duration_ms: number | null } | undefined;
  if (!asset) throw new Error("downloaded file is missing from the media library");
  const track = db
    .prepare(
      `SELECT id FROM video_tracks WHERE project_id = ? AND kind = 'audio'
       ORDER BY position ASC LIMIT 1`,
    )
    .get(projectId) as { id: string } | undefined;
  if (!track) throw new Error("project has no audio track");
  const clip = addClip({
    trackId: track.id,
    assetId: asset.id,
    name: entry.title,
    inMs: 0,
    durationMs: asset.duration_ms ?? entry.duration_ms ?? 10000,
    atMs,
  });
  return { clipId: clip.id };
}
