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

type Account = { id: string; platform: string; username: string };

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
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [accountsOn, setAccountsOn] = useState<Record<string, boolean>>({});
  const [accountsNote, setAccountsNote] = useState<string | null>(null);
  const [handles, setHandles] = useState<Record<string, string>>({});
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [windowId, setWindowId] = useState("30");
  const [urlSource, setUrlSource] = useState(URL_SOURCES[0].id);
  const [urlValue, setUrlValue] = useState("");
  const [unanalyzed, setUnanalyzed] = useState(0);
  const [phase, setPhase] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refreshCounts = useCallback(async () => {
    try {
      const data = await readJson(await fetch("/api/assets?limit=500"));
      const assets = data.assets as { analyzed_at: string | null }[];
      setUnanalyzed(assets.filter((a) => !a.analyzed_at).length);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    setHandles(loadHandles());
    void refreshCounts();
    fetch("/api/zernio/accounts")
      .then(async (res) => {
        const data = (await res.json()) as { accounts?: Account[]; error?: string };
        if (!res.ok) {
          setAccountsNote(data.error ?? "Zernio unavailable");
          return;
        }
        const list = data.accounts ?? [];
        setAccounts(list);
        const on: Record<string, boolean> = {};
        for (const a of list) on[a.id] = true;
        setAccountsOn(on);
        if (list.length === 0) setAccountsNote("No connected Zernio accounts found.");
      })
      .catch((e) => setAccountsNote((e as Error).message));
  }, [refreshCounts]);

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
    const zTargets = accounts.filter((a) => accountsOn[a.id]);
    const mTargets = PLATFORMS.filter((p) => checked[p.id] && (handles[p.id] ?? "").trim());
    if (zTargets.length === 0 && mTargets.length === 0) {
      setError("check at least one Zernio account or manual handle");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      let total = 0;
      if (zTargets.length > 0) {
        setPhase(`${label}: Zernio (${zTargets.length} accounts)…`);
        const started = await readJson(
          await fetch("/api/ingest/zernio", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ accountIds: zTargets.map((a) => a.id), since }),
          }),
        );
        const done = await pollJob(started.jobId as string);
        if (done.state === "failed") throw new Error((done.failedReason as string) ?? "ingest failed");
        total += ((done.result ?? {}) as { assets?: number }).assets ?? 0;
      }
      for (const t of mTargets) {
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
      await refreshCounts();
    } catch (e) {
      setError((e as Error).message);
      setPhase(null);
    } finally {
      setBusy(false);
    }
  }

  async function ingestAndAnalyze(): Promise<void> {
    const days = windowId === "all" ? null : Number(windowId);
    const since = days === null ? undefined : new Date(Date.now() - days * 86400000).toISOString();
    await runBatch(since, "Ingesting");
  }

  async function refreshUpToNow(): Promise<void> {
    let since: string | undefined;
    try {
      const data = await readJson(await fetch("/api/assets?limit=1"));
      const assets = data.assets as { posted_at: string | null; created_at: string }[];
      since = assets[0]?.posted_at ?? assets[0]?.created_at;
    } catch {
      /* fall through to default window */
    }
    await runBatch(since ?? new Date(Date.now() - 7 * 86400000).toISOString(), "Refreshing");
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
      await refreshCounts();
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
      await refreshCounts();
    } catch (e) {
      setError((e as Error).message);
      setPhase(null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <section className="keycard">
        <h2>Connected accounts (Zernio, auto-detected)</h2>
        {accountsNote ? <p className="muted">{accountsNote}</p> : null}
        {accounts.map((a) => (
          <div className="checkline" key={a.id}>
            <input
              type="checkbox"
              aria-label={`Include ${a.platform} ${a.username}`}
              checked={accountsOn[a.id] ?? false}
              onChange={(e) => setAccountsOn((c) => ({ ...c, [a.id]: e.target.checked }))}
            />
            <label>
              {a.platform} · {a.username}
            </label>
          </div>
        ))}
        <h2>Manual handles (Monid)</h2>
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
    </>
  );
}
