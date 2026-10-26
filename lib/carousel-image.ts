// Carousel imagery: Muse Image generation, ingested-photo download, uploads.
// All bytes live under ~/.config/creagent/carousel, keyed by slide id.
import { existsSync, mkdirSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { getDb } from "./db";
import { getSlide, updateSlide } from "./carousel";
import { fetchWithRetry } from "./fetch-retry";
import { setRequestStatus } from "./gen-requests";
import { loadKeys } from "./keys";
import { META_IMAGE_MODEL, getMetaClient } from "./meta";

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

  const client = getMetaClient(metaKey);
  const sizes = ["1024x1792", "1024x1024"];
  let lastError = "";
  for (const size of sizes) {
    try {
      const out = await client.images.generate({
        model: META_IMAGE_MODEL,
        prompt: cleanPrompt,
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
        image_prompt: cleanPrompt.slice(0, 500),
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
  assetId: string,
  url: string,
): Promise<{ path: string }> {
  const slide = getSlide(slideId);
  if (!slide) throw new Error("slide not found");
  const asset = getDb().prepare(`SELECT id FROM assets WHERE id = ?`).get(assetId);
  if (!asset) throw new Error("asset not found");
  const { data, contentType } = await fetchBytes(url, MAX_CAROUSEL_IMAGE_BYTES);
  const filename = `${slideId}${extFor(contentType, url)}`;
  await writeFile(join(carouselImagesDir(), filename), data);
  updateSlide(slideId, { image_path: filename, image_source: `asset:${assetId}` });
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
