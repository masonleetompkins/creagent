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
  guides: { platform: string; label: string; guide: string }[];
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

// Minimal markdown renderer for the voice profile (headings, lists,
// paragraphs, bold, code). React escapes text nodes, so raw HTML in the
// body can never execute.
function renderInline(text: string, keyPrefix: string): React.ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((part, i) => {
    const key = `${keyPrefix}-${i}`;
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) {
      return <strong key={key}>{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith("`") && part.endsWith("`") && part.length > 2) {
      return <code key={key}>{part.slice(1, -1)}</code>;
    }
    return part;
  });
}

export function VoiceMarkdown({ body }: { body: string }): React.ReactNode {
  const blocks: React.ReactNode[] = [];
  let para: string[] = [];
  let list: string[] = [];
  const flushPara = (): void => {
    const text = para.join(" ").trim();
    para = [];
    if (text) {
      const key = `p-${blocks.length}`;
      blocks.push(<p key={key}>{renderInline(text, key)}</p>);
    }
  };
  const flushList = (): void => {
    if (list.length === 0) return;
    const items = list;
    list = [];
    const key = `ul-${blocks.length}`;
    blocks.push(
      <ul key={key}>
        {items.map((item, i) => (
          <li key={i}>{renderInline(item, `${key}-${i}`)}</li>
        ))}
      </ul>,
    );
  };
  let seenContent = false;
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (!line) {
      flushPara();
      flushList();
      continue;
    }
    if (!seenContent) {
      seenContent = true;
      // The doc's own title duplicates the section header — drop it.
      if (/^# Voice profile\s*$/i.test(line)) continue;
    }
    const hm = line.match(/^(#{1,3})\s+(.*)$/);
    const li = line.match(/^[-*]\s+(.*)$/);
    if (hm) {
      flushPara();
      flushList();
      const key = `h-${blocks.length}`;
      const Tag = hm[1].length >= 3 ? "h4" : "h3";
      blocks.push(<Tag key={key}>{renderInline(hm[2], key)}</Tag>);
    } else if (li) {
      flushPara();
      list.push(li[1]);
    } else {
      flushList();
      para.push(line);
    }
  }
  flushPara();
  flushList();
  return <div className="voice-md">{blocks}</div>;
}

export default function BrainConsole({ pillars }: { pillars?: React.ReactNode }): React.ReactNode {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [docs, setDocs] = useState<VaultDoc[]>([]);
  const [query, setQuery] = useState("");
  const [type, setType] = useState("");
  const [error, setError] = useState("");
  const [editingVoice, setEditingVoice] = useState(false);
  const [voiceBody, setVoiceBody] = useState("");
  const [editingDoc, setEditingDoc] = useState<{ id: string; title: string; body: string } | null>(null);
  const [regen, setRegen] = useState<{ done: number; total: number; stage: string } | null>(null);
  const [regenBusy, setRegenBusy] = useState(false);
  const [regenNote, setRegenNote] = useState<string | null>(null);
  const [regenCount, setRegenCount] = useState(0);

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

  async function regenerate(): Promise<void> {
    if (
      !window.confirm(
        "Rebuild the whole brain from your posts? This replaces the voice profile and vault entries and refreshes pillar suggestions. Confirmed pillars and your queue are kept.",
      )
    ) {
      return;
    }
    setError("");
    setRegenNote(null);
    setRegenBusy(true);
    setRegen({ done: 0, total: 0, stage: "Starting…" });
    try {
      const started = (await (await fetch("/api/brain/regenerate", { method: "POST" })).json()) as {
        jobId?: string;
        error?: string;
      };
      if (!started.jobId) throw new Error(started.error ?? "regenerate failed to start");
      for (;;) {
        const data = (await (await fetch(`/api/jobs/${started.jobId}`)).json()) as {
          state?: string;
          failedReason?: string;
          progress?: { done?: number; total?: number; stage?: string };
          result?: {
            analyzed?: number;
            batches?: number;
            merged?: number;
            canonical?: number;
            confirmed?: string[];
            degraded?: string;
          };
        };
        const prog = data.progress ?? {};
        setRegen((r) => ({
          done: typeof prog.done === "number" ? prog.done : r?.done ?? 0,
          total: typeof prog.total === "number" ? prog.total : r?.total ?? 0,
          stage: typeof prog.stage === "string" && prog.stage ? prog.stage : r?.stage ?? "Working…",
        }));
        if (data.state === "completed" || data.state === "failed") {
          if (data.state === "failed") throw new Error(data.failedReason ?? "regenerate failed");
          const res = data.result ?? {};
          setRegenNote(
            `Brain rebuilt: ${res.analyzed ?? 0} assets in ${res.batches ?? 0} batches.` +
              (typeof res.merged === "number" && typeof res.canonical === "number"
                ? ` ${res.merged} pillars merged into ${res.canonical}.`
                : "") +
              (res.confirmed && res.confirmed.length > 0
                ? ` Top ${res.confirmed.length} auto-confirmed: ${res.confirmed.join(", ")}.`
                : "") +
              (typeof res.degraded === "string" && res.degraded
                ? ` Consolidation needs a retry: ${res.degraded} Use Consolidate below.`
                : ""),
          );
          break;
        }
        await new Promise((r) => setTimeout(r, 2000));
      }
      setRegenCount((n) => n + 1);
      await loadOverview();
      await loadVault();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRegenBusy(false);
      setRegen(null);
    }
  }

  async function consolidate(): Promise<void> {
    setError("");
    setRegenNote(null);
    setRegenBusy(true);
    setRegen({ done: 0, total: 0, stage: "Starting…" });
    try {
      const started = (await (await fetch("/api/brain/consolidate", { method: "POST" })).json()) as {
        jobId?: string;
        error?: string;
      };
      if (!started.jobId) throw new Error(started.error ?? "consolidate failed to start");
      for (;;) {
        const data = (await (await fetch(`/api/jobs/${started.jobId}`)).json()) as {
          state?: string;
          failedReason?: string;
          progress?: { stage?: string };
          result?: { merged?: number; canonical?: number; unmapped?: string[]; confirmed?: string[] };
        };
        const stage = data.progress?.stage;
        if (stage) setRegen((r) => ({ done: 0, total: 0, stage }));
        if (data.state === "completed" || data.state === "failed") {
          if (data.state === "failed") throw new Error(data.failedReason ?? "consolidate failed");
          const res = data.result ?? {};
          setRegenNote(
            `Consolidated: ${res.merged ?? 0} merged into ${res.canonical ?? 0} pillars.` +
              (res.unmapped && res.unmapped.length > 0
                ? ` ${res.unmapped.length} left untouched (${res.unmapped.slice(0, 3).join(", ")}${res.unmapped.length > 3 ? "…" : ""}).`
                : "") +
              (res.confirmed && res.confirmed.length > 0
                ? ` Top ${res.confirmed.length} auto-confirmed: ${res.confirmed.join(", ")}.`
                : ""),
          );
          break;
        }
        await new Promise((r) => setTimeout(r, 2000));
      }
      setRegenCount((n) => n + 1);
      await loadOverview();
      await loadVault();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRegenBusy(false);
      setRegen(null);
    }
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
      <section className="keycard slim">
        <div className="ingest-head" style={{ marginBottom: 4 }}>
          <h2>Rebuild brain</h2>
          <span className="muted">Voice, pillars, and vault regenerated from all posts</span>
          <span className="ingest-head-actions">
            <button
              disabled={regenBusy}
              title="Merge overlapping pillar suggestions into ~10 canonical pillars"
              onClick={() => void consolidate()}
            >
              {regenBusy ? "Working…" : "Consolidate pillars"}
            </button>
            <button disabled={regenBusy} onClick={() => void regenerate()}>
              {regenBusy ? "Rebuilding…" : "Regenerate"}
            </button>
          </span>
        </div>
        {regen && (
          <div className="progress-wrap slim">
            <div className="progress-bar">
              <div
                className="progress-fill"
                style={{
                  width:
                    regen.total > 0
                      ? `${Math.min(100, Math.round((regen.done / regen.total) * 100))}%`
                      : "0%",
                }}
              />
            </div>
            <p className="muted">
              {regen.stage}
              {regen.total > 0 ? ` · ${regen.done}/${regen.total}` : ""}
            </p>
          </div>
        )}
        {regenNote ? <p className="note ok">{regenNote}</p> : null}
      </section>
      <h2>Voice profile</h2>
      {overview.voice ? (
        editingVoice ? (
          <>
            <textarea
              rows={14}
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
            <VoiceMarkdown body={overview.voice.body} />
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
      <div key={regenCount}>{pillars}</div>
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
      <h2>Platform guides</h2>
      <p className="muted">Your platform knowledge: hook rules, formats, and ranked leading indicators. The agent drafts from these.</p>
      {(overview.guides ?? []).map((g) => (
        <div key={g.platform} className="keycard slim">
          <strong>{g.label}</strong>
          <p style={{ marginBottom: 0 }}>{g.guide}</p>
        </div>
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
