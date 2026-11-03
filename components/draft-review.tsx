"use client";

// DraftReview: the guided draft-reading surface. Renders a code-assembled
// structure (option cards + a one-line next step) when present, clean prose
// otherwise. No queue imports — carousel slides, video scripts, and any
// future surface can reuse it by passing options + body.

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

function paragraphs(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
}

type Props = {
  title: string;
  edited: boolean;
  structure: DraftStructureView | null;
  body: string;
  selection: number;
  nextStep: string | null;
  onSelect: (index: number) => void;
  onEdit: () => void;
  onFeedback: () => void;
};

export default function DraftReview(props: Props): React.ReactNode {
  const { title, edited, structure, body, selection, nextStep } = props;
  const legacy = structure ? null : splitLegacyOptions(body);
  const layout = structure?.layout ?? (legacy ? "pick-one" : "prose");
  const options = structure?.options ?? legacy ?? [];
  const threadBody = structure?.layout === "hooks-plus-body" ? structure.body : undefined;

  return (
    <div className="dr">
      <h2>
        {title}
        {edited ? " — edited" : ""}
      </h2>
      {nextStep ? <p className="dr-next">{nextStep}</p> : null}
      {layout === "pick-one" ? (
        <div className="dr-opts" role="radiogroup" aria-label="Draft options">
          {options.map((o, i) => (
            <button
              key={i}
              role="radio"
              aria-checked={selection === i}
              className={`dr-opt${selection === i ? " sel" : ""}`}
              onClick={() => props.onSelect(i)}
            >
              <span className="dr-tag">
                {o.label}
                {selection === i ? " · picked" : ""}
              </span>
              {paragraphs(o.body).map((p, j) => (
                <span key={j} className="dr-line">
                  {p}
                </span>
              ))}
            </button>
          ))}
        </div>
      ) : null}
      {layout === "hooks-plus-body" ? (
        <>
          <div className="dr-opts" role="radiogroup" aria-label="Hook options">
            {options.map((o, i) => (
              <button
                key={i}
                role="radio"
                aria-checked={selection === i}
                className={`dr-opt hook${selection === i ? " sel" : ""}`}
                onClick={() => props.onSelect(i)}
              >
                <span className="dr-tag">
                  {o.label}
                  {selection === i ? " · picked" : ""}
                </span>
                <span className="dr-line">{o.body.trim()}</span>
              </button>
            ))}
          </div>
          {threadBody ? (
            <>
              <p className="dr-sub">Thread — pairs with your picked hook</p>
              <div className="dr-prose">
                {paragraphs(threadBody).map((p, i) => (
                  <p key={i}>{p}</p>
                ))}
              </div>
            </>
          ) : null}
        </>
      ) : null}
      {layout === "prose" ? (
        <div className="dr-prose">
          {paragraphs(body).map((p, i) => (
            <p key={i}>{p}</p>
          ))}
        </div>
      ) : null}
      <div className="row">
        <button onClick={props.onEdit}>Edit</button>
        <button onClick={props.onFeedback}>Feedback</button>
      </div>
    </div>
  );
}
