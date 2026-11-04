// Photo library: ingested asset URLs plus user uploads. Uploaded files
// live on disk under ~/.config/creagent/photos and are keyed `local:<file>`.
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { extname, join } from "node:path";
import { getDb, nowIso } from "./db";

export type PhotoCandidate = {
  asset_id: string | null;
  title: string | null;
  source: string;
  url: string;
};

export const LOCAL_PREFIX = "local:";

// Ingested photos are hidden until there's a good way to cull them — the
// library, vision scan, and auto-pick all see uploads only.
export const INCLUDE_INGESTED_PHOTOS = false;

export function photosDir(): string {
  const dir =
    process.env.PHOTOS_DIR ?? join(homedir(), ".config", "creagent", "photos");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export function localPhotoPath(url: string): string | null {
  if (!url.startsWith(LOCAL_PREFIX)) return null;
  const name = url.slice(LOCAL_PREFIX.length).replace(/[^a-zA-Z0-9.\-]/g, "");
  if (!name) return null;
  return join(photosDir(), name);
}

export function readLocalPhoto(url: string): { data: Buffer; mime: string } | null {
  const path = localPhotoPath(url);
  if (!path || !existsSync(path)) return null;
  const ext = extname(path).toLowerCase();
  const mime =
    ext === ".png" ? "image/png"
    : ext === ".webp" ? "image/webp"
    : ext === ".gif" ? "image/gif"
    : "image/jpeg";
  return { data: readFileSync(path), mime };
}

export const MAX_PHOTO_UPLOAD_BYTES = 25 * 1024 * 1024;

export async function savePhotoUpload(
  file: { name: string; size: number; arrayBuffer: () => Promise<ArrayBuffer> },
  assetId: string | null = null,
): Promise<{ url: string; filename: string }> {
  if (file.size === 0) throw new Error("empty file");
  if (file.size > MAX_PHOTO_UPLOAD_BYTES) throw new Error("file is over the 25MB cap");
  const buf = Buffer.from(await file.arrayBuffer());
  const ext = extname(file.name || "").replace(/[^a-zA-Z0-9.]/g, "").slice(0, 10) || ".jpg";
  const filename = `${randomUUID()}${ext}`;
  writeFileSync(join(photosDir(), filename), buf);
  const url = `${LOCAL_PREFIX}${filename}`;
  getDb()
    .prepare(
      `INSERT OR IGNORE INTO photo_tags (id, asset_id, url, description, tags, suggested, created_at)
       VALUES (?, ?, ?, '', '[]', '', ?)`,
    )
    .run(randomUUID(), assetId, url, nowIso());
  return { url, filename };
}

const URL_KEYS = new Set([
  "mediaurl",
  "displayurl",
  "imageurl",
  "thumbnailurl",
  "thumbnail",
  "image",
  "photo",
  "picture",
  "url",
  "src",
  "authorimage",
  "profileimage",
  "avatar",
]);

function normKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z]/g, "");
}

function looksLikeImage(url: string): boolean {
  const clean = url.split("?")[0].toLowerCase();
  if (/\.(jpg|jpeg|png|webp|gif)$/.test(clean)) return true;
  // CDN URLs often hide the extension; accept common image hosts.
  return /cdn|fbcdn|instagram|tiktokcdn|images|media|photo|imgix|cloudinary/i.test(url);
}

function collectUrls(value: unknown, depth: number, out: string[]): void {
  if (depth <= 0 || value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 30)) collectUrls(item, depth - 1, out);
    return;
  }
  for (const [key, val] of Object.entries(value)) {
    if (typeof val === "string" && val.startsWith("http") && URL_KEYS.has(normKey(key))) {
      if (looksLikeImage(val) && !out.includes(val)) out.push(val);
    } else if (val !== null && typeof val === "object") {
      collectUrls(val, depth - 1, out);
    }
  }
}

export function hiddenUrls(): Set<string> {
  const rows = getDb().prepare(`SELECT url FROM photo_hidden`).all() as Array<{ url: string }>;
  return new Set(rows.map((r) => r.url));
}

// Delete a library photo forever: uploads are removed from disk, and the
// URL joins the hide list so ingested photos never resurface (and the
// vision scan never re-adds them).
export function deletePhoto(url: string): { deleted: boolean } {
  const db = getDb();
  const existed =
    (db.prepare(`SELECT 1 FROM photo_tags WHERE url = ?`).get(url) as unknown) !== undefined;
  const path = localPhotoPath(url);
  if (path && existsSync(path)) {
    try {
      unlinkSync(path);
    } catch {
      /* already gone */
    }
  }
  db.prepare(`DELETE FROM photo_tags WHERE url = ?`).run(url);
  db.prepare(`DELETE FROM photo_regions WHERE url = ?`).run(url);
  db.prepare(`INSERT OR IGNORE INTO photo_hidden (url, created_at) VALUES (?, ?)`).run(
    url,
    nowIso(),
  );
  return { deleted: existed || path !== null };
}

export function listPhotos(limit = 60): PhotoCandidate[] {
  const out: PhotoCandidate[] = [];
  const seen = new Set<string>();
  const hidden = hiddenUrls();
  // Uploads first (newest first), then ingested URLs.
  const uploaded = getDb()
    .prepare(
      `SELECT asset_id, url, created_at FROM photo_tags
       WHERE url LIKE 'local:%' ORDER BY created_at DESC LIMIT 200`,
    )
    .all() as Array<{ asset_id: string | null; url: string; created_at: string }>;
  for (const row of uploaded) {
    if (seen.has(row.url) || hidden.has(row.url)) continue;
    seen.add(row.url);
    out.push({ asset_id: row.asset_id, title: null, source: "upload", url: row.url });
    if (out.length >= limit) return out;
  }
  if (!INCLUDE_INGESTED_PHOTOS) return out;
  const rows = getDb()
    .prepare(`SELECT id, source, title, metadata FROM assets ORDER BY created_at DESC LIMIT 200`)
    .all() as Array<{ id: string; source: string; title: string | null; metadata: string }>;
  for (const row of rows) {
    let meta: unknown = {};
    try {
      meta = JSON.parse(row.metadata) as unknown;
    } catch {
      continue;
    }
    const urls: string[] = [];
    collectUrls((meta as Record<string, unknown>).raw ?? meta, 4, urls);
    for (const url of urls.slice(0, 3)) {
      if (seen.has(url) || hidden.has(url)) continue;
      seen.add(url);
      out.push({ asset_id: row.id, title: row.title, source: row.source, url });
      if (out.length >= limit) return out;
    }
  }
  return out;
}
