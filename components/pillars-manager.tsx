"use client";

import { useCallback, useEffect, useState } from "react";

type Pillar = {
  id: string;
  name: string;
  description: string;
  confirmed: number;
  created_at: string;
};

async function readJson(res: Response): Promise<Record<string, unknown>> {
  const data = (await res.json()) as Record<string, unknown>;
  if (!res.ok) throw new Error((data.error as string) ?? `HTTP ${res.status}`);
  return data;
}

export default function PillarsManager(): React.ReactNode {
  const [pillars, setPillars] = useState<Pillar[]>([]);
  const [drafts, setDrafts] = useState<Record<string, { name: string; description: string }>>({});
  const [newName, setNewName] = useState("");
  const [newDesc, setNewDesc] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const data = await readJson(await fetch("/api/pillars"));
      const list = data.pillars as Pillar[];
      setPillars(list);
      const next: Record<string, { name: string; description: string }> = {};
      for (const p of list) next[p.id] = { name: p.name, description: p.description };
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
      const data = await readJson(
        await fetch(`/api/pillars/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(drafts[id]),
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
      setDrafts((d) => ({ ...d, [created.id]: { name: created.name, description: created.description } }));
      setNewName("");
      setNewDesc("");
    } catch (e) {
      setError((e as Error).message);
    }
  }

  if (!loaded) return <p className="muted">Loading pillars…</p>;

  const confirmedCount = pillars.filter((p) => p.confirmed).length;
  const ordered = [...pillars].sort((a, b) => b.confirmed - a.confirmed);

  return (
    <>
      {error ? <p className="note err">{error}</p> : null}
      <p className="muted">
        {confirmedCount} of 5 pillars confirmed. Confirmed pillars drive the queue planner.
      </p>
      {ordered.map((p) => (
        <section className="keycard" key={p.id}>
          <div>
            <strong>{p.name}</strong>
            <span className={`pill-conf${p.confirmed ? " yes" : ""}`}>
              {p.confirmed ? "confirmed" : "unconfirmed"}
            </span>
          </div>
          <div className="row">
            <input
              type="text"
              aria-label="Pillar name"
              value={drafts[p.id]?.name ?? ""}
              onChange={(e) =>
                setDrafts((d) => ({ ...d, [p.id]: { ...d[p.id], name: e.target.value } }))
              }
            />
          </div>
          <div className="row">
            <input
              type="text"
              aria-label="Pillar description"
              placeholder="What this pillar covers"
              value={drafts[p.id]?.description ?? ""}
              onChange={(e) =>
                setDrafts((d) => ({ ...d, [p.id]: { ...d[p.id], description: e.target.value } }))
              }
            />
          </div>
          <div className="row">
            <button className="primary" onClick={() => void save(p.id)}>
              Save
            </button>
            {p.confirmed ? (
              <button onClick={() => void setConfirmed(p.id, false)}>Unconfirm</button>
            ) : (
              <button disabled={confirmedCount >= 5} onClick={() => void setConfirmed(p.id, true)}>
                Confirm
              </button>
            )}
            <button onClick={() => void remove(p.id, p.name)}>Delete</button>
          </div>
        </section>
      ))}
      <section className="keycard">
        <h2>Add a pillar</h2>
        <div className="row">
          <input
            type="text"
            aria-label="New pillar name"
            placeholder="Name"
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
