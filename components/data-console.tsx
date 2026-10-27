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
  is_reply: number;
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
  const [sortKey, setSortKey] = useState<"date" | "platform" | "likes" | "comments" | "shares" | "views">("date");
  const [sortDir, setSortDir] = useState<1 | -1>(-1);

  const sorted = [...posts].sort((a, b) => {
    if (sortKey === "platform") return sortDir * a.platform.localeCompare(b.platform);
    if (sortKey === "date") {
      const da = a.posted_at ?? a.collected_at;
      const db = b.posted_at ?? b.collected_at;
      return sortDir * da.localeCompare(db);
    }
    const ma = a.multipliers[sortKey] ?? -1;
    const mb = b.multipliers[sortKey] ?? -1;
    return sortDir * (ma - mb);
  });

  const toggleSort = (key: typeof sortKey): void => {
    if (key === sortKey) setSortDir((d) => (d === 1 ? -1 : 1));
    else {
      setSortKey(key);
      setSortDir(key === "platform" ? 1 : -1);
    }
  };

  const arrow = (key: typeof sortKey): string => (key === sortKey ? (sortDir === 1 ? " ↑" : " ↓") : "");

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
              <th><button className="th-sort" onClick={() => toggleSort("date")}>Date{arrow("date")}</button></th>
              <th><button className="th-sort" onClick={() => toggleSort("platform")}>Platform{arrow("platform")}</button></th>
              <th><button className="th-sort" onClick={() => toggleSort("likes")}>Likes{arrow("likes")}</button></th>
              <th><button className="th-sort" onClick={() => toggleSort("comments")}>Comments{arrow("comments")}</button></th>
              <th><button className="th-sort" onClick={() => toggleSort("shares")}>Shares{arrow("shares")}</button></th>
              <th><button className="th-sort" onClick={() => toggleSort("views")}>Views{arrow("views")}</button></th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((p) => (
              <tr key={p.id}>
                <td className="nowrap muted">{(p.posted_at ?? p.collected_at).slice(0, 10)}</td>
                <td className="nowrap">
                  {p.platform}
                  {p.is_reply ? <span className="reply-tag" title="Reply, not an original post"> ↩ reply</span> : null}
                </td>
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
