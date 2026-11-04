// Agent slide imagery: auto-pick matching ingested photos by embedding
// similarity, and plan (request, never execute) generations for the rest.
import { getDb } from "./db";
import { downloadPhotoForSlide } from "./carousel-image";
import { getProject, listSlides, updateSlide } from "./carousel";
import { approvedBody } from "./draft-structure";
import { blobToVector, cosineSimilarity, embed } from "./embeddings";
import { createGenRequest, pendingForSlide } from "./gen-requests";
import { loadKeys } from "./keys";
import { getMetaClient, metaTextModel } from "./meta";
import { INCLUDE_INGESTED_PHOTOS, LOCAL_PREFIX } from "./photos";

export function buildImagePrompt(slide: {
  heading: string;
  body: string;
  image_prompt: string | null;
}): string {
  // Content only — the house style locks at generation time
  // (styledImagePrompt), so every path renders in-style.
  if (slide.image_prompt?.trim()) return slide.image_prompt.trim();
  const head = slide.heading.trim() || "untitled slide";
  const body = slide.body.trim().slice(0, 220);
  return `Illustration for a social media carousel slide titled "${head}"${body ? `: ${body}` : ""}. Bold, modern, high contrast, no text in the image.`;
}

// The copy an art-direction pass must honor: the approved pick first,
// else the newest draft's selected option (or full body).
export function resolveSlotOutline(slotId: string): string {
  const db = getDb();
  const slot = db
    .prepare(`SELECT approved_draft_id, approved_option FROM queue_slots WHERE id = ?`)
    .get(slotId) as { approved_draft_id: string | null; approved_option: number | null } | undefined;
  if (slot?.approved_draft_id) {
    const pinned = db
      .prepare(`SELECT body, structure FROM drafts WHERE id = ?`)
      .get(slot.approved_draft_id) as { body: string; structure: string | null } | undefined;
    if (pinned) {
      const text = approvedBody(pinned, slot.approved_option).trim();
      if (text) return text;
    }
  }
  const latest = db
    .prepare(
      `SELECT body, structure, selection FROM drafts WHERE slot_id = ? ORDER BY created_at DESC LIMIT 1`,
    )
    .get(slotId) as { body: string; structure: string | null; selection: string | null } | undefined;
  if (!latest) return "";
  const parsed = Number.parseInt(latest.selection ?? "", 10);
  return approvedBody(latest, Number.isNaN(parsed) ? 0 : parsed).trim();
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

// Match bar, set by eval (2026-11-04, live library): 19 personal photos x
// 7 conceptual ELI5 slides scored median 0.038, max 0.264 — pure noise,
// yet 0.15 attached selfies to every slide. 0.30 leaves conceptual slides
// for generation while genuine topical matches (same people/places/words,
// typically 0.4+) still attach. Re-run the eval before moving this.
export const AUTOPICK_THRESHOLD = 0.3;

export type PhotoCandidate = { url: string; asset_id: string | null; vec: number[] };

export function bestPhotoMatch(
  queryVec: number[],
  photos: PhotoCandidate[],
  used: Set<string>,
  threshold: number,
): { url: string; asset_id: string | null; score: number } | null {
  let best: { url: string; asset_id: string | null; score: number } | null = null;
  for (const photo of photos) {
    if (used.has(photo.url) || photo.vec.length === 0 || queryVec.length === 0) continue;
    const score = cosineSimilarity(queryVec, photo.vec);
    if (!best || score > best.score) {
      best = { url: photo.url, asset_id: photo.asset_id, score };
    }
  }
  if (!best || best.score < threshold) return null;
  return best;
}

export async function runAutopick(
  projectId: string,
  threshold = AUTOPICK_THRESHOLD,
): Promise<AutopickResult> {
  const project = getProject(projectId);
  if (!project) throw new Error("carousel project not found");
  const photos = (
    getDb()
      .prepare(
        `SELECT asset_id, url, description, embedding FROM photo_tags
       WHERE embedding IS NOT NULL`,
      )
      .all() as TaggedPhoto[]
  ).filter((p) => INCLUDE_INGESTED_PHOTOS || p.url.startsWith(LOCAL_PREFIX));
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
    const best = bestPhotoMatch(q, photoVecs, used, threshold);
    if (!best) {
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
  story: number;
  storyFallback: boolean;
};

export type StoryPrompt = { slide: number; prompt: string };

export function parseStoryJson(text: string): StoryPrompt[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    const match = text.match(/```json\s*([\s\S]*?)```/) ?? text.match(/\[[\s\S]*\]/);
    if (!match) throw new Error("model did not return story JSON");
    parsed = JSON.parse(match[1] ?? match[0]) as unknown;
  }
  const list = Array.isArray(parsed) ? parsed : (parsed as { slides?: unknown }).slides;
  if (!Array.isArray(list)) throw new Error("story JSON is not an array");
  const out: StoryPrompt[] = [];
  for (const item of list) {
    const o = (item ?? {}) as Record<string, unknown>;
    if (typeof o.slide !== "number" || !Number.isInteger(o.slide) || o.slide < 1) continue;
    if (typeof o.prompt !== "string" || !o.prompt.trim()) continue;
    out.push({ slide: o.slide, prompt: o.prompt });
  }
  return out;
}

// Story-aware image prompts: one model call sees the whole carousel —
// caption, every slide in order, which slides already have images — and
// writes each needed prompt as the next scene in one visual story, so
// recurring subjects stay consistent. Partial coverage applies; missing
// slides fall back to the per-slide heuristic at request time.
export async function planStoryPrompts(
  projectId: string,
  slideIds: string[],
): Promise<{ planned: number; fallback: boolean }> {
  const slides = listSlides(projectId);
  const targets = slides.filter((s) => slideIds.includes(s.id) && !s.image_path);
  if (targets.length === 0) return { planned: 0, fallback: false };
  const metaKey = loadKeys().meta;
  if (!metaKey || process.env.CREAGENT_MODEL_OFFLINE === "1") return { planned: 0, fallback: true };
  try {
    const project = getProject(projectId);
    const outline = project?.slot_id ? resolveSlotOutline(project.slot_id) : "";
    const roster = slides
      .map((s, i) => {
        const flag = s.image_path ? "has image" : targets.some((t) => t.id === s.id) ? "NEEDS IMAGE" : "text only";
        return `${i + 1}. [${flag}] ${(s.heading ? `${s.heading} — ` : "") + s.body}`.slice(0, 200);
      })
      .join("\n");
    const client = getMetaClient(metaKey);
    const resp = await client.responses.create(
      {
        model: metaTextModel(),
        input: `You art-direct illustrations for an Instagram carousel that tells one continuous visual story. Recurring subjects, objects, and settings must stay consistent across slides (same jar, same cookies, same kitchen) so the images read as scenes from one story, not isolated pictures.

CAROUSEL (in order):
${roster}
${outline ? `\nFULL OUTLINE (caption plus all slide copy):\n${outline.slice(0, 5000)}` : ""}

Write an image prompt for each slide marked NEEDS IMAGE. Each prompt is one vivid paragraph: the scene, subjects, action, and mood that continues the story at that point. House style is applied automatically — describe content only, never lettering. Respond with ONLY a JSON array, no prose:
[{"slide": 3, "prompt": "..."}]`,
        reasoning: { effort: "medium" },
      },
      { timeout: 120000 },
    );
    const wants = parseStoryJson(resp.output_text);
    let planned = 0;
    for (const w of wants) {
      const slide = slides[w.slide - 1];
      if (!slide || !targets.some((t) => t.id === slide.id)) continue;
      const clean = w.prompt.trim().slice(0, 900);
      if (!clean) continue;
      updateSlide(slide.id, { image_prompt: clean });
      planned++;
    }
    return { planned, fallback: planned < targets.length };
  } catch {
    return { planned: 0, fallback: true };
  }
}

export async function runPlanImages(
  projectId: string,
  onStage?: (stage: "photos" | "story" | "requests") => void,
): Promise<PlanImagesResult> {
  const project = getProject(projectId);
  if (!project) throw new Error("carousel project not found");
  onStage?.("photos");
  const auto = await runAutopick(projectId);
  const plannable = auto.unmatched.filter((id) => !pendingForSlide(id));
  onStage?.("story");
  const story = await planStoryPrompts(projectId, plannable);
  onStage?.("requests");
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
  return { attached: auto.picks.length, requested, unmatched, story: story.planned, storyFallback: story.fallback };
}
