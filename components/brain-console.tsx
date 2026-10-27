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
const TYPES = [
  { id: "", label: "All" },
  { id: "principle", label: "Principles" },
  { id: "qa", label: "Q&A" },
  { id: "quote", label: "Quotes" },
  { id: "voice", label: "Voice" },
  { id: "pillar", label: "Pillars" },
  { id: "metric", label: "Metrics" },
];

export default function BrainConsole(): React.ReactNode {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [docs, setDocs] = useState<VaultDoc[]>([]);
  const [query, setQuery] = useState("");
  const [type, setType] = useState("");
  const [error, setError] = useState("");
  const [editingVoice, setEditingVoice] = useState(false);
  const [voiceBody, setVoiceBody] = useState("");
  const [editingDoc, setEditingDoc] = useState<{ id: string; title: string; body: string } | null>(null);

  const loadOverview = useCallback(async () => {
    try {
      const res = await fetch("/api/brain");
      setOverview((await res.json()) as Overview);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  const loadVault = useCallback(async () => {
    setError("");
    const params = new URLSearchParams();
    if (query.trim()) params.set("q", query.trim());
    if (type) params.set("type", type);
    params.set("limit", "100");
    const res = await fetch(`/api/brain/vault?${params.toString()}`);
    if (!res.ok) {
      setError("vault load failed");
      return;
    }
    setDocs(((await res.json()) as { docs: VaultDoc[] }).docs);
  }, [query, type]);

  useEffect(() => {
    void loadOverview();
  }, [loadOverview]);

  useEffect(() => {
    void loadVault();
  }, [loadVault]);

  async function saveVoice(): Promise<void> {
    if (!overview?.voice) return;
    setError("");
    const res = await fetch("/api/brain/vault", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: overview.voice.id, docBody: voiceBody }),
    });
    if (!res.ok) {
      setError("voice save failed");
      return;
    }
    setEditingVoice(false);
    await loadOverview();
    await loadVault();
  }

  async function saveDoc(): Promise<void> {
    if (!editingDoc) return;
    setError("");
    const res = await fetch("/api/brain/vault", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: editingDoc.id,
        title: editingDoc.title || null,
        docBody: editingDoc.body,
      }),
    });
    if (!res.ok) {
      setError("doc save failed");
      return;
    }
    setEditingDoc(null);
    await loadOverview();
    await loadVault();
  }

  async function removeDoc(id: string): Promise<void> {
    if (!window.confirm("Delete this vault entry?")) return;
    const res = await fetch(`/api/brain/vault?id=${encodeURIComponent(id)}`, { method: "DELETE" });
    if (!res.ok) {
      setError("doc delete failed");
      return;
    }
    await loadOverview();
    await loadVault();
  }

  if (!overview) return <p className="muted">Loading brain…</p>;

  return (
    <div>
      {error !== "" && <p className="note err">{error}</p>}
      <h2>Voice profile</h2>
      {overview.voice ? (
        editingVoice ? (
          <>
            <textarea
              rows={8}
              value={voiceBody}
              onChange={(e) => setVoiceBody(e.target.value)}
            />
            <div className="row">
              <button className="primary" onClick={() => void saveVoice()}>
                Save
              </button>
              <button onClick={() => setEditingVoice(false)}>Cancel</button>
            </div>
          </>
        ) : (
          <>
            <p style={{ whiteSpace: "pre-wrap" }}>{overview.voice.body}</p>
            <div className="row">
              <button
                onClick={() => {
                  setVoiceBody(overview.voice?.body ?? "");
                  setEditingVoice(true);
                }}
              >
                Edit
              </button>
            </div>
          </>
        )
      ) : (
        <p className="muted">No voice profile yet — run ingest in Settings.</p>
      )}
      <h2>Vault</h2>
      <div className="vtab">
        {TYPES.map((t) => (
          <button
            key={t.id}
            className={type === t.id ? "on" : ""}
            onClick={() => setType(t.id)}
          >
            {t.label}
            {t.id === "" ? "" : ` (${overview.counts[t.id] ?? 0})`}
          </button>
        ))}
      </div>
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
        <button onClick={() => void loadVault()}>Search</button>
      </div>
      {docs.length === 0 ? (
        <p className="muted">No vault docs match.</p>
      ) : (
        <table className="vtable">
          <thead>
            <tr>
              <th>Type</th>
              <th>Entry</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {docs.map((d) =>
              editingDoc?.id === d.id ? (
                <tr key={d.id}>
                  <td className="nowrap muted">{d.doc_type}</td>
                  <td>
                    <div className="row" style={{ marginTop: 0 }}>
                      <input
                        type="text"
                        aria-label="Title"
                        placeholder="Title (optional)"
                        value={editingDoc.title}
                        onChange={(e) =>
                          setEditingDoc({ ...editingDoc, title: e.target.value })
                        }
                      />
                    </div>
                    <div className="row">
                      <textarea
                        aria-label="Body"
                        rows={4}
                        value={editingDoc.body}
                        onChange={(e) =>
                          setEditingDoc({ ...editingDoc, body: e.target.value })
                        }
                      />
                    </div>
                    <div className="row">
                      <button className="primary" onClick={() => void saveDoc()}>
                        Save
                      </button>
                      <button onClick={() => setEditingDoc(null)}>Cancel</button>
                    </div>
                  </td>
                  <td></td>
                </tr>
              ) : (
                <tr key={d.id}>
                  <td className="nowrap muted">{d.doc_type}</td>
                  <td className="body">
                    {d.title ? <strong>{d.title} — </strong> : null}
                    {d.body}
                  </td>
                  <td className="nowrap">
                    <button
                      onClick={() =>
                        setEditingDoc({ id: d.id, title: d.title ?? "", body: d.body })
                      }
                    >
                      Edit
                    </button>{" "}
                    <button onClick={() => void removeDoc(d.id)}>Delete</button>
                  </td>
                </tr>
              ),
            )}
          </tbody>
        </table>
      )}
      <h2>Posting strategy</h2>
      {overview.strategy.length === 0 && (
        <p className="muted">
          No cadence yet — open <a href="/queue">calendar</a> → Queue setup.
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
