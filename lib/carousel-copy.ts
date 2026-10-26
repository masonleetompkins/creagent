// Carousel copy fill: model writes per-slide heading/body/layout as JSON.
import { getDb } from "./db";
import { addSlide, deleteSlide, getProject, isLayout, listSlides, updateSlide } from "./carousel";
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

export type CarouselCopyResult = {
  slides: number;
  replaced: boolean;
};

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
  const context =
    hits.length > 0
      ? hits.map((h) => `[${h.doc_type}] ${h.title ?? ""}\n${h.body}`).join("\n\n---\n\n")
      : "(vault is empty — write in a clear, confident creator voice)";

  const client = getMetaClient(metaKey);
  const resp = await client.responses.create(
    {
      model: metaTextModel(),
      input: `You write Instagram carousel copy for a creator. Match their voice from the VAULT CONTEXT.

Carousel title: ${project.title}
${pillarLine}
${brief ? `Brief: ${brief}` : "Brief: (none — pick the strongest angle yourself)"}

Write exactly ${numSlides} slides. Slide 1 is the cover hook, the last slide is a CTA (follow/save/comment). Respond with ONLY a JSON array, no prose, shaped like:
[{"heading": "short punchy line", "body": "1-3 supporting lines", "layout": "cover|content|photo|cta", "image_idea": "one-line visual idea for this slide"}]

VAULT CONTEXT:
${context}`,
      max_output_tokens: 3000,
    },
    { timeout: 120000 },
  );
  const slides = extractSlidesJson(resp.output_text).slice(0, numSlides);
  if (slides.length === 0) throw new Error("model returned no slides");

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
