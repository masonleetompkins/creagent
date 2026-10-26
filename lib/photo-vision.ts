// Photo vision: describe ingested photos with a Meta multimodal call, tag
// them, and embed the descriptions so slides can auto-pick matching photos.
import { randomUUID } from "node:crypto";
import { getDb, nowIso } from "./db";
import { embed, vectorToBlob } from "./embeddings";
import { fetchWithRetry } from "./fetch-retry";
import { loadKeys } from "./keys";
import { getMetaClient, metaTextModel } from "./meta";
import { listPhotos } from "./photos";

export const MAX_VISION_BYTES = 4 * 1024 * 1024;

export type PhotoDescription = {
  description: string;
  tags: string[];
  suggested: string;
};

export function extractVisionJson(text: string): PhotoDescription {
  const fallback: PhotoDescription = {
    description: text.trim().slice(0, 1000) || "(no description)",
    tags: [],
    suggested: "",
  };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    const match =
      text.match(/```json\s*([\s\S]*?)```/) ?? text.match(/\{[\s\S]*\}/);
    if (!match) return fallback;
    try {
      parsed = JSON.parse(match[1] ?? match[0]) as unknown;
    } catch {
      return fallback;
    }
  }
  if (!parsed || typeof parsed !== "object") return fallback;
  const o = parsed as Record<string, unknown>;
  return {
    description:
      typeof o.description === "string" && o.description.trim()
        ? o.description.trim().slice(0, 1000)
        : fallback.description,
    tags: Array.isArray(o.tags)
      ? o.tags.filter((t): t is string => typeof t === "string").slice(0, 12)
      : [],
    suggested: typeof o.suggested === "string" ? o.suggested.slice(0, 500) : "",
  };
}

async function downloadCapped(url: string): Promise<{ data: Buffer; mime: string }> {
  const res = await fetchWithRetry(url, { signal: AbortSignal.timeout(90000) });
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
  const len = res.headers.get("content-length");
  if (len && Number(len) > MAX_VISION_BYTES) throw new Error("image too large for vision");
  const data = Buffer.from(await res.arrayBuffer());
  if (data.length > MAX_VISION_BYTES) throw new Error("image too large for vision");
  return { data, mime: res.headers.get("content-type") || "image/jpeg" };
}

export async function describePhoto(
  bytes: Buffer,
  mime: string,
): Promise<PhotoDescription> {
  const metaKey = loadKeys().meta;
  if (!metaKey) throw new Error("save a Meta key in Settings first");
  const client = getMetaClient(metaKey);
  const dataUrl = `data:${mime};base64,${bytes.toString("base64")}`;
  const resp = await client.chat.completions.create(
    {
      // Generous cap: reasoning tokens come out of this budget, and the
      // model thinks before answering. Too small => length cut, empty content.
      model: metaTextModel(),
      max_tokens: 2000,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: 'Describe this photo for a content creator. Respond with ONLY a JSON object: {"description": "2-3 sentences on what is visible", "tags": ["5-10 lowercase tags"], "suggested": "one line on what carousel slide this suits"}.',
            },
            { type: "image_url", image_url: { url: dataUrl } },
          ],
        },
      ],
    },
    { timeout: 120000 },
  );
  const text = resp.choices?.[0]?.message?.content ?? "";
  return extractVisionJson(typeof text === "string" ? text : JSON.stringify(text));
}

export type PhotoScanResult = {
  tagged: number;
  skipped: number;
  failures: Array<{ url: string; error: string }>;
};

export async function runPhotoScan(limit = 30): Promise<PhotoScanResult> {
  const db = getDb();
  const out: PhotoScanResult = { tagged: 0, skipped: 0, failures: [] };
  const insert = db.prepare(
    `INSERT OR IGNORE INTO photo_tags (id, asset_id, url, description, tags, suggested, embedding, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const photo of listPhotos(limit)) {
    const existing = db
      .prepare(`SELECT id FROM photo_tags WHERE url = ?`)
      .get(photo.url) as { id: string } | undefined;
    if (existing) {
      out.skipped++;
      continue;
    }
    try {
      const { data, mime } = await downloadCapped(photo.url);
      const desc = await describePhoto(data, mime);
      const vec = await embed(`${desc.description}\n${desc.tags.join(", ")}\n${desc.suggested}`);
      insert.run(
        randomUUID(), photo.asset_id, photo.url, desc.description,
        JSON.stringify(desc.tags), desc.suggested, vectorToBlob(vec), nowIso(),
      );
      out.tagged++;
    } catch (error) {
      out.failures.push({
        url: photo.url.slice(0, 120),
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return out;
}
