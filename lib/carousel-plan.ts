// Agent slide imagery: auto-pick matching ingested photos by embedding
// similarity, and plan (request, never execute) generations for the rest.
import { getDb } from "./db";
import { downloadPhotoForSlide } from "./carousel-image";
import { getProject, listSlides } from "./carousel";
import { blobToVector, cosineSimilarity, embed } from "./embeddings";
import { createGenRequest, pendingForSlide } from "./gen-requests";

export function buildImagePrompt(slide: {
  heading: string;
  body: string;
  image_prompt: string | null;
}): string {
  if (slide.image_prompt?.trim()) return slide.image_prompt.trim();
  const head = slide.heading.trim() || "untitled slide";
  const body = slide.body.trim().slice(0, 220);
  return `Illustration for a social media carousel slide titled "${head}"${body ? `: ${body}` : ""}. Bold, modern, high contrast, no text in the image.`;
}

type TaggedPhoto = {
  asset_id: string | null;
  url: string;
  description: string;
  embedding: Uint8Array | null;
};

export type AutopickResult = {
  picks: Array<{ slideId: string; url: string; score: number }>;
  unmatched: string[];
};

export async function runAutopick(
  projectId: string,
  threshold = 0.15,
): Promise<AutopickResult> {
  const project = getProject(projectId);
  if (!project) throw new Error("carousel project not found");
  const photos = getDb()
    .prepare(
      `SELECT asset_id, url, description, embedding FROM photo_tags
       WHERE embedding IS NOT NULL`,
    )
    .all() as TaggedPhoto[];
  const out: AutopickResult = { picks: [], unmatched: [] };
  if (photos.length === 0) {
    out.unmatched = listSlides(projectId)
      .filter((s) => !s.image_path)
      .map((s) => s.id);
    return out;
  }
  const used = new Set<string>();
  const photoVecs = photos.map((p) => ({
    ...p,
    vec: p.embedding ? blobToVector(p.embedding) : [],
  }));
  for (const slide of listSlides(projectId)) {
    if (slide.image_path) continue;
    const query = `${slide.heading}\n${slide.body}\n${slide.image_prompt ?? ""}`.trim();
    if (!query) {
      out.unmatched.push(slide.id);
      continue;
    }
    const q = await embed(query);
    let best: { url: string; asset_id: string | null; score: number } | null = null;
    for (const photo of photoVecs) {
      if (used.has(photo.url) || photo.vec.length === 0) continue;
      const score = cosineSimilarity(q, photo.vec);
      if (!best || score > best.score) {
        best = { url: photo.url, asset_id: photo.asset_id, score };
      }
    }
    if (!best || best.score < threshold || !best.asset_id) {
      out.unmatched.push(slide.id);
      continue;
    }
    used.add(best.url);
    await downloadPhotoForSlide(slide.id, best.asset_id, best.url);
    out.picks.push({
      slideId: slide.id,
      url: best.url,
      score: Math.round(best.score * 100) / 100,
    });
  }
  return out;
}

export type PlanImagesResult = {
  attached: number;
  requested: number;
  unmatched: string[];
};

export async function runPlanImages(projectId: string): Promise<PlanImagesResult> {
  const project = getProject(projectId);
  if (!project) throw new Error("carousel project not found");
  const auto = await runAutopick(projectId);
  let requested = 0;
  const unmatched: string[] = [];
  for (const slideId of auto.unmatched) {
    const slide = listSlides(projectId).find((s) => s.id === slideId);
    if (!slide || slide.image_path) continue;
    if (pendingForSlide(slideId)) continue;
    createGenRequest({
      slot_id: project.slot_id,
      project_id: projectId,
      slide_id: slideId,
      prompt: buildImagePrompt(slide),
    });
    requested++;
    unmatched.push(slideId);
  }
  return { attached: auto.picks.length, requested, unmatched };
}
