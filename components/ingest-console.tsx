"use client";

import { useCallback, useEffect, useState } from "react";
import DateField from "./date-field";

const PLATFORMS = [
  { id: "x_posts", label: "X", source: "x_posts" },
  { id: "tiktok_videos", label: "TikTok", source: "tiktok_videos" },
  { id: "instagram_posts", label: "Instagram", source: "instagram_posts" },
];

const URL_SOURCES = [
  { id: "youtube_transcript", label: "YouTube transcript by URL" },
  { id: "instagram_reel", label: "Instagram reel transcript by URL" },
];

const HANDLE_KEY = "creagent.ingest.handles";
const RANGE_KEY = "creagent.ingest.range";

type Account = { id: string; platform: string; username: string };
type Range = { from: string; to: string };
type Target =
  | { kind: "zernio"; key: string; label: string; accountId: string }
  | { kind: "monid"; key: string; label: string; source: string; handle: string };
type TargetState = {
  key: string;
  label: string;
  state: "pending" | "running" | "done" | "failed";
  assets: number;
  attempts: number;
  error: string | null;
  rateLimited: boolean;
};

async function readJson(res: Response): Promise<Record<string, unknown>> {
  const data = (await res.json()) as Record<string, unknown>;
  if (!res.ok) throw new Error((data.error as string) ?? `HTTP ${res.status}`);
  return data;
}

function loadJson(key: string): Record<string, string> {
  try {
    return (JSON.parse(window.localStorage.getItem(key) ?? "{}") as Record<string, string>) ?? {};
  } catch {
    return {};
  }
}

function loadRange(): Range {
  try {
    const raw = JSON.parse(window.localStorage.getItem(RANGE_KEY) ?? "{}") as Partial<Range>;
    return { from: raw.from ?? "", to: raw.to ?? "" };
  } catch {
    return { from: "", to: "" };
  }
}

function rateLimited(message: string): boolean {
  return /http 429|rate.?limit|too many requests/i.test(message);
}

export default function IngestConsole(): React.ReactNode {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [accountsOn, setAccountsOn] = useState<Record<string, boolean>>({});
  const [accountsNote, setAccountsNote] = useState<string | null>(null);
  const [handles, setHandles] = useState<Record<string, string>>({});
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [range, setRange] = useState<Range>({ from: "", to: "" });
  const [depth, setDepth] = useState<"quick" | "deep" | "full">("deep");
  const [urlSource, setUrlSource] = useState(URL_SOURCES[0].id);
  const [urlValue, setUrlValue] = useState("");
  const [unanalyzed, setUnanalyzed] = useState(0);
  const [phase, setPhase] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [targets, setTargets] = useState<TargetState[]>([]);
  const [progress, setProgress] = useState<{ done: number; total: number; current: string } | null>(null);
  const [estimate, setEstimate] = useState<{ total: number; lo: number; hi: number } | null>(null);
  const [tBusy, setTBusy] = useState(false);
  const [tBatch, setTBatch] = useState(100);
  const [tProgress, setTProgress] = useState<{ done: number; total: number; spent: number } | null>(null);
  const [tPhase, setTPhase] = useState<string | null>(null);

  const refreshCounts = useCallback(async () => {
    try {
      const data = await readJson(await fetch("/api/assets?limit=500"));
      const assets = data.assets as { analyzed_at: string | null }[];
      setUnanalyzed(assets.filter((a) => !a.analyzed_at).length);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  const refreshEstimate = useCallback(async () => {
    try {
      const data = await readJson(await fetch("/api/transcripts/estimate"));
      setEstimate({
        total: data.total as number,
        lo: data.lo as number,
        hi: data.hi as number,
      });
    } catch {
      /* estimate unavailable */
    }
  }, []);

  useEffect(() => {
    setHandles(loadJson(HANDLE_KEY));
    setRange(loadRange());
    void refreshCounts();
    void refreshEstimate();
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
  }, [refreshCounts, refreshEstimate]);

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

  function updateRange(patch: Partial<Range>): void {
    setRange((r) => {
      const next = { ...r, ...patch };
      try {
        window.localStorage.setItem(RANGE_KEY, JSON.stringify(next));
      } catch {
        /* private mode */
      }
      return next;
    });
  }

  function selectedTargets(): Target[] {
    const out: Target[] = [];
    for (const a of accounts) {
      if (accountsOn[a.id]) {
        out.push({ kind: "zernio", key: `z:${a.id}`, label: `${a.platform} · ${a.username}`, accountId: a.id });
      }
    }
    for (const p of PLATFORMS) {
      const handle = (handles[p.id] ?? "").replace(/^@/, "").trim();
      if (checked[p.id] && handle) {
        out.push({ kind: "monid", key: `m:${p.id}`, label: `${p.label} @${handle}`, source: p.source, handle });
      }
    }
    return out;
  }

  const rangeWindow = useCallback((): { since?: string; until?: string } => {
    const since = range.from ? new Date(range.from).toISOString() : undefined;
    const until = range.to ? new Date(`${range.to}T23:59:59`).toISOString() : undefined;
    return { since, until };
  }, [range]);

  async function runTarget(t: Target, label: string): Promise<TargetState> {
    const st: TargetState = {
      key: t.key,
      label: t.label,
      state: "running",
      assets: 0,
      attempts: 0,
      error: null,
      rateLimited: false,
    };
    setTargets((ts) => ts.map((x) => (x.key === t.key ? st : x)));
    try {
      const { since, until } = rangeWindow();
      const started = await readJson(
        await fetch(t.kind === "zernio" ? "/api/ingest/zernio" : "/api/ingest", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(
            t.kind === "zernio"
              ? { accountIds: [(t as { accountId: string }).accountId], since, until }
              : {
                  source: (t as { source: string }).source,
                  value: (t as { handle: string }).handle,
                  since,
                  until,
                  maxPages: depth === "full" ? 0 : depth === "deep" ? 20 : 5,
                },
          ),
        }),
      );
      const jobId = started.jobId as string;
      for (;;) {
        const data = await readJson(await fetch(`/api/jobs/${jobId}`));
        const prog = (data.progress ?? {}) as { assets?: number; pages?: number };
        st.attempts = typeof data.attempts === "number" ? data.attempts : 0;
        if (typeof prog.assets === "number") st.assets = prog.assets;
        if (typeof prog.pages === "number" && prog.pages > 0) {
          st.label = `${t.label} · p${prog.pages}`;
        }
        setTargets((ts) => ts.map((x) => (x.key === t.key ? { ...st } : x)));
        if (data.state === "completed" || data.state === "failed") {
          if (data.state === "failed") throw new Error((data.failedReason as string) ?? `${label} failed`);
          const res = (data.result ?? {}) as { assets?: number; duplicates?: number; pages?: number; resumed?: boolean };
          if (typeof res.assets === "number") st.assets = res.assets;
          st.state = "done";
          st.label = `${t.label}${typeof res.pages === "number" ? ` · ${res.pages}p` : ""}${res.resumed ? " · resumed" : ""}`;
          break;
        }
        await new Promise((r) => setTimeout(r, 2000));
      }
    } catch (e) {
      st.state = "failed";
      st.error = (e as Error).message;
      st.rateLimited = rateLimited(st.error);
    }
    setTargets((ts) => ts.map((x) => (x.key === t.key ? { ...st } : x)));
    return st;
  }

  async function runBatch(batch: Target[], label: string): Promise<void> {
    if (batch.length === 0) {
      setError("select at least one Zernio account or manual handle");
      return;
    }
    setBusy(true);
    setError(null);
    setTargets(
      batch.map((t) => ({
        key: t.key,
        label: t.label,
        state: "pending" as const,
        assets: 0,
        attempts: 0,
        error: null,
        rateLimited: false,
      })),
    );
    setProgress({ done: 0, total: batch.length, current: "" });
    try {
      let total = 0;
      let failed = 0;
      for (const t of batch) {
        setProgress((p) => (p ? { ...p, current: `${label}: ${t.label}…` } : p));
        const st = await runTarget(t, label);
        total += st.assets;
        if (st.state === "failed") failed++;
        setProgress((p) => (p ? { ...p, done: p.done + 1, current: "" } : p));
      }
      if (total > 0) {
        setPhase("Analyzing new assets…");
        const started = await readJson(
          await fetch("/api/analysis/run", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({}),
          }),
        );
        for (;;) {
          const done = await readJson(await fetch(`/api/jobs/${started.jobId as string}`));
          if (done.state === "completed" || done.state === "failed") {
            if (done.state === "failed") throw new Error((done.failedReason as string) ?? "analysis failed");
            break;
          }
          await new Promise((r) => setTimeout(r, 2000));
        }
      }
      setPhase(
        failed === 0
          ? `Done: ${total} new asset${total === 1 ? "" : "s"} ingested${total > 0 ? " and analyzed" : ""}.`
          : `Finished with ${failed} failed target${failed === 1 ? "" : "s"} — fix and retry below.`,
      );
      await refreshCounts();
    } catch (e) {
      setError((e as Error).message);
      setPhase(null);
    } finally {
      setBusy(false);
      setProgress((p) => (p ? { ...p, current: "" } : p));
    }
  }

  async function ingestAndAnalyze(): Promise<void> {
    await runBatch(selectedTargets(), "Ingesting");
  }

  async function retryFailed(): Promise<void> {
    const failedKeys = new Set(targets.filter((t) => t.state === "failed").map((t) => t.key));
    if (failedKeys.size === 0) return;
    await runBatch(selectedTargets().filter((t) => failedKeys.has(t.key)), "Retrying");
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
      for (;;) {
        const done = await readJson(await fetch(`/api/jobs/${started.jobId as string}`));
        if (done.state === "completed" || done.state === "failed") {
          if (done.state === "failed") throw new Error((done.failedReason as string) ?? "ingest failed");
          break;
        }
        await new Promise((r) => setTimeout(r, 2000));
      }
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

  async function runTranscripts(): Promise<void> {
    setTBusy(true);
    setTPhase(null);
    setTProgress({ done: 0, total: estimate?.total ?? 0, spent: 0 });
    try {
      const started = await readJson(
        await fetch("/api/transcripts/run", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ batch: tBatch }),
        }),
      );
      for (;;) {
        const data = await readJson(await fetch(`/api/jobs/${started.jobId as string}`));
        const prog = (data.progress ?? {}) as { done?: number; total?: number; spent?: number };
        setTProgress((p) => ({
          done: typeof prog.done === "number" ? prog.done : p?.done ?? 0,
          total: typeof prog.total === "number" && prog.total > 0 ? prog.total : p?.total ?? 0,
          spent: typeof prog.spent === "number" ? prog.spent : p?.spent ?? 0,
        }));
        if (data.state === "completed" || data.state === "failed") {
          if (data.state === "failed") throw new Error((data.failedReason as string) ?? "transcribe failed");
          const res = (data.result ?? {}) as {
            done?: number;
            failed?: number;
            skipped?: number;
            spent?: number;
            remaining?: number;
            failures?: { asset: string; error: string }[];
          };
          setTPhase(
            `Transcribed ${res.done ?? 0}${res.skipped ? `, skipped ${res.skipped} (unavailable)` : ""} — $${(res.spent ?? 0).toFixed(2)} spent, ${res.remaining ?? 0} remaining.` +
              (res.failed
                ? ` ${res.failed} failed (${res.failures?.[0]?.error ?? "unknown"}) — re-run to retry.`
                : ""),
          );
          break;
        }
        await new Promise((r) => setTimeout(r, 2000));
      }
      await refreshEstimate();
    } catch (e) {
      setTPhase(`Failed: ${(e as Error).message}`);
    } finally {
      setTBusy(false);
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
      for (;;) {
        const done = await readJson(await fetch(`/api/jobs/${started.jobId as string}`));
        if (done.state === "completed" || done.state === "failed") {
          if (done.state === "failed") throw new Error((done.failedReason as string) ?? "analysis failed");
          break;
        }
        await new Promise((r) => setTimeout(r, 2000));
      }
      setPhase("Analysis complete.");
      await refreshCounts();
    } catch (e) {
      setError((e as Error).message);
      setPhase(null);
    } finally {
      setBusy(false);
    }
  }

  const failedCount = targets.filter((t) => t.state === "failed").length;
  const pct = progress && progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;

  return (
    <>
      <section className="keycard">
        <h2>Connected accounts (Zernio, auto-detected)</h2>
        <p className="muted">
          Your connected accounts: posts plus engagement, free. Best for recent history and
          analytics — Zernio returns the 25 most recent posts per account. For older history,
          add a Monid deep pull; duplicates across the two are merged into one entry.
        </p>
        {accountsNote ? <p className="muted">{accountsNote}</p> : null}
        <div className="ppills">
          {accounts.map((a) => (
            <button
              key={a.id}
              className={accountsOn[a.id] ? "on" : ""}
              title={`${a.platform} · ${a.username}`}
              onClick={() => setAccountsOn((c) => ({ ...c, [a.id]: !c[a.id] }))}
            >
              {a.platform} · {a.username}
            </button>
          ))}
        </div>
        <h2>Manual handles (Monid)</h2>
        <p className="muted">
          Public scraping by handle: transcripts and captions without connecting anything.
          Costs credits per run. Use it for accounts you cannot connect.
        </p>
        <div className="ppills">
          {PLATFORMS.map((p) => (
            <button
              key={p.id}
              className={checked[p.id] ? "on" : ""}
              onClick={() => setChecked((c) => ({ ...c, [p.id]: !c[p.id] }))}
            >
              {p.label}
            </button>
          ))}
        </div>
        {PLATFORMS.filter((p) => checked[p.id]).map((p) => (
          <div className="target-row" key={p.id}>
            <input
              type="text"
              spellCheck={false}
              aria-label={`${p.label} handle`}
              placeholder={`${p.label} username (no @)`}
              value={handles[p.id] ?? ""}
              onChange={(e) => setHandle(p.id, e.target.value)}
            />
          </div>
        ))}
        <div className="target-row">
          <span className="muted">Date range</span>
          <span className="range-inline">
            <DateField
              label="From date"
              placeholder="From"
              value={range.from}
              onChange={(from) => updateRange({ from })}
            />
            <span className="range-arrow" aria-hidden="true">→</span>
            <DateField
              label="To date"
              placeholder="To"
              value={range.to}
              onChange={(to) => updateRange({ to })}
            />
          </span>
          <span className="muted">Blank = all time.</span>
        </div>
        <div className="row">
          <span className="muted">Monid depth</span>
          <div className="seg">
            <button className={depth === "quick" ? "on" : ""} onClick={() => setDepth("quick")} title="5 pages, fastest">
              Quick
            </button>
            <button className={depth === "deep" ? "on" : ""} onClick={() => setDepth("deep")} title="20 pages">
              Deep
            </button>
            <button className={depth === "full" ? "on" : ""} onClick={() => setDepth("full")} title="Every page to exhaustion, ~$0.002/page. Resumes where it stopped.">
              Full history
            </button>
          </div>
          <span className="muted">Full history walks every page (~$0.002/page) and resumes where it stopped.</span>
        </div>
        <div className="row">
          <button className="primary" disabled={busy} onClick={() => void ingestAndAnalyze()}>
            {busy ? "Working…" : "Ingest & analyze"}
          </button>
          <button disabled={busy || failedCount === 0} onClick={() => void retryFailed()}>
            Retry failed ({failedCount})
          </button>
          <button disabled={busy || unanalyzed === 0} onClick={() => void analyzeOnly()}>
            Analyze unanalyzed ({unanalyzed})
          </button>
        </div>
        {progress && (
          <div className="progress-wrap">
            <div className="progress-bar">
              <div className="progress-fill" style={{ width: `${pct}%` }} />
            </div>
            <p className="muted">
              {progress.done}/{progress.total} targets{progress.current ? ` · ${progress.current}` : ""}
            </p>
          </div>
        )}
        {targets.length > 0 && (
          <div className="target-results">
            {targets.map((t) => (
              <div key={t.key} className={`target-result ${t.state}`}>
                <span className="t-dot" aria-hidden="true" />
                <span className="t-label">{t.label}</span>
                <span className="muted">
                  {t.state === "done" && (t.assets > 0 ? `${t.assets} new` : "0 new — source returned nothing")}
                  {t.state === "running" && `${t.assets} so far${t.attempts > 0 ? ` · retry ${t.attempts}` : ""}`}
                  {t.state === "pending" && "waiting"}
                  {t.state === "failed" && (t.rateLimited ? "rate limited — retry" : t.error)}
                </span>
              </div>
            ))}
          </div>
        )}
        {phase ? <p className="note ok">{phase}</p> : null}
        {error ? <p className="note err">{error}</p> : null}
      </section>

      <section className="keycard">
        <h2>Video speech transcripts</h2>
        <p className="muted">
          Post listings carry captions; this backfills what&apos;s actually said, per video, via
          Monid (~$0.002–$0.02 per video depending on length). Progress saves after every video —
          re-run anytime to resume.
        </p>
        <div className="row">
          <span className="muted">
            {estimate
              ? `${estimate.total} videos missing transcripts · est. $${estimate.lo.toFixed(2)}–$${estimate.hi.toFixed(2)}`
              : "Counting videos…"}
          </span>
          <select
            value={tBatch}
            onChange={(e) => setTBatch(Number(e.target.value))}
            aria-label="Transcripts per run"
          >
            {[25, 100, 250, 500].map((n) => (
              <option key={n} value={n}>
                {n} per run
              </option>
            ))}
          </select>
          <button disabled={tBusy || !estimate || estimate.total === 0} onClick={() => void runTranscripts()}>
            {tBusy ? "Transcribing…" : "Backfill transcripts"}
          </button>
        </div>
        {tProgress && (
          <div className="progress-wrap">
            <div className="progress-bar">
              <div
                className="progress-fill"
                style={{ width: tProgress.total > 0 ? `${Math.round((tProgress.done / tProgress.total) * 100)}%` : "0%" }}
              />
            </div>
            <p className="muted">
              {tProgress.done}/{tProgress.total} · ${tProgress.spent.toFixed(2)} spent
            </p>
          </div>
        )}
        {tPhase ? <p className="note ok">{tPhase}</p> : null}
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
