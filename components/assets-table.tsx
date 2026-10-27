"use client";

import { useCallback, useEffect, useState } from "react";
import DateField from "./date-field";

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

const PAGE = 50;

export default function AssetsTable(): React.ReactNode {
  const [assets, setAssets] = useState<Asset[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [q, setQ] = useState("");
  const [showAll, setShowAll] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setError("");
    const params = new URLSearchParams();
    if (from) params.set("from", new Date(from).toISOString());
    if (to) params.set("to", new Date(`${to}T23:59:59`).toISOString());
    if (q.trim()) params.set("q", q.trim());
    params.set("limit", showAll ? "500" : String(PAGE));
    params.set("offset", showAll ? "0" : String(page * PAGE));
    const res = await fetch(`/api/assets?${params.toString()}`);
    if (!res.ok) {
      setError("assets load failed");
      return;
    }
    const data = (await res.json()) as { assets: Asset[]; total: number };
    setAssets(data.assets);
    setTotal(data.total);
  }, [from, to, q, page, showAll]);

  useEffect(() => {
    void load();
  }, [load]);

  function resetPage(): void {
    setPage(0);
  }

  const pages = Math.max(1, Math.ceil(total / PAGE));

  return (
    <section className="keycard">
      <h2>Assets ({total})</h2>
      {error !== "" && <p className="note err">{error}</p>}
      <div className="row">
        <input
          type="text"
          aria-label="Search phrase"
          placeholder="Search phrase…"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            resetPage();
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") void load();
          }}
        />
        <span className="range-inline">
          <DateField
            label="From date"
            placeholder="From"
            value={from}
            onChange={(v) => {
              setFrom(v);
              resetPage();
            }}
          />
          <span className="range-arrow" aria-hidden="true">→</span>
          <DateField
            label="To date"
            placeholder="To"
            value={to}
            onChange={(v) => {
              setTo(v);
              resetPage();
            }}
          />
        </span>
        <button onClick={() => void load()}>Search</button>
        <button
          className={showAll ? "primary" : ""}
          onClick={() => {
            setShowAll((s) => !s);
            resetPage();
          }}
        >
          {showAll ? "Paged" : "Show all"}
        </button>
      </div>
      {assets.length === 0 ? (
        <p className="muted">No assets match.</p>
      ) : (
        <table className="vtable">
          <thead>
            <tr>
              <th>Date</th>
              <th>Source</th>
              <th>Title</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {assets.map((a) => (
              <tr key={a.id}>
                <td className="nowrap muted">{(a.posted_at ?? a.created_at).slice(0, 10)}</td>
                <td className="nowrap">{a.source}</td>
                <td className="body">{a.title}</td>
                <td className="nowrap">
                  <span className={`status ${a.analyzed_at ? "set" : "unset"}`}>
                    {a.analyzed_at ? "analyzed" : "new"}
                  </span>
                </td>
                <td className="nowrap">
                  {a.source_url && !a.source_url.startsWith("zernio:") ? (
                    <a href={a.source_url} target="_blank" rel="noreferrer">
                      open
                    </a>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {!showAll && pages > 1 && (
        <div className="pager">
          <button disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
            ← Prev
          </button>
          <span className="muted">
            Page {page + 1} of {pages}
          </span>
          <button disabled={page + 1 >= pages} onClick={() => setPage((p) => p + 1)}>
            Next →
          </button>
        </div>
      )}
    </section>
  );
}
