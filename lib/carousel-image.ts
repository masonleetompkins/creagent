// Carousel imagery: Muse Image generation, ingested-photo download, uploads.
// All bytes live under ~/.config/creagent/carousel, keyed by slide id.
import { existsSync, mkdirSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { getDb } from "./db";
import { getSlide, updateSlide } from "./carousel";
import { fetchWithRetry } from "./fetch-retry";
import { withHouseStyle } from "./house-style";
import { setRequestStatus } from "./gen-requests";
import { loadKeys } from "./keys";
import { META_IMAGE_MODEL, getMetaClient } from "./meta";
import { LOCAL_PREFIX, listPhotos, readLocalPhoto } from "./photos";

// The library photo behind a slide's image, if it came from one (rather
// than a generation or a direct upload). Used to fetch no-text regions.
export function slidePhotoUrl(slide: { image_source: string | null }): string | null {
  const source = slide.image_source ?? "";
  if (source.startsWith("photo:")) return source.slice("photo:".length);
  if (source.startsWith("asset:")) {
    const assetId = source.slice("asset:".length);
    return listPhotos(200).find((p) => p.asset_id === assetId)?.url ?? null;
  }
  if (source.startsWith(LOCAL_PREFIX)) return source;
  return null;
}

export const MAX_CAROUSEL_IMAGE_BYTES = 25 * 1024 * 1024;

export function carouselImagesDir(): string {
  const dir = join(homedir(), ".config", "creagent", "carousel");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function extFor(contentType: string | null, fallbackUrl: string): string {
  if (contentType?.includes("jpeg") || contentType?.includes("jpg")) return ".jpg";
  if (contentType?.includes("png")) return ".png";
  if (contentType?.includes("webp")) return ".webp";
  const clean = fallbackUrl.split("?")[0].toLowerCase();
  if (clean.endsWith(".jpg") || clean.endsWith(".jpeg")) return ".jpg";
  if (clean.endsWith(".png")) return ".png";
  if (clean.endsWith(".webp")) return ".webp";
  return ".png";
}

async function fetchBytes(url: string, cap: number): Promise<{ data: Buffer; contentType: string | null }> {
  const res = await fetchWithRetry(url, { signal: AbortSignal.timeout(90000) });
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
  const len = res.headers.get("content-length");
  if (len && Number(len) > cap) throw new Error("image is over the size cap");
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > cap) throw new Error("image is over the size cap");
  return { data: buf, contentType: res.headers.get("content-type") };
}

// House style at the choke point: planned, story, and hand-typed prompts
// all render in-style. Pure so tests can pin it without a model call.
export function styledImagePrompt(prompt: string): string {
  return withHouseStyle(prompt.trim());
}

export async function runCarouselImage(
  slideId: string,
  prompt: string,
  options: { requestId?: string } = {},
): Promise<{ path: string }> {
  const metaKey = loadKeys().meta;
  if (!metaKey) throw new Error("save a Meta key in Settings first");
  const slide = getSlide(slideId);
  if (!slide) throw new Error("slide not found");
  const cleanPrompt = prompt.trim();
  if (!cleanPrompt) throw new Error("image prompt is empty");
  const styledPrompt = styledImagePrompt(cleanPrompt);

  const client = getMetaClient(metaKey);
  const sizes = ["1024x1792", "1024x1024"];
  let lastError = "";
  for (const size of sizes) {
    try {
      const out = await client.images.generate({
        model: META_IMAGE_MODEL,
        prompt: styledPrompt,
        size: size as "1024x1024",
      });
      const item = out.data?.[0];
      let bytes: Buffer | null = null;
      if (item?.b64_json) {
        bytes = Buffer.from(item.b64_json, "base64");
      } else if (item?.url) {
        const fetched = await fetchBytes(item.url, MAX_CAROUSEL_IMAGE_BYTES);
        bytes = fetched.data;
      }
      if (!bytes || bytes.length === 0) throw new Error("empty image response");
      // The model returns WebP bytes regardless of request; sniff the magic.
      const isWebp =
        bytes.length > 12 &&
        bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
        bytes.subarray(8, 12).toString("ascii") === "WEBP";
      const isJpeg = bytes.length > 2 && bytes[0] === 0xff && bytes[1] === 0xd8;
      const ext = isWebp ? ".webp" : isJpeg ? ".jpg" : ".png";
      const filename = `${slideId}${ext}`;
      await writeFile(join(carouselImagesDir(), filename), bytes);
      updateSlide(slideId, {
        image_path: filename,
        image_source: "generated",
        image_prompt: styledPrompt.slice(0, 2000),
      });
      if (options.requestId) setRequestStatus(options.requestId, "done");
      return { path: filename };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }
  throw new Error(`Muse Image failed (${META_IMAGE_MODEL}): ${lastError.slice(0, 300)}`);
}

export async function downloadPhotoForSlide(
  slideId: string,
  assetId: string | null,
  url: string,
): Promise<{ path: string }> {
  const slide = getSlide(slideId);
  if (!slide) throw new Error("slide not found");
  if (assetId) {
    const asset = getDb().prepare(`SELECT id FROM assets WHERE id = ?`).get(assetId);
    if (!asset) throw new Error("asset not found");
  }
  let data: Buffer;
  let contentType: string | null;
  if (url.startsWith(LOCAL_PREFIX)) {
    const hit = readLocalPhoto(url);
    if (!hit) throw new Error("uploaded photo is gone from disk");
    data = hit.data;
    contentType = hit.mime;
  } else {
    ({ data, contentType } = await fetchBytes(url, MAX_CAROUSEL_IMAGE_BYTES));
  }
  const filename = `${slideId}${extFor(contentType, url)}`;
  await writeFile(join(carouselImagesDir(), filename), data);
  updateSlide(slideId, {
    image_path: filename,
    image_source: assetId ? `asset:${assetId}` : `photo:${url}`,
  });
  return { path: filename };
}

export async function saveUploadForSlide(
  slideId: string,
  file: { name: string; type: string; size: number; arrayBuffer: () => Promise<ArrayBuffer> },
): Promise<{ path: string }> {
  const slide = getSlide(slideId);
  if (!slide) throw new Error("slide not found");
  if (file.size > MAX_CAROUSEL_IMAGE_BYTES) throw new Error("file is over the 25MB cap");
  const buf = Buffer.from(await file.arrayBuffer());
  const filename = `${slideId}${extFor(file.type || null, file.name || "")}`;
  await writeFile(join(carouselImagesDir(), filename), buf);
  updateSlide(slideId, { image_path: filename, image_source: "upload" });
  return { path: filename };
}

export async function readSlideImage(slideId: string): Promise<{ data: Buffer; filename: string }> {
  const slide = getSlide(slideId);
  if (!slide?.image_path) throw new Error("slide has no image");
  const safe = basename(slide.image_path);
  const data = await readFile(join(carouselImagesDir(), safe));
  return { data, filename: safe };
}
