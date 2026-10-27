"use client";

import { useCallback, useEffect, useState } from "react";

type Review = {
  id: string;
  scheduled_at: string;
  pillar_name: string | null;
  content_type: string;
  draft_body: string | null;
};
type GenReq = {
  id: string;
  project_id: string | null;
  prompt: string;
  pillar_name: string | null;
};

// Pending approvals as inline cards. Shared by the agent dock and the chat
// page so approvals arrive inside the thread, not on another page.
export default function ReviewCards(): React.ReactNode {
  const [review, setReview] = useState<Review[]>([]);
  const [gen, setGen] = useState<GenReq[]>([]);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/home");
      if (!res.ok) return;
      const d = (await res.json()) as { review: Review[]; genRequests: GenReq[] };
      setReview(d.review ?? []);
      setGen(d.genRequests ?? []);
    } catch {
      /* cards stay hidden */
    }
  }, []);

  useEffect(() => {
    void load();
    const onUpd = (): void => void load();
    window.addEventListener("creagent:review-updated", onUpd);
    return () => window.removeEventListener("creagent:review-updated", onUpd);
  }, [load]);

  const done = useCallback(() => {
    window.dispatchEvent(new CustomEvent("creagent:review-updated"));
    window.dispatchEvent(new CustomEvent("creagent:agent-updated"));
    void load();
  }, [load]);

  if (review.length === 0 && gen.length === 0) return null;
  return (
    <div className="review-strip">
      <div className="muted" style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase" }}>
        Waiting on your approval
      </div>
      {review.map((r) => (
        <div key={r.id} className="review-card slim">
          <div className="review-head">
            <strong>{r.pillar_name ?? "No pillar"} · {r.content_type}</strong>
          </div>
          {r.draft_body && <p className="review-body">{r.draft_body.slice(0, 120)}{r.draft_body.length > 120 ? "…" : ""}</p>}
          <div className="review-actions">
            <button
              className="primary"
              onClick={() =>
                void fetch(`/api/slots/${r.id}`, {
                  method: "PATCH",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({ status: "green" }),
                }).then(done)
              }
            >
              Approve
            </button>
            <a href="/queue">
              <button>Open</button>
            </a>
          </div>
        </div>
      ))}
      {gen.map((g) => (
        <div key={g.id} className="review-card slim">
          <div className="review-head">
            <strong>Image{g.pillar_name ? ` · ${g.pillar_name}` : ""}</strong>
          </div>
          <p className="review-body">{g.prompt.slice(0, 120)}{g.prompt.length > 120 ? "…" : ""}</p>
          <div className="review-actions">
            <button className="primary" onClick={() => void fetch(`/api/gen-requests/${g.id}/approve`, { method: "POST" }).then(done)}>
              Approve
            </button>
            <button onClick={() => void fetch(`/api/gen-requests/${g.id}/reject`, { method: "POST" }).then(done)}>
              Reject
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
