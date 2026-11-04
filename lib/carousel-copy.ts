// Carousel copy fill: model writes per-slide heading/body/layout as JSON.
import { getDb } from "./db";
import { addSlide, createProject, deleteSlide, getProject, isLayout, listSlides, updateSlide } from "./carousel";
import { runAutopick } from "./carousel-plan";
import { approvedBody } from "./draft-structure";
import { buildDraftContext } from "./drafting";
import { loadKeys } from "./keys";
import { getMetaClient, metaTextModel } from "./meta";
import { searchVault } from "./vault";

export type SlideDraft = {
  heading: string;
  body: string;
  layout: string;
  image_idea: string;
};

export function extractSlidesJson(text: string): SlideDraft[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    const match =
      text.match(/```json\s*([\s\S]*?)```/) ?? text.match(/\[[\s\S]*\]/);
    if (!match) throw new Error("model did not return slide JSON");
    parsed = JSON.parse(match[1] ?? match[0]) as unknown;
  }
  const list = Array.isArray(parsed)
    ? parsed
    : (parsed as { slides?: unknown }).slides;
  if (!Array.isArray(list)) throw new Error("slide JSON is not an array");
  return list.map((item) => {
    const o = (item ?? {}) as Record<string, unknown>;
    return {
      heading: typeof o.heading === "string" ? o.heading : "",
      body: typeof o.body === "string" ? o.body : "",
      layout:
        typeof o.layout === "string" && isLayout(o.layout) ? o.layout : "content",
      image_idea: typeof o.image_idea === "string" ? o.image_idea : "",
    };
  });
}

// Approved-copy -> slides. Each blank-line block becomes one slide; the
// first line (or first sentence) is the heading, the rest the body.
// Over-long blocks split into continuation slides so every slide keeps
// a readable amount of text. Deterministic — the user reviews it.
export type CopySlide = { heading: string; body: string; layout: string };

const MAX_COPY_SLIDES = 10;
const MAX_BODY_CHARS = 220;

export function splitApprovedCopy(text: string): CopySlide[] {
  // The carousel guide writes "Caption first, then SLIDE 1..7 markers".
  // The caption ships as the post caption (see extractPostCaption), never
  // as a slide; each SLIDE block becomes exactly one slide.
  let slidesText = text;
  const firstMarker = text.search(/(?:^|\n)\s*\*{0,2}slide\s*1\b/i);
  if (firstMarker >= 0) {
    slidesText = text
      .slice(firstMarker)
      .replace(/(?:^|\n)\s*\*{0,2}slide\s*\d+\s*:?\*{0,2}\s*/gi, "\n\n")
      .trim();
  }
  const blocks = slidesText
    .split(/\n\s*\n|(?:^|\n)\s*---\s*(?:\n|$)/)
    .map((b) => b.replace(/^(?:\s*\d+[.)]\s*)/, "").trim())
    .filter(Boolean);
  const slides: CopySlide[] = [];
  const push = (heading: string, body: string): void => {
    let rest = body.trim();
    let first = true;
    while (rest.length > MAX_BODY_CHARS && slides.length < MAX_COPY_SLIDES - 1) {
      let cut = rest.lastIndexOf(" ", MAX_BODY_CHARS);
      if (cut < MAX_BODY_CHARS / 2) cut = MAX_BODY_CHARS;
      slides.push({
        heading: first ? heading : `${heading} (cont.)`,
        body: rest.slice(0, cut).trim(),
        layout: "content",
      });
      rest = rest.slice(cut).trim();
      first = false;
    }
    slides.push({ heading: first ? heading : `${heading} (cont.)`, body: rest, layout: "content" });
  };
  for (const block of blocks) {
    if (slides.length >= MAX_COPY_SLIDES) break;
    const lines = block.split("\n").map((l) => l.trim()).filter(Boolean);
    if (lines.length === 0) continue;
    if (lines.length === 1) {
      const sentence = lines[0].match(/^(.+?[.!?])\s+(.+)$/);
      if (sentence && sentence[1].length <= 80) push(sentence[1], sentence[2]);
      else if (lines[0].length <= 80) push(lines[0], "");
      else push("", lines[0]);
    } else if (lines[0].length <= 80) {
      push(lines[0], lines.slice(1).join(" "));
    } else {
      push("", block);
    }
  }
  if (slides.length === 0) return [];
  slides[0].layout = "cover";
  if (slides.length > 1) slides[slides.length - 1].layout = "cta";
  return slides.slice(0, MAX_COPY_SLIDES);
}

export type CarouselCopyResult = {
  slides: number;
  replaced: boolean;
};

// Image-draft pipeline: approved queue-slot copy -> parsed slides ->
// auto-matched library photos. Slides the matcher can't place stay
// photo-less for the user (or a generation request) to finish.
export type SlotDraftResult = {
  projectId: string;
  slides: number;
  picks: number;
  unmatched: string[];
};

export async function draftCarouselFromSlot(slotId: string): Promise<SlotDraftResult> {
  const db = getDb();
  const slot = db
    .prepare(
      `SELECT id, scheduled_at, content_type, approved_draft_id, approved_option
       FROM queue_slots WHERE id = ?`,
    )
    .get(slotId) as
    | { id: string; scheduled_at: string; content_type: string; approved_draft_id: string | null; approved_option: number | null }
    | undefined;
  if (!slot) throw new Error("slot not found");
  if (!slot.approved_draft_id) throw new Error("approve the slot copy first");
  const draft = db
    .prepare(`SELECT body, structure FROM drafts WHERE id = ?`)
    .get(slot.approved_draft_id) as { body: string; structure: string | null } | undefined;
  if (!draft) throw new Error("approved draft is gone");
  const copy = approvedBody(draft, slot.approved_option).trim();
  if (!copy) throw new Error("approved copy is empty");
  const slides = splitApprovedCopy(copy);
  if (slides.length === 0) throw new Error("could not split the copy into slides");
  const project = createProject({
    title: `${slot.content_type} · ${slot.scheduled_at.slice(0, 10)}`,
    slot_id: slot.id,
  });
  for (const s of slides) {
    addSlide(project.id, { layout: s.layout, heading: s.heading, body: s.body });
  }
  const picked = await runAutopick(project.id);
  // Images need user review before this slot can ship.
  db.prepare(`UPDATE queue_slots SET status = 'orange' WHERE id = ?`).run(slot.id);
  return {
    projectId: project.id,
    slides: slides.length,
    picks: picked.picks.length,
    unmatched: picked.unmatched,
  };
}

export async function runCarouselCopy(
  projectId: string,
  options: { numSlides?: number; brief?: string; replace?: boolean } = {},
): Promise<CarouselCopyResult> {
  const metaKey = loadKeys().meta;
  if (!metaKey) throw new Error("save a Meta key in Settings first");
  const project = getProject(projectId);
  if (!project) throw new Error("carousel project not found");
  const numSlides = Math.max(2, Math.min(options.numSlides ?? 7, 15));
  const brief = (options.brief ?? "").trim();

  let pillarLine = "Pillar: (none)";
  if (project.slot_id) {
    const row = getDb()
      .prepare(
        `SELECT p.name, p.description, s.content_type FROM queue_slots s
         LEFT JOIN pillars p ON p.id = s.pillar_id WHERE s.id = ?`,
      )
      .get(project.slot_id) as
      | { name: string | null; description: string | null; content_type: string }
      | undefined;
    if (row) {
      pillarLine = `Pillar: ${row.name ?? "(none)"}${row.description ? ` — ${row.description}` : ""} (slot type: ${row.content_type})`;
    }
  }
  const hits = await searchVault(`${project.title} ${brief} carousel`.trim() || "voice", 5);
  const context = buildDraftContext(
    hits.map((h) => ({ doc_type: h.doc_type, title: h.title, body: h.body })),
  );

  const client = getMetaClient(metaKey);
  const input = `You write Instagram carousel copy for a creator. Match their voice from the VAULT CONTEXT.

Carousel title: ${project.title}
${pillarLine}
${brief ? `Brief: ${brief}` : "Brief: (none — pick the strongest angle yourself)"}

Write exactly ${numSlides} slides. Slide 1 is the cover hook, the last slide is a CTA (follow/save/comment). Respond with ONLY a JSON array, no prose, shaped like:
[{"heading": "short punchy line", "body": "1-3 supporting lines", "layout": "cover|content|photo|cta", "image_idea": "one-line visual idea for this slide"}]

VAULT CONTEXT:
${context}`;
  const call = (text: string) =>
    client.responses.create(
      {
        model: metaTextModel(),
        input: text,
        reasoning: { effort: "medium" },
      },
      { timeout: 180000 },
    );
  let resp = await call(input);
  let slides = extractSlidesJson(resp.output_text).slice(0, numSlides);
  if (slides.length === 0) {
    resp = await call(`${input}\n\nYour previous response was empty. Respond with ONLY the JSON array.`);
    slides = extractSlidesJson(resp.output_text).slice(0, numSlides);
  }
  if (slides.length === 0) {
    throw new Error(
      `model returned no slides (status: ${String((resp as { status?: unknown }).status ?? "unknown")})`,
    );
  }

  const replaced = options.replace === true;
  if (replaced) {
    for (const s of listSlides(projectId)) deleteSlide(s.id);
  }
  for (const s of slides) {
    const created = addSlide(projectId, {
      layout: s.layout,
      heading: s.heading.slice(0, 300),
      body: s.body.slice(0, 2000),
    });
    if (s.image_idea) {
      updateSlide(created.id, { image_prompt: s.image_idea.slice(0, 500) });
    }
  }
  return { slides: slides.length, replaced };
}
