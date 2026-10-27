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
type Ready = {
  id: string;
  scheduled_at: string;
  pillar_name: string | null;
  content_type: string;
  platforms: string;
};
type Act = { content: string; created_at: string; chat_title: string };
type HomeData = {
  due: Due[];
  review: Review[];
  genRequests: GenReq[];
  readyToPost: Ready[];
  activity: Act[];
  templates: number;
  setup: { assets: number; pillars: number; hasMetaKey: boolean };
};
type MetricPost = { views: number | null; posted_at: string | null };

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

async function pollJob(jobId: string): Promise<void> {
  for (let i = 0; i < 90; i++) {
    const poll = await fetch(`/api/jobs/${jobId}`);
    if (!poll.ok) return;
    const job = (await poll.json()) as { state: string };
    if (job.state === "completed" || job.state === "failed") return;
    await new Promise((r) => setTimeout(r, 2000));
  }
}

export default function HomeConsole(): React.ReactNode {
  const [data, setData] = useState<HomeData | null>(null);
  const [metrics, setMetrics] = useState<MetricPost[] | null>(null);
  const [busyTask, setBusyTask] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    const [h, m] = await Promise.all([fetch("/api/home"), fetch("/api/metrics")]);
    if (h.ok) setData((await h.json()) as HomeData);
    if (m.ok) setMetrics((((await m.json()) as { posts: MetricPost[] }).posts ?? []));
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const act = useCallback(
    async (taskId: string, fn: () => Promise<Response>) => {
      setBusyTask(taskId);
      setError("");
      try {
        const res = await fn();
        if (!res.ok) {
          const d = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(d.error ?? "action failed");
        }
        const d = (await res.json().catch(() => ({}))) as { jobId?: string };
        if (d.jobId) await pollJob(d.jobId);
        await load();
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setBusyTask(null);
      }
    },
    [load],
  );

  const refreshMetrics = useCallback(async () => {
    setSyncing(true);
    setError("");
    try {
      const started = await fetch("/api/metrics/sync", { method: "POST" });
      if (!started.ok) throw new Error("sync failed to start");
      const { jobId } = (await started.json()) as { jobId: string };
      await pollJob(jobId);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSyncing(false);
    }
  }, [load]);

  if (!data) return <p className="muted">Loading today…</p>;
  const fresh = data.setup.assets === 0;
  const tasksCount =
    (data.templates === 0 ? 1 : 0) +
    data.due.filter((s) => s.status === "red" && s.draft_count === 0).length +
    data.review.length +
    data.genRequests.length +
    data.readyToPost.length;
  const allQuiet = tasksCount === 0;

  const now = Date.now();
  const week = 7 * 86400000;
  const views = (posts: MetricPost[], from: number, to: number): number =>
    posts.reduce((n, p) => {
      if (!p.posted_at || p.views === null) return n;
      const t = Date.parse(p.posted_at);
      return t >= from && t < to ? n + p.views : n;
    }, 0);
  const cur = metrics ? views(metrics, now - week, now) : null;
  const prev = metrics ? views(metrics, now - 2 * week, now - week) : null;
  const delta = cur !== null && prev !== null && prev > 0 ? Math.round(((cur - prev) / prev) * 100) : null;

  return (
    <div className="home">
      {error !== "" && <p className="note err">{error}</p>}
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
      ) : (
        <div className="home-grid">
          <section>
            <h3>Tasks ({tasksCount})</h3>
            {allQuiet && (
              <div className="keycard">
                <h3 style={{ marginTop: 0 }}>All quiet.</h3>
                <p className="muted" style={{ marginBottom: 0 }}>
                  Nothing needs you. The planner keeps 14 days drafted — check the{" "}
                  <a href="/queue">Calendar</a> to see what is coming.
                </p>
              </div>
            )}
            {data.templates === 0 && (
              <div className="task-row cta">
                <div>
                  <strong>No posting schedule yet</strong>
                  <p className="muted">Set your cadence so the planner can keep 14 days drafted.</p>
                </div>
                <a href="/queue">
                  <button className="primary">Queue setup</button>
                </a>
              </div>
            )}
            {data.due
              .filter((s) => s.status === "red" && s.draft_count === 0)
              .map((s) => (
                <div key={s.id} className="task-row">
                  <div>
                    <strong>
                      Draft: {s.pillar_name ?? "No pillar"} · {s.content_type}
                    </strong>
                    <p className="muted">{when(s.scheduled_at)}{platforms(s.platforms) ? ` · ${platforms(s.platforms)}` : ""}</p>
                  </div>
                  <button
                    className="primary"
                    disabled={busyTask === s.id}
                    onClick={() =>
                      void act(s.id, () =>
                        fetch("/api/draft/run", {
                          method: "POST",
                          headers: { "content-type": "application/json" },
                          body: JSON.stringify({ slotId: s.id }),
                        }),
                      )
                    }
                  >
                    {busyTask === s.id ? "Drafting…" : "Draft now"}
                  </button>
                </div>
              ))}
            {data.review.map((r) => (
              <div key={r.id} className="task-row">
                <div>
                  <strong>
                    Review: {r.pillar_name ?? "No pillar"} · {r.content_type}
                  </strong>
                  {r.draft_body && <p className="muted">{r.draft_body.slice(0, 140)}{r.draft_body.length > 140 ? "…" : ""}</p>}
                </div>
                <span className="task-btns">
                  <button
                    className="primary"
                    disabled={busyTask === r.id}
                    onClick={() =>
                      void act(r.id, () =>
                        fetch(`/api/slots/${r.id}`, {
                          method: "PATCH",
                          headers: { "content-type": "application/json" },
                          body: JSON.stringify({ status: "green" }),
                        }),
                      )
                    }
                  >
                    Approve
                  </button>
                  <a href="/queue">
                    <button>Open</button>
                  </a>
                </span>
              </div>
            ))}
            {data.genRequests.map((g) => (
              <div key={g.id} className="task-row">
                <div>
                  <strong>Image request{g.pillar_name ? ` · ${g.pillar_name}` : ""}</strong>
                  <p className="muted">{g.prompt.slice(0, 140)}{g.prompt.length > 140 ? "…" : ""}</p>
                </div>
                <span className="task-btns">
                  <button
                    className="primary"
                    disabled={busyTask === g.id}
                    onClick={() => void act(g.id, () => fetch(`/api/gen-requests/${g.id}/approve`, { method: "POST" }))}
                  >
                    Approve
                  </button>
                  <button
                    disabled={busyTask === g.id}
                    onClick={() => void act(g.id, () => fetch(`/api/gen-requests/${g.id}/reject`, { method: "POST" }))}
                  >
                    Reject
                  </button>
                </span>
              </div>
            ))}
            {data.readyToPost.map((r) => (
              <div key={r.id} className="task-row">
                <div>
                  <strong>
                    Post: {r.pillar_name ?? "No pillar"} · {r.content_type}
                  </strong>
                  <p className="muted">{when(r.scheduled_at)}{platforms(r.platforms) ? ` · ${platforms(r.platforms)}` : ""}</p>
                </div>
                <button
                  disabled={busyTask === r.id}
                  onClick={() => void act(r.id, () => fetch(`/api/slots/${r.id}/post`, { method: "POST" }))}
                >
                  Mark posted
                </button>
              </div>
            ))}
          </section>
          <section>
            <h3>Last 7 days</h3>
            <div className="metric-hero">
              <div className="big">{cur === null ? "…" : cur.toLocaleString()}</div>
              <div className="muted">views across platforms</div>
              <div className={`delta${delta !== null && delta < 0 ? " down" : ""}`}>
                {delta === null ? "no prior week to compare" : `${delta >= 0 ? "+" : ""}${delta}% vs prior 7d`}
              </div>
              <button disabled={syncing} onClick={() => void refreshMetrics()}>
                {syncing ? "Refreshing…" : "Refresh"}
              </button>
            </div>
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
