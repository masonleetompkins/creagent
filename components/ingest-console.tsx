"use client";

import { useCallback, useEffect, useState } from "react";

const SOURCES = [
  { id: "x_posts", label: "X posts by handle", placeholder: "username (no @)" },
  { id: "tiktok_videos", label: "TikTok videos by handle", placeholder: "username (no @)" },
  { id: "instagram_posts", label: "Instagram posts by handle", placeholder: "username (no @)" },
  { id: "youtube_transcript", label: "YouTube transcript by URL", placeholder: "https://www.youtube.com/watch?v=…" },
  { id: "instagram_reel", label: "Instagram reel transcript by URL", placeholder: "https://www.instagram.com/reel/…" },
];

type Asset = {
  id: string;
  source: string;
  title: string;
  source_url: string | null;
  chars: number;
  analyzed_at: string | null;
  created_at: string;
};

type JobView = { state: string; detail: string } | null;

async function readJson(res: Response): Promise<Record<string, unknown>> {
  const data = (await res.json()) as Record<string, unknown>;
  if (!res.ok) throw new Error((data.error as string) ?? `HTTP ${res.status}`);
  return data;
}

async function pollJob(jobId: string, onUpdate: (view: JobView) => void): Promise<void> {
  for (;;) {
    const data = await readJson(await fetch(`/api/jobs/${jobId}`));
    const state = data.state as string;
    if (state === "completed") {
      onUpdate({ state, detail: JSON.stringify(data.result ?? {}).slice(0, 300) });
      return;
    }
    if (state === "failed") {
      onUpdate({ state, detail: (data.failedReason as string) ?? "job failed" });
      return;
    }
    const progress = data.progress as { assets?: number } | null;
    onUpdate({
      state,
      detail: progress?.assets !== undefined ? `${progress.assets} assets so far…` : "working…",
    });
    await new Promise((r) => setTimeout(r, 2000));
  }
}

export default function IngestConsole(): React.ReactNode {
  const [source, setSource] = useState(SOURCES[0].id);
  const [value, setValue] = useState("");
  const [assets, setAssets] = useState<Asset[]>([]);
  const [job, setJob] = useState<JobView>(null);
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
    void refreshAssets();
  }, [refreshAssets]);

  async function startIngest(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const data = await readJson(
        await fetch("/api/ingest", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ source, value }),
        }),
      );
      await pollJob(data.jobId as string, setJob);
      await refreshAssets();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function startAnalysis(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const data = await readJson(
        await fetch("/api/analysis/run", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        }),
      );
      await pollJob(data.jobId as string, setJob);
      await refreshAssets();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const active = SOURCES.find((s) => s.id === source) ?? SOURCES[0];
  const unanalyzed = assets.filter((a) => !a.analyzed_at).length;

  return (
    <>
      <section className="keycard">
        <h2>Add a source</h2>
        <div className="row">
          <select
            value={source}
            onChange={(e) => setSource(e.target.value)}
            aria-label="Source type"
          >
            {SOURCES.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
          <input
            type="text"
            spellCheck={false}
            placeholder={active.placeholder}
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
          <button className="primary" disabled={busy || !value.trim()} onClick={() => void startIngest()}>
            {busy ? "Working…" : "Ingest"}
          </button>
        </div>
        {job ? (
          <p className={`note ${job.state === "completed" ? "ok" : job.state === "failed" ? "err" : ""}`}>
            {job.state}: {job.detail}
          </p>
        ) : null}
        {error ? <p className="note err">{error}</p> : null}
      </section>

      <section className="keycard">
        <h2>Analysis</h2>
        <p className="muted">
          {unanalyzed} unanalyzed asset{unanalyzed === 1 ? "" : "s"}. Analysis
          reads them with Meta and writes the voice profile, vault, and pillars.
        </p>
        <div className="row">
          <button disabled={busy || unanalyzed === 0} onClick={() => void startAnalysis()}>
            {busy ? "Working…" : "Analyze unanalyzed"}
          </button>
        </div>
      </section>

      <h2>Assets ({assets.length})</h2>
      {assets.length === 0 ? (
        <p className="muted">Nothing ingested yet.</p>
      ) : (
        assets.map((a) => (
          <section className="keycard" key={a.id}>
            <h2>
              {a.title}
              <span className={`status ${a.analyzed_at ? "set" : "unset"}`}>
                {a.analyzed_at ? "analyzed" : "new"}
              </span>
            </h2>
            <p className="muted">
              {a.source} · {a.chars} chars
              {a.source_url ? (
                <>
                  {" · "}
                  <a href={a.source_url} target="_blank" rel="noreferrer">
                    source
                  </a>
                </>
              ) : null}
            </p>
          </section>
        ))
      )}
    </>
  );
}
