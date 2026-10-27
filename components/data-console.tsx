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
      <div className="toolbar">
        <select aria-label="Platform filter" value={filter} onChange={(e) => setFilter(e.target.value)}>
          <option value="">All platforms</option>
          {platforms.map((p) => (
            <option key={p.platform} value={p.platform}>
              {p.platform}
            </option>
          ))}
        </select>
        <span className="spacer" />
        <button className="primary" disabled={busy} onClick={() => void sync()}>
          {busy ? "Syncing…" : "Sync metrics"}
        </button>
      </div>
      {note ? <p className="note ok">{note}</p> : null}
      {error ? <p className="note err">{error}</p> : null}

      <h2>Averages</h2>
      {platforms.length === 0 ? (
        <div className="empty">No metrics yet — sync to pull them in.</div>
      ) : (
        <div className="tiles">
          {platforms.map((p) => (
            <div className="tile" key={p.platform}>
              <div className="t">{p.platform}</div>
              <div className="big">{fmtAvg(p.averages.likes)} likes</div>
              <div className="d">
                from {p.averages.count} posts · comments {fmtAvg(p.averages.comments)} ·
                shares {fmtAvg(p.averages.shares)} · views {fmtAvg(p.averages.views)}
              </div>
            </div>
          ))}
        </div>
      )}

      <h2>Posts ({posts.length})</h2>
      {posts.length === 0 ? (
        <div className="empty">Nothing scored yet.</div>
      ) : (
        <table className="vtable">
          <thead>
            <tr>
              <th>Date</th>
              <th>Platform</th>
              <th>Likes</th>
              <th>Comments</th>
              <th>Shares</th>
              <th>Views</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {posts.map((p) => (
              <tr key={p.id}>
                <td className="nowrap muted">{(p.posted_at ?? p.collected_at).slice(0, 10)}</td>
                <td className="nowrap">{p.platform}</td>
                <td className="nowrap"><Metric value={p.likes} mult={p.multipliers.likes} /></td>
                <td className="nowrap"><Metric value={p.comments} mult={p.multipliers.comments} /></td>
                <td className="nowrap"><Metric value={p.shares} mult={p.multipliers.shares} /></td>
                <td className="nowrap"><Metric value={p.views} mult={p.multipliers.views} /></td>
                <td className="nowrap">
                  {p.post_url ? (
                    <a href={p.post_url} target="_blank" rel="noreferrer">
                      open
                    </a>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
