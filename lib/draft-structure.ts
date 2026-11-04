// Pure draft-structure helpers (no db import — safe for client components).
// Parsing stored structures and composing the approved post text.

export type DraftOptionView = { label: string; body: string };

export type DraftStructureView = {
  layout: "pick-one" | "hooks-plus-body" | "prose";
  options: DraftOptionView[];
  body?: string;
};

export function parseStructure(raw: string | null | undefined): DraftStructureView | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<DraftStructureView>;
    if (!parsed || !Array.isArray(parsed.options) || parsed.options.length === 0) return null;
    if (!parsed.options.every((o) => typeof o?.body === "string" && o.body.trim())) return null;
    const layout =
      parsed.layout === "pick-one" || parsed.layout === "hooks-plus-body" ? parsed.layout : "prose";
    return {
      layout,
      options: parsed.options.map((o) => ({
        label: typeof o.label === "string" && o.label ? o.label : "Option",
        body: o.body,
      })),
      body: typeof parsed.body === "string" && parsed.body.trim() ? parsed.body : undefined,
    };
  } catch {
    return null;
  }
}

// Legacy drafts (pre-structure) joined variants as "Variant 1:" / "Option 2:"
// soup. Split best-effort so old drafts also get cards; null → prose.
export function splitLegacyOptions(body: string): DraftOptionView[] | null {
  const parts = body
    .split(/^(?:Variant|Option)\s+\d+\s*(?:\([^)]*\))?\s*:?\s*$/gim)
    .map((p) => p.replace(/^\s*---\s*$/gm, "").trim())
    .filter(Boolean);
  if (parts.length < 2) return null;
  return parts.map((p, i) => ({ label: `Option ${i + 1}`, body: p }));
}

export function clampSelection(selection: string | null | undefined, optionCount: number): number {
  return Math.min(Math.max(0, Number.parseInt(selection ?? "", 10) || 0), Math.max(0, optionCount - 1));
}

// Character counts, code points so emoji don't cheat (matches the publish
// preflight). Shared by review cards, the edit box, and the hero line.
export function charCount(text: string): number {
  return Array.from(text.trim()).length;
}

export function longestParagraph(text: string): number {
  return text
    .split(/\n\s*\n/)
    .map((p) => charCount(p))
    .reduce((m, n) => Math.max(m, n), 0);
}

// The Caption section of a carousel outline: everything before the SLIDE
// markers, minus a leading "Caption:" tag. Pure so the inspector can show
// legacy drafts (no separate caption block) exactly what would ship.
export function carouselCaptionFromOutline(text: string): string {
  const withoutTag = text.trim().replace(/^\s*\*{0,2}caption:\*{0,2}\s*/i, "");
  const cutAt = withoutTag.search(/\n\s*\*{0,2}\d+\s*-\s*slide|\n\s*\*{0,2}slide\s*1\b/i);
  return (cutAt >= 0 ? withoutTag.slice(0, cutAt) : withoutTag).trim();
}

// The shippable post text: the picked option, plus the thread body when the
// pick is a hook. Falls back to raw body for unstructured drafts.
export function approvedBody(
  draft: { body: string; structure: string | null },
  optionIndex: number | null,
): string {
  const structure = parseStructure(draft.structure);
  if (!structure) {
    const legacy = splitLegacyOptions(draft.body);
    if (legacy) return legacy[clampSelection(String(optionIndex ?? 0), legacy.length)].body;
    return draft.body;
  }
  const idx = clampSelection(String(optionIndex ?? 0), structure.options.length);
  const pick = structure.options[idx].body;
  if (structure.layout === "hooks-plus-body" && structure.body) {
    return `${pick}\n\n${structure.body}`;
  }
  return pick;
}

