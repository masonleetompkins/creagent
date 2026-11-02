"use client";

import { useCallback, useEffect, useState } from "react";

type Pillar = {
  id: string;
  name: string;
  description: string;
  voice_notes: string;
  confirmed: number;
  created_at: string;
  posts?: number;
  recent?: number;
  multiplier?: number | null;
  byPlatform?: Record<string, { posts: number; multiplier: number | null }>;
};

const PLATFORM_SHORT: Record<string, string> = {
  instagram: "ig",
  youtube: "yt",
  tiktok: "tt",
  threads: "th",
  x: "x",
  other: "other",
};

// Rank order, highest multiple first — mirrors autoConfirmTopPillars so the
// confirmed slots and the suggestion bench both read top-down.
export type Rankable = { name: string; multiplier?: number | null; posts?: number };

export function rankPillars<T extends Rankable>(list: T[]): T[] {
  return [...list].sort(
    (a, b) =>
      (b.multiplier ?? -1) - (a.multiplier ?? -1) ||
      (b.posts ?? 0) - (a.posts ?? 0) ||
      a.name.localeCompare(b.name),
  );
}

type Draft = { name: string; description: string; voiceNotes: string };

async function readJson(res: Response): Promise<Record<string, unknown>> {
  const data = (await res.json()) as Record<string, unknown>;
  if (!res.ok) throw new Error((data.error as string) ?? `HTTP ${res.status}`);
  return data;
}

export default function PillarsManager(): React.ReactNode {
  const [pillars, setPillars] = useState<Pillar[]>([]);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [newName, setNewName] = useState("");
  const [newDesc, setNewDesc] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const data = await readJson(await fetch("/api/pillars"));
      const list = data.pillars as Pillar[];
      setPillars(list);
      const next: Record<string, Draft> = {};
      for (const p of list) {
        next[p.id] = { name: p.name, description: p.description, voiceNotes: p.voice_notes ?? "" };
      }
      setDrafts(next);
      setLoaded(true);
    } catch (e) {
      setError((e as Error).message);
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function save(id: string): Promise<void> {
    setError(null);
    try {
      const d = drafts[id] ?? { name: "", description: "", voiceNotes: "" };
      const data = await readJson(
        await fetch(`/api/pillars/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: d.name,
            description: d.description,
            voice_notes: d.voiceNotes,
          }),
        }),
      );
      const saved = data.pillar as Pillar;
      setPillars((ps) => ps.map((p) => (p.id === id ? saved : p)));
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function setConfirmed(id: string, confirmed: boolean): Promise<void> {
    setError(null);
    try {
      const data = await readJson(
        await fetch(`/api/pillars/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ confirmed }),
        }),
      );
      const saved = data.pillar as Pillar;
      setPillars((ps) => ps.map((p) => (p.id === id ? saved : p)));
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function remove(id: string, name: string): Promise<void> {
    if (!window.confirm(`Delete pillar "${name}"? Queue slots keep their history but lose the link.`)) return;
    setError(null);
    try {
      await readJson(await fetch(`/api/pillars/${id}`, { method: "DELETE" }));
      setPillars((ps) => ps.filter((p) => p.id !== id));
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function add(): Promise<void> {
    setError(null);
    try {
      const data = await readJson(
        await fetch("/api/pillars", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: newName, description: newDesc }),
        }),
      );
      const created = data.pillar as Pillar;
      setPillars((ps) => [...ps, created]);
      setDrafts((d) => ({
        ...d,
        [created.id]: {
          name: created.name,
          description: created.description,
          voiceNotes: created.voice_notes ?? "",
        },
      }));
      setNewName("");
      setNewDesc("");
    } catch (e) {
      setError((e as Error).message);
    }
  }

  if (!loaded) return <p className="muted">Loading pillars…</p>;

  const confirmed = rankPillars(pillars.filter((p) => p.confirmed));
  const suggested = rankPillars(pillars.filter((p) => !p.confirmed));
  const emptySlots = Math.max(0, 5 - confirmed.length);

  const setDraft = (id: string, patch: Partial<Draft>): void => {
    setDrafts((d) => ({
      ...d,
      [id]: {
        name: d[id]?.name ?? "",
        description: d[id]?.description ?? "",
        voiceNotes: d[id]?.voiceNotes ?? "",
        ...patch,
      },
    }));
  };

  const cell = (p: Pillar): React.ReactNode => (
    <div className={`pillar-cell${p.confirmed ? " yes" : ""}`} key={p.id}>
      <input
        type="text"
        aria-label="Pillar name"
        className="pillar-name"
        value={drafts[p.id]?.name ?? ""}
        onChange={(e) => setDraft(p.id, { name: e.target.value })}
      />
      <textarea
        aria-label="Pillar description"
        rows={2}
        placeholder="What this pillar covers"
        value={drafts[p.id]?.description ?? ""}
        onChange={(e) => setDraft(p.id, { description: e.target.value })}
      />
      <textarea
        aria-label="Pillar voice notes"
        rows={2}
        placeholder="How your voice shifts for this pillar"
        value={drafts[p.id]?.voiceNotes ?? ""}
        onChange={(e) => setDraft(p.id, { voiceNotes: e.target.value })}
      />
      <div className="pillar-stats muted">
        {(p.posts ?? 0) > 0 || (p.recent ?? 0) > 0 ? (
          <span>
            {p.posts ?? 0} posts · {p.recent ?? 0} in 6mo
          </span>
        ) : (
          <span>no linked posts yet</span>
        )}
        {typeof p.multiplier === "number" && (
          <span
            className={`mult-badge${p.multiplier >= 1.5 ? " hot" : ""}`}
            title="Views-based average on this pillar's primary platform vs that platform's typical views"
          >
            {p.multiplier.toFixed(1)}x avg
          </span>
        )}
        {p.byPlatform &&
          Object.entries(p.byPlatform).filter(([, s]) => s.posts > 0).length > 1 && (
            <span className="platform-chips" title="Per-platform averages (replies excluded)">
              {Object.entries(p.byPlatform)
                .filter(([, s]) => s.posts > 0)
                .sort((a, b) => b[1].posts - a[1].posts)
                .map(([platform, s]) => (
                  <span key={platform} className="platform-chip">
                    {PLATFORM_SHORT[platform] ?? platform}{" "}
                    {typeof s.multiplier === "number" ? `${s.multiplier.toFixed(1)}x` : "—"}
                  </span>
                ))}
            </span>
          )}
      </div>
      <div className="pillar-btns">
        <button onClick={() => void save(p.id)} title="Save edits">
          Save
        </button>
        {p.confirmed ? (
          <button onClick={() => void setConfirmed(p.id, false)} title="Release this slot">
            Unconfirm
          </button>
        ) : (
          <button
            className="primary"
            disabled={confirmed.length >= 5}
            onClick={() => void setConfirmed(p.id, true)}
            title="Confirm into a pillar slot"
          >
            Confirm
          </button>
        )}
        <button onClick={() => void remove(p.id, p.name)} title="Delete pillar">
          ×
        </button>
      </div>
    </div>
  );

  return (
    <>
      {error ? <p className="note err">{error}</p> : null}
      <p className="muted">
        {confirmed.length} of 5 pillars confirmed. Confirmed pillars drive the queue planner.
      </p>
      <div className="pillar-grid">
        {confirmed.map(cell)}
        {Array.from({ length: emptySlots }).map((_, i) => (
          <div className="pillar-cell empty" key={`empty-${i}`}>
            <span className="muted">Empty slot — confirm a suggestion below.</span>
          </div>
        ))}
      </div>
      {suggested.length > 0 && (
        <>
          <h3 className="subhead">Suggestions from analysis</h3>
          <div className="pillar-grid">
            {suggested.map(cell)}
          </div>
        </>
      )}
      <section className="keycard slim">
        <div className="row">
          <input
            type="text"
            aria-label="New pillar name"
            placeholder="New pillar name"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
          />
          <input
            type="text"
            aria-label="New pillar description"
            placeholder="What this pillar covers"
            value={newDesc}
            onChange={(e) => setNewDesc(e.target.value)}
          />
          <button disabled={!newName.trim()} onClick={() => void add()}>
            Add
          </button>
        </div>
      </section>
    </>
  );
}
