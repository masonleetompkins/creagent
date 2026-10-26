// Ingested-photo picker: scan asset metadata for usable image URLs.
import { getDb } from "./db";

export type PhotoCandidate = {
  asset_id: string;
  title: string | null;
  source: string;
  url: string;
};

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

export function listPhotos(limit = 60): PhotoCandidate[] {
  const rows = getDb()
    .prepare(`SELECT id, source, title, metadata FROM assets ORDER BY created_at DESC LIMIT 200`)
    .all() as Array<{ id: string; source: string; title: string | null; metadata: string }>;
  const out: PhotoCandidate[] = [];
  const seen = new Set<string>();
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
      if (seen.has(url)) continue;
      seen.add(url);
      out.push({ asset_id: row.id, title: row.title, source: row.source, url });
      if (out.length >= limit) return out;
    }
  }
  return out;
}
