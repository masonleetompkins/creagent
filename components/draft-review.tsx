"use client";

import { useEffect, useState } from "react";
import type { DraftStructureView } from "@/lib/draft-structure";
import { charCount, splitLegacyOptions } from "@/lib/draft-structure";

// DraftReview: the guided draft-reading surface. Renders a code-assembled
// structure (option cards + a one-line next step) when present, clean prose
// otherwise. No queue imports — carousel slides, video scripts, and any
// future surface can reuse it by passing options + body.

function paragraphs(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
}

type Props = {
  draftId: string;
  title: string;
  edited: boolean;
  structure: DraftStructureView | null;
  body: string;
  selection: number;
  nextStep: string | null;
  // Tightest platform cap for N/Total counts; null shows bare counts.
  limit?: number | null;
  onSelect: (index: number) => void;
  // Edit target: an option index, the thread body, or the whole draft.
  onEdit: (target: number | "thread" | null) => void;
  onFeedback: () => void;
};

function Count({ n, limit }: { n: number; limit: number | null | undefined }): React.ReactNode {
  const over = limit != null && n > limit;
  return <span className={`charcount${over ? " over" : ""}`}>{limit != null ? `${n}/${limit}` : `${n}`}</span>;
}

export default function DraftReview(props: Props): React.ReactNode {
  const { draftId, title, edited, structure, body, selection, nextStep } = props;
  const legacy = structure ? null : splitLegacyOptions(body);
  const layout = structure?.layout ?? (legacy ? "pick-one" : "prose");
  const options = structure?.options ?? legacy ?? [];
  const threadBody = structure?.layout === "hooks-plus-body" ? structure.body : undefined;
  const bankable = layout !== "prose" && options.length > 1;
  const [bankMode, setBankMode] = useState(false);
  const [banked, setBanked] = useState<Record<number, string>>({});

  useEffect(() => {
    if (!bankable) return;
    let live = true;
    fetch("/api/bank")
      .then((r) => r.json())
      .then((data: { items?: Array<{ id: string; label: string; source_draft_id: string | null; status: string }> }) => {
        if (!live) return;
        const mine: Record<number, string> = {};
        for (const item of data.items ?? []) {
          if (item.source_draft_id !== draftId || item.status !== "banked") continue;
          const idx = options.findIndex((o) => o.label === item.label);
          if (idx >= 0) mine[idx] = item.id;
        }
        setBanked(mine);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [bankable, draftId]); // eslint-disable-line react-hooks/exhaustive-deps

  async function toggleBank(index: number): Promise<void> {
    const existing = banked[index];
    try {
      if (existing) {
        const res = await fetch(`/api/bank/${existing}`, { method: "DELETE" });
        if (!res.ok) return;
        setBanked((b) => {
          const next = { ...b };
          delete next[index];
          return next;
        });
      } else {
        const res = await fetch("/api/bank", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ draftId, optionIndex: index }),
        });
        if (!res.ok) return;
        const data = (await res.json()) as { id: string };
        setBanked((b) => ({ ...b, [index]: data.id }));
      }
    } catch {
      /* bank stays local-only on failure; fill reports the truth */
    }
  }

  function bankProps(index: number): { onContextMenu?: (e: React.MouseEvent) => void } {
    if (!bankMode) return {};
    return {
      onContextMenu: (e: React.MouseEvent) => {
        e.preventDefault();
        void toggleBank(index);
      },
    };
  }

  return (
    <div className="dr">
      <h2>
        {title}
        {edited ? " — edited" : ""}
      </h2>
      {nextStep || bankMode ? (
        <p className="dr-next">
          {bankMode ? "Bank mode — right-click options to save them for later slots." : nextStep}
        </p>
      ) : null}
      {layout === "pick-one" ? (
        <div className="dr-opts" role="radiogroup" aria-label="Draft options">
          {options.map((o, i) => (
            <button
              key={i}
              role="radio"
              aria-checked={selection === i}
              className={`dr-opt${selection === i ? " sel" : ""}${banked[i] ? " banked" : ""}`}
              onClick={() => props.onSelect(i)}
              {...bankProps(i)}
            >
              <span className="dr-tag">
                {o.label} · <Count n={charCount(o.body)} limit={props.limit} />
                {selection === i ? " · picked" : ""}
                {banked[i] ? " · banked" : ""}
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
                className={`dr-opt hook${selection === i ? " sel" : ""}${banked[i] ? " banked" : ""}`}
                onClick={() => props.onSelect(i)}
                {...bankProps(i)}
              >
                <span className="dr-tag">
                  {o.label} · <Count n={charCount(o.body)} limit={props.limit} />
                  {selection === i ? " · picked" : ""}
                  {banked[i] ? " · banked" : ""}
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
                  <p key={i}>
                    {p} <Count n={charCount(p)} limit={props.limit} />
                  </p>
                ))}
              </div>
            </>
          ) : null}
        </>
      ) : null}
      {layout === "prose" ? (
        <div className="dr-prose">
          {paragraphs(body).map((p, i) => (
            <p key={i}>
              {p} <Count n={charCount(p)} limit={props.limit} />
            </p>
          ))}
        </div>
      ) : null}
      <div className="row">
        {layout === "pick-one" ? (
          <button onClick={() => props.onEdit(selection)}>Edit picked</button>
        ) : null}
        {layout === "hooks-plus-body" ? (
          <>
            <button onClick={() => props.onEdit(selection)}>Edit hook</button>
            {threadBody ? <button onClick={() => props.onEdit("thread")}>Edit thread</button> : null}
          </>
        ) : null}
        {layout === "prose" ? <button onClick={() => props.onEdit(null)}>Edit</button> : null}
        <button onClick={props.onFeedback}>Feedback</button>
        {bankable ? (
          <button
            aria-pressed={bankMode}
            className={bankMode ? "primary" : ""}
            onClick={() => setBankMode((m) => !m)}
          >
            {bankMode ? "Banking: on" : "Bank options"}
          </button>
        ) : null}
      </div>
    </div>
  );
}
