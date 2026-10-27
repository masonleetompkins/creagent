"use client";

import { useCallback, useEffect, useState } from "react";

type Due = {
  id: string;
  scheduled_at: string;
  pillar_name: string | null;
  content_type: string;
  platforms: string;
  status: string;
  draft_count: number;
};
type Review = {
  id: string;
  scheduled_at: string;
  pillar_name: string | null;
  content_type: string;
  platforms: string;
  draft_body: string | null;
  draft_kind: string | null;
};
type GenReq = {
  id: string;
  slot_id: string | null;
  project_id: string | null;
  kind: string;
  prompt: string;
  created_at: string;
  scheduled_at: string | null;
  content_type: string | null;
  pillar_name: string | null;
};
type Act = { content: string; created_at: string; chat_title: string };
type HomeData = {
  due: Due[];
  review: Review[];
  genRequests: GenReq[];
  activity: Act[];
  setup: { assets: number; pillars: number; hasMetaKey: boolean };
};

function platforms(p: string): string {
  try {
    const arr = JSON.parse(p) as unknown;
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === "string").join(" · ") : "";
  } catch {
    return "";
  }
}

function when(iso: string): string {
  const d = new Date(iso);
  const now = Date.now();
  const diffH = (d.getTime() - now) / 3600000;
  const day = d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (diffH < -1) return `${day} ${time} · overdue`;
  if (diffH < 24) return `Today ${time}`;
  return `${day} ${time}`;
}

export default function HomeConsole(): React.ReactNode {
  const [data, setData] = useState<HomeData | null>(null);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [sentChat, setSentChat] = useState<string | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    const res = await fetch("/api/home");
    if (res.ok) setData((await res.json()) as HomeData);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || sending) return;
    setSending(true);
    setError("");
    try {
      const c = await fetch("/api/agent/chats", { method: "POST" });
      if (!c.ok) throw new Error("could not create chat");
      const { chatId } = (await c.json()) as { chatId: string };
      const m = await fetch(`/api/agent/chats/${chatId}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: text }),
      });
      if (!m.ok) throw new Error("send failed");
      setInput("");
      setSentChat(chatId);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSending(false);
    }
  }, [input, sending]);

  const approveSlot = useCallback(
    async (id: string) => {
      await fetch(`/api/slots/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "green" }),
      });
      void load();
    },
    [load],
  );

  const decideGen = useCallback(
    async (id: string, verdict: "approve" | "reject") => {
      await fetch(`/api/gen-requests/${id}/${verdict}`, { method: "POST" });
      void load();
    },
    [load],
  );

  if (!data) return <p className="muted">Loading today…</p>;
  const fresh = data.setup.assets === 0;
  const allQuiet = data.due.length === 0 && data.review.length === 0 && data.genRequests.length === 0;

  return (
    <div className="home">
      {error !== "" && <p className="note err">{error}</p>}
      <div className="hero-box home-composer">
        <textarea
          rows={2}
          placeholder="Tell the agent what to do — draft the week, plan a carousel, analyze performance…"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <button className="primary" disabled={sending || !input.trim()} onClick={() => void send()}>
          {sending ? "Sending…" : "Send"}
        </button>
      </div>
      {sentChat && (
        <p className="muted">
          Agent is on it. <a href="/chat">Open the conversation →</a>
        </p>
      )}
      {fresh ? (
        <div className="keycard">
          <h3 style={{ marginTop: 0 }}>Get started</h3>
          <ol className="steps">
            <li>
              {!data.setup.hasMetaKey ? (
                <>Open <a href="/settings">Settings</a> and save your Meta API key.</>
              ) : (
                <>Meta key saved. ✓</>
              )}
            </li>
            <li>
              In <a href="/settings">Settings → Ingest</a>, pull in your existing posts, then run
              analysis to build your voice profile and pillars.
            </li>
            <li>
              Open the <a href="/queue">Calendar</a>, set your cadence, and let the planner keep 14
              days drafted.
            </li>
          </ol>
        </div>
      ) : allQuiet ? (
        <div className="keycard">
          <h3 style={{ marginTop: 0 }}>All quiet.</h3>
          <p className="muted" style={{ marginBottom: 0 }}>
            Nothing due, nothing waiting on review. The planner keeps 14 days drafted — check the{" "}
            <a href="/queue">Calendar</a> to see what is coming.
          </p>
        </div>
      ) : (
        <div className="home-grid">
          <section>
            <h3>Due & overdue</h3>
            {data.due.length === 0 && <p className="muted">Nothing due in the next day.</p>}
            {data.due.map((s) => (
              <a key={s.id} className={`due-row ${s.status}`} href="/queue">
                <span className="due-dot" aria-hidden="true" />
                <span className="due-main">
                  <span className="due-title">
                    {s.pillar_name ?? "No pillar"} · {s.content_type}
                  </span>
                  <span className="muted">
                    {when(s.scheduled_at)}
                    {platforms(s.platforms) ? ` · ${platforms(s.platforms)}` : ""}
                    {s.draft_count > 0 ? ` · ${s.draft_count} draft${s.draft_count > 1 ? "s" : ""}` : " · no drafts"}
                  </span>
                </span>
              </a>
            ))}
          </section>
          <section>
            <h3>Needs your review</h3>
            {data.review.length === 0 && data.genRequests.length === 0 && (
              <p className="muted">Nothing waiting on you.</p>
            )}
            {data.review.map((r) => (
              <div key={r.id} className="review-card">
                <div className="review-head">
                  <strong>
                    {r.pillar_name ?? "No pillar"} · {r.content_type}
                  </strong>
                  <span className="muted">{when(r.scheduled_at)}</span>
                </div>
                {r.draft_body && <p className="review-body">{r.draft_body.slice(0, 220)}{r.draft_body.length > 220 ? "…" : ""}</p>}
                <div className="review-actions">
                  <button className="primary" onClick={() => void approveSlot(r.id)}>
                    Approve
                  </button>
                  <a href="/queue">
                    <button>Open in calendar</button>
                  </a>
                </div>
              </div>
            ))}
            {data.genRequests.map((g) => (
              <div key={g.id} className="review-card">
                <div className="review-head">
                  <strong>Image request{g.pillar_name ? ` · ${g.pillar_name}` : ""}</strong>
                  <span className="muted">{new Date(g.created_at).toLocaleDateString([], { month: "short", day: "numeric" })}</span>
                </div>
                <p className="review-body">{g.prompt.slice(0, 220)}{g.prompt.length > 220 ? "…" : ""}</p>
                <div className="review-actions">
                  <button className="primary" onClick={() => void decideGen(g.id, "approve")}>
                    Approve & generate
                  </button>
                  <button onClick={() => void decideGen(g.id, "reject")}>Reject</button>
                  {g.project_id && (
                    <a href={`/carousels/${g.project_id}`}>
                      <button>Open carousel</button>
                    </a>
                  )}
                </div>
              </div>
            ))}
          </section>
          <section>
            <h3>Agent activity</h3>
            {data.activity.length === 0 && <p className="muted">No agent turns yet.</p>}
            {data.activity.map((a, i) => (
              <div key={`${a.created_at}-${i}`} className="act-row">
                <span className="muted">
                  {a.chat_title} · {new Date(a.created_at).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
                </span>
                <p>{a.content.slice(0, 160)}{a.content.length > 160 ? "…" : ""}</p>
              </div>
            ))}
          </section>
        </div>
      )}
    </div>
  );
}
