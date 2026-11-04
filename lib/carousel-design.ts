// Slide art direction: the model picks each slide's layout and background
// (kit, white, black, gradient, or a hex) given its copy and photo. A
// deterministic fallback applies on any model failure, so design never
// blocks the slot -> carousel -> slot pipeline.
import { getProject, isLayout, listSlides, updateSlide } from "./carousel";
import { loadKeys } from "./keys";
import { getMetaClient, metaTextModel } from "./meta";

export type SlideDesign = { layout: string; background: string | null };

const NAMED = new Map([
  ["kit", null],
  ["default", null],
  ["white", "#ffffff"],
  ["black", "#111111"],
  ["gradient", "gradient"],
]);

export function parseDesignJson(text: string): SlideDesign[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    const match = text.match(/```json\s*([\s\S]*?)```/) ?? text.match(/\[[\s\S]*\]/);
    if (!match) throw new Error("model did not return design JSON");
    parsed = JSON.parse(match[1] ?? match[0]) as unknown;
  }
  const list = Array.isArray(parsed) ? parsed : (parsed as { slides?: unknown }).slides;
  if (!Array.isArray(list)) throw new Error("design JSON is not an array");
  return list.map((item) => {
    const o = (item ?? {}) as Record<string, unknown>;
    const layout = typeof o.layout === "string" && isLayout(o.layout) ? o.layout : "content";
    let background: string | null = null;
    if (typeof o.background === "string") {
      const v = o.background.trim().toLowerCase();
      if (NAMED.has(v)) background = NAMED.get(v) ?? null;
      else if (/^#[0-9a-f]{6}$/.test(v)) background = v;
    }
    return { layout, background };
  });
}

// Variety without a model: gradient cover, dark CTA, photo slides on the
// kit, text slides cycling white/kit/black.
export function fallbackDesigns(count: number, hasImage: boolean[]): SlideDesign[] {
  const cycle: Array<string | null> = ["#ffffff", null, "#111111"];
  return Array.from({ length: count }, (_, i) => {
    if (i === 0) return { layout: "cover", background: "gradient" as string | null };
    if (i === count - 1) return { layout: "cta", background: "#111111" };
    if (hasImage[i]) return { layout: "content", background: null };
    return { layout: "content", background: cycle[i % cycle.length] };
  });
}

export type AutoDesignResult = { designed: number; fallback: boolean };

export async function runAutoDesign(projectId: string): Promise<AutoDesignResult> {
  const project = getProject(projectId);
  if (!project) throw new Error("carousel project not found");
  const slides = listSlides(projectId);
  if (slides.length === 0) return { designed: 0, fallback: false };

  const apply = (designs: SlideDesign[]): number => {
    let n = 0;
    for (let i = 0; i < slides.length && i < designs.length; i++) {
      updateSlide(slides[i].id, { layout: designs[i].layout, background: designs[i].background });
      n++;
    }
    return n;
  };
  const applyFallback = (): AutoDesignResult => ({
    designed: apply(fallbackDesigns(slides.length, slides.map((s) => !!s.image_path))),
    fallback: true,
  });

  const metaKey = loadKeys().meta;
  // Offline hatch for tests and key-less machines: the fallback still
  // art-directs every slide, it just doesn't consult the model.
  if (!metaKey || process.env.CREAGENT_DESIGN_OFFLINE === "1") return applyFallback();

  try {
    const brief = slides
      .map(
        (s, i) =>
          `${i + 1}. [${s.image_path ? "has photo" : "text only"}] ${s.heading.slice(0, 90)}${s.body ? ` — ${s.body.slice(0, 140)}` : ""}`,
      )
      .join("\n");
    const client = getMetaClient(metaKey);
    const resp = await client.responses.create(
      {
        model: metaTextModel(),
        input: `You art-direct an Instagram carousel (${slides.length} slides). Kit: primary ${project.primary_color}, secondary ${project.secondary_color}, background ${project.background_color}.

SLIDES:
${brief}

Decide each slide's layout and background. Rules: slide 1 is cover, slide ${slides.length} is cta; slides with photos use the photo or content layout; text-only slides use content and vary backgrounds for rhythm (kit, white, black, gradient) — never the same background twice in a row, use gradient at most twice. Respond with ONLY a JSON array of ${slides.length} items, no prose:
[{"layout": "cover|content|photo|cta", "background": "kit|white|black|gradient|#rrggbb"}]`,
        reasoning: { effort: "medium" },
      },
      { timeout: 120000 },
    );
    const designs = parseDesignJson(resp.output_text);
    if (designs.length !== slides.length) return applyFallback();
    // Anchor the endpoints even if the model drifts.
    designs[0].layout = "cover";
    designs[designs.length - 1].layout = "cta";
    return { designed: apply(designs), fallback: false };
  } catch {
    return applyFallback();
  }
}
