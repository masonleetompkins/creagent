"use client";

import { useCallback, useEffect, useState } from "react";

type Averages = {
  count: number;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  views: number | null;
};

type ScoredPost = {
  id: string;
  platform: string;
  post_url: string | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  views: number | null;
  posted_at: string | null;
  collected_at: string;
  multipliers: Averages;
};

async function readJson(res: Response): Promise<Record<string, unknown>> {
  const data = (await res.json()) as Record<string, unknown>;
  if (!res.ok) throw new Error((data.error as string) ?? `HTTP ${res.status}`);
  return data;
}

async function pollJob(jobId: string): Promise<Record<string, unknown>> {
  for (;;) {
    const data = await readJson(await fetch(`/api/jobs/${jobId}`));
    if (data.state === "completed" || data.state === "failed") return data;
    await new Promise((r) => setTimeout(r, 2000));
  }
}

function fmtAvg(value: number | null): string {
  if (value === null) return "—";
  return value >= 100 ? Math.round(value).toString() : value.toFixed(1);
}

function Metric({
  value,
  mult,
}: {
  value: number | null;
  mult: number | null;
}): React.ReactNode {
  if (value === null) return <>—</>;
  return (
    <>
      {value.toLocaleString()}
      {mult !== null ? <span className="mult"> {mult}x</span> : null}
    </>
  );
}

export default function DataConsole(): React.ReactNode {
  const [platforms, setPlatforms] = useState<Array<{ platform: string; averages: Averages }>>([]);
  const [posts, setPosts] = useState<ScoredPost[]>([]);
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const data = await readJson(
        await fetch(`/api/metrics${filter ? `?platform=${encodeURIComponent(filter)}` : ""}`),
      );
      setPlatforms(data.platforms as Array<{ platform: string; averages: Averages }>);
      setPosts(data.posts as ScoredPost[]);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [filter]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function sync(): Promise<void> {
    setBusy(true);
    setNote(null);
    setError(null);
    try {
      const started = await readJson(
        await fetch("/api/metrics/sync", { method: "POST" }),
      );
      const done = await pollJob(started.jobId as string);
      if (done.state === "failed") throw new Error((done.failedReason as string) ?? "sync failed");
      setNote(`Synced: ${JSON.stringify(done.result ?? {}).slice(0, 200)}`);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <section className="keycard">
        <div className="row">
          <select aria-label="Platform filter" value={filter} onChange={(e) => setFilter(e.target.value)}>
            <option value="">All platforms</option>
            {platforms.map((p) => (
              <option key={p.platform} value={p.platform}>
                {p.platform}
              </option>
            ))}
          </select>
          <button className="primary" disabled={busy} onClick={() => void sync()}>
            {busy ? "Syncing…" : "Sync metrics"}
          </button>
        </div>
        {note ? <p className="note ok">{note}</p> : null}
        {error ? <p className="note err">{error}</p> : null}
      </section>

      <h2>Averages</h2>
      {platforms.length === 0 ? (
        <p className="muted">No metrics yet — sync to pull them in.</p>
      ) : (
        platforms.map((p) => (
          <section className="keycard" key={p.platform}>
            <h2>
              {p.platform} <span className="status unset">{p.averages.count} posts</span>
            </h2>
            <p className="muted">
              likes {fmtAvg(p.averages.likes)} · comments {fmtAvg(p.averages.comments)} ·
              shares {fmtAvg(p.averages.shares)} · views {fmtAvg(p.averages.views)}
            </p>
          </section>
        ))
      )}

      <h2>Posts ({posts.length})</h2>
      {posts.map((p) => (
        <section className="keycard" key={p.id}>
          <p>
            <strong>{p.platform}</strong>
            {p.post_url ? (
              <>
                {" · "}
                <a href={p.post_url} target="_blank" rel="noreferrer">
                  open
                </a>
              </>
            ) : null}
          </p>
          <p className="muted">
            likes <Metric value={p.likes} mult={p.multipliers.likes} /> · comments{" "}
            <Metric value={p.comments} mult={p.multipliers.comments} /> · shares{" "}
            <Metric value={p.shares} mult={p.multipliers.shares} /> · views{" "}
            <Metric value={p.views} mult={p.multipliers.views} />
          </p>
        </section>
      ))}
    </>
  );
}
