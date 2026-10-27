"use client";

import { useCallback, useEffect, useState } from "react";

const PLATFORMS = [
  { id: "x_posts", label: "X", source: "x_posts" },
  { id: "tiktok_videos", label: "TikTok", source: "tiktok_videos" },
  { id: "instagram_posts", label: "Instagram", source: "instagram_posts" },
];

const URL_SOURCES = [
  { id: "youtube_transcript", label: "YouTube transcript by URL" },
  { id: "instagram_reel", label: "Instagram reel transcript by URL" },
];

const WINDOWS = [
  { id: "7", label: "Last 7 days" },
  { id: "30", label: "Last 30 days" },
  { id: "90", label: "Last 90 days" },
  { id: "all", label: "All time" },
];

const HANDLE_KEY = "creagent.ingest.handles";

type Asset = {
  id: string;
  source: string;
  title: string;
  source_url: string | null;
  chars: number;
  analyzed_at: string | null;
  posted_at: string | null;
  created_at: string;
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

function loadHandles(): Record<string, string> {
  try {
    return (JSON.parse(window.localStorage.getItem(HANDLE_KEY) ?? "{}") as Record<string, string>) ?? {};
  } catch {
    return {};
  }
}

export default function IngestConsole(): React.ReactNode {
  const [handles, setHandles] = useState<Record<string, string>>({});
  const [checked, setChecked] = useState<Record<string, boolean>>({
    x_posts: true,
    tiktok_videos: false,
    instagram_posts: false,
  });
  const [windowId, setWindowId] = useState("30");
  const [urlSource, setUrlSource] = useState(URL_SOURCES[0].id);
  const [urlValue, setUrlValue] = useState("");
  const [assets, setAssets] = useState<Asset[]>([]);
  const [phase, setPhase] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refreshAssets = useCallback(async () => {
    try {
      const data = await readJson(await fetch("/api/assets?limit=50"));
      setAssets(data.assets as Asset[]);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    setHandles(loadHandles());
    void refreshAssets();
  }, [refreshAssets]);

  function setHandle(id: string, value: string): void {
    setHandles((h) => {
      const next = { ...h, [id]: value };
      try {
        window.localStorage.setItem(HANDLE_KEY, JSON.stringify(next));
      } catch {
        /* private mode */
      }
      return next;
    });
  }

  async function runBatch(since: string | undefined, label: string): Promise<void> {
    const targets = PLATFORMS.filter((p) => checked[p.id] && (handles[p.id] ?? "").trim());
    if (targets.length === 0) {
      setError("check at least one platform and enter its handle");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      let total = 0;
      for (const t of targets) {
        setPhase(`${label}: ${t.label}…`);
        const started = await readJson(
          await fetch("/api/ingest", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              source: t.source,
              value: (handles[t.id] ?? "").replace(/^@/, "").trim(),
              since,
            }),
          }),
        );
        const done = await pollJob(started.jobId as string);
        if (done.state === "failed") throw new Error((done.failedReason as string) ?? "ingest failed");
        total += ((done.result ?? {}) as { assets?: number }).assets ?? 0;
      }
      setPhase("Analyzing…");
      const started = await readJson(
        await fetch("/api/analysis/run", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        }),
      );
      const done = await pollJob(started.jobId as string);
      if (done.state === "failed") throw new Error((done.failedReason as string) ?? "analysis failed");
      setPhase(`Done: ${total} new asset${total === 1 ? "" : "s"} ingested and analyzed.`);
      await refreshAssets();
    } catch (e) {
      setError((e as Error).message);
      setPhase(null);
    } finally {
      setBusy(false);
    }
  }

  async function ingestAndAnalyze(): Promise<void> {
    const days = windowId === "all" ? null : Number(windowId);
    const since =
      days === null ? undefined : new Date(Date.now() - days * 86400000).toISOString();
    await runBatch(since, "Ingesting");
  }

  async function refreshUpToNow(): Promise<void> {
    const latest = assets
      .map((a) => a.posted_at ?? a.created_at)
      .sort()
      .at(-1);
    const since =
      latest ?? new Date(Date.now() - 7 * 86400000).toISOString();
    await runBatch(since, "Refreshing");
  }

  async function ingestUrl(): Promise<void> {
    if (!urlValue.trim()) return;
    setBusy(true);
    setError(null);
    try {
      setPhase("Ingesting URL…");
      const started = await readJson(
        await fetch("/api/ingest", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ source: urlSource, value: urlValue.trim() }),
        }),
      );
      const done = await pollJob(started.jobId as string);
      if (done.state === "failed") throw new Error((done.failedReason as string) ?? "ingest failed");
      setPhase("URL ingested. Run analysis to fold it into the brain.");
      setUrlValue("");
      await refreshAssets();
    } catch (e) {
      setError((e as Error).message);
      setPhase(null);
    } finally {
      setBusy(false);
    }
  }

  async function analyzeOnly(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      setPhase("Analyzing…");
      const started = await readJson(
        await fetch("/api/analysis/run", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        }),
      );
      const done = await pollJob(started.jobId as string);
      if (done.state === "failed") throw new Error((done.failedReason as string) ?? "analysis failed");
      setPhase("Analysis complete.");
      await refreshAssets();
    } catch (e) {
      setError((e as Error).message);
      setPhase(null);
    } finally {
      setBusy(false);
    }
  }

  const unanalyzed = assets.filter((a) => !a.analyzed_at).length;

  return (
    <>
      <section className="keycard">
        <h2>Accounts</h2>
        {PLATFORMS.map((p) => (
          <div className="checkline" key={p.id}>
            <input
              type="checkbox"
              aria-label={`Include ${p.label}`}
              checked={checked[p.id] ?? false}
              onChange={(e) => setChecked((c) => ({ ...c, [p.id]: e.target.checked }))}
            />
            <label style={{ minWidth: 74 }}>{p.label}</label>
            <input
              type="text"
              spellCheck={false}
              aria-label={`${p.label} handle`}
              placeholder="username (no @)"
              value={handles[p.id] ?? ""}
              onChange={(e) => setHandle(p.id, e.target.value)}
            />
          </div>
        ))}
        <div className="row">
          <select aria-label="Window" value={windowId} onChange={(e) => setWindowId(e.target.value)}>
            {WINDOWS.map((w) => (
              <option key={w.id} value={w.id}>
                {w.label}
              </option>
            ))}
          </select>
          <button className="primary" disabled={busy} onClick={() => void ingestAndAnalyze()}>
            {busy ? "Working…" : "Ingest & analyze"}
          </button>
          <button disabled={busy} onClick={() => void refreshUpToNow()}>
            Refresh
          </button>
          <button disabled={busy || unanalyzed === 0} onClick={() => void analyzeOnly()}>
            Analyze unanalyzed ({unanalyzed})
          </button>
        </div>
        {phase ? <p className="note ok">{phase}</p> : null}
        {error ? <p className="note err">{error}</p> : null}
      </section>

      <section className="keycard">
        <h2>Single URL</h2>
        <div className="row">
          <select
            value={urlSource}
            onChange={(e) => setUrlSource(e.target.value)}
            aria-label="URL source type"
          >
            {URL_SOURCES.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
          <input
            type="text"
            spellCheck={false}
            placeholder="https://…"
            value={urlValue}
            onChange={(e) => setUrlValue(e.target.value)}
          />
          <button disabled={busy || !urlValue.trim()} onClick={() => void ingestUrl()}>
            Ingest
          </button>
        </div>
      </section>

      <h2>Assets ({assets.length})</h2>
      {assets.length === 0 ? (
        <p className="muted">Nothing ingested yet.</p>
      ) : (
        assets.slice(0, 20).map((a) => (
          <p key={a.id} className="muted">
            {a.title.slice(0, 90)}
            <span className={`status ${a.analyzed_at ? "set" : "unset"}`}>
              {a.analyzed_at ? "analyzed" : "new"}
            </span>{" "}
            · {a.source} · {(a.posted_at ?? a.created_at).slice(0, 10)}
            {a.source_url ? (
              <>
                {" · "}
                <a href={a.source_url} target="_blank" rel="noreferrer">
                  source
                </a>
              </>
            ) : null}
          </p>
        ))
      )}
    </>
  );
}
