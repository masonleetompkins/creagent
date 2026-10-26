"use client";

import { useCallback, useEffect, useState } from "react";

type VaultDoc = {
  id: string;
  doc_type: string;
  title: string | null;
  body: string;
  created_at: string;
};

type Overview = {
  voice: VaultDoc | null;
  counts: Record<string, number>;
  strategy: {
    weekday: number;
    time: string;
    pillar_name: string | null;
    content_type: string;
    platforms: string;
  }[];
  playbook: { type: string; label: string; hint: string; guide: string }[];
};

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const TYPES = ["", "qa", "principle", "quote", "pillar", "metric", "voice"];

export default function BrainConsole(): React.ReactNode {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [docs, setDocs] = useState<VaultDoc[]>([]);
  const [query, setQuery] = useState("");
  const [type, setType] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    void fetch("/api/brain")
      .then((r) => r.json())
      .then((d) => setOverview(d as Overview))
      .catch((e) => setError((e as Error).message));
  }, []);

  const loadVault = useCallback(async () => {
    setError("");
    const params = new URLSearchParams();
    if (query.trim()) params.set("q", query.trim());
    if (type) params.set("type", type);
    const res = await fetch(`/api/brain/vault?${params.toString()}`);
    if (!res.ok) {
      setError("vault load failed");
      return;
    }
    setDocs(((await res.json()) as { docs: VaultDoc[] }).docs);
  }, [query, type]);

  useEffect(() => {
    void loadVault();
  }, [loadVault]);

  if (!overview) return <p className="muted">Loading brain…</p>;

  return (
    <div>
      {error !== "" && <p className="note err">{error}</p>}
      <h2>Voice profile</h2>
      {overview.voice ? (
        <p>{overview.voice.body}</p>
      ) : (
        <p className="muted">No voice profile yet — run Ingest then Analysis.</p>
      )}
      <h2>Vault</h2>
      <p className="muted">
        {Object.entries(overview.counts)
          .map(([k, v]) => `${k}: ${v}`)
          .join(" · ") || "empty"}
      </p>
      <div className="row">
        <input
          type="text"
          placeholder="Search the vault…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void loadVault();
          }}
        />
        <select value={type} onChange={(e) => setType(e.target.value)} aria-label="Doc type">
          {TYPES.map((t) => (
            <option key={t} value={t}>
              {t === "" ? "all types" : t}
            </option>
          ))}
        </select>
        <button onClick={() => void loadVault()}>Search</button>
      </div>
      {docs.map((d) => (
        <div key={d.id} className="keycard">
          <strong>
            [{d.doc_type}] {d.title ?? ""}
          </strong>
          <p>{d.body}</p>
        </div>
      ))}
      {docs.length === 0 && <p className="muted">No vault docs match.</p>}
      <h2>Posting strategy</h2>
      {overview.strategy.length === 0 && (
        <p className="muted">
          No cadence yet — add templates in the <a href="/queue">queue</a>.
        </p>
      )}
      {overview.strategy.map((t, i) => (
        <p key={i}>
          {DAYS[t.weekday]} {t.time} · {t.pillar_name ?? "no pillar"} · {t.content_type} ·{" "}
          {t.platforms}
        </p>
      ))}
      <h2>Platform playbook</h2>
      <p className="muted">The exact instructions the agent drafts from, per content type.</p>
      {overview.playbook.map((p) => (
        <div key={p.type} className="keycard">
          <strong>
            {p.label} <span className="muted">({p.hint})</span>
          </strong>
          <p>{p.guide}</p>
        </div>
      ))}
    </div>
  );
}
