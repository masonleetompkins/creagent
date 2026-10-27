"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import ReviewCards from "./review-cards";

type Chat = {
  id: string;
  title: string;
  created_at: string;
  position: number;
  prompt_tokens: number;
  completion_tokens: number;
  last_context_tokens: number;
  cost_usd: number;
  ctx_pct: number;
};
type Msg = {
  id: string;
  role: string;
  content: string;
  toolName: string | null;
  compacted: number;
  created_at: string;
};

function money(n: number): string {
  return n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
}

const PROMPTS = [
  "Draft this week's queue from my pillars",
  "What performed best last month, and why?",
  "Summarize my voice profile",
  "Plan a carousel about my latest video",
];

export default function ChatConsole(): React.ReactNode {
  const [chats, setChats] = useState<Chat[]>([]);
  const [chatId, setChatId] = useState<string | null>(null);
  const [draft, setDraft] = useState(true);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [compacting, setCompacting] = useState(false);
  const [error, setError] = useState("");
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameText, setRenameText] = useState("");
  const [dragId, setDragId] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const stopRef = useRef(false);
  const heroRef = useRef<HTMLTextAreaElement | null>(null);

  const loadChats = useCallback(async () => {
    const res = await fetch("/api/agent/chats");
    if (!res.ok) return;
    const list = ((await res.json()) as { chats: Chat[] }).chats;
    setChats(list);
    setChatId((cur) => {
      if (cur && list.some((c) => c.id === cur)) return cur;
      let stored: string | null = null;
      try {
        stored = localStorage.getItem("creagent.activeChat");
      } catch {
        /* ignore */
      }
      return stored && list.some((c) => c.id === stored) ? stored : (cur ?? null);
    });
  }, []);

  const loadMessages = useCallback(async (id: string) => {
    const res = await fetch(`/api/agent/chats/${id}`);
    if (res.ok) setMessages(((await res.json()) as { messages: Msg[] }).messages);
  }, []);

  useEffect(() => {
    void loadChats();
  }, [loadChats]);

  useEffect(() => {
    if (chatId) void loadMessages(chatId);
    else setMessages([]);
  }, [chatId, loadMessages]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [messages]);

  useEffect(() => {
    if (draft) heroRef.current?.focus();
  }, [draft]);

  const startNew = useCallback(() => {
    setDraft(true);
    setChatId(null);
    setMessages([]);
    setInput("");
    setError("");
  }, []);

  useEffect(() => {
    if (window.location.hash === "#new") {
      startNew();
      window.history.replaceState(null, "", window.location.pathname);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openChat = useCallback((id: string) => {
    setDraft(false);
    setChatId(id);
    setError("");
    try {
      localStorage.setItem("creagent.activeChat", id);
    } catch {
      /* ignore */
    }
  }, []);

  const send = useCallback(
    async (textOverride?: string) => {
      const text = (textOverride ?? input).trim();
      if (!text || busy) return;
      setBusy(true);
      stopRef.current = false;
      setError("");
      setInput("");
      setMessages((m) => [
        ...m,
        { id: `local-${Date.now()}`, role: "user", content: text, toolName: null, compacted: 0, created_at: "" },
      ]);
      try {
        let id = chatId;
        if (!id || draft) {
          const res = await fetch("/api/agent/chats", { method: "POST" });
          if (!res.ok) {
            setError("could not create chat");
            return;
          }
          id = ((await res.json()) as { chatId: string }).chatId;
          setDraft(false);
          setChatId(id);
          try {
            localStorage.setItem("creagent.activeChat", id);
          } catch {
            /* ignore */
          }
          void loadChats();
        }
        const res = await fetch(`/api/agent/chats/${id}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ message: text }),
        });
        if (!res.ok) {
          setError("send failed");
          return;
        }
        const { jobId } = (await res.json()) as { jobId: string };
        for (let i = 0; i < 120 && !stopRef.current; i++) {
          await new Promise((r) => setTimeout(r, 2000));
          await loadMessages(id);
          const poll = await fetch(`/api/jobs/${jobId}`);
          if (!poll.ok) break;
          const job = (await poll.json()) as { state: string; failedReason?: string };
          if (job.state === "completed") break;
          if (job.state === "failed") {
            setError(`agent failed: ${job.failedReason ?? "unknown"}`);
            break;
          }
        }
        await loadMessages(id);
        await loadChats();
      } finally {
        setBusy(false);
      }
    },
    [chatId, draft, input, busy, loadMessages, loadChats],
  );

  const compact = useCallback(async () => {
    if (!chatId || compacting) return;
    setCompacting(true);
    setError("");
    try {
      const res = await fetch(`/api/agent/chats/${chatId}/compact`, { method: "POST" });
      const data = (await res.json()) as { compacted?: boolean; error?: string };
      if (!res.ok) {
        setError(data.error ?? "compact failed");
        return;
      }
      if (!data.compacted) setError("Nothing to compact yet — keep chatting.");
      await loadMessages(chatId);
      await loadChats();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setCompacting(false);
    }
  }, [chatId, compacting, loadMessages, loadChats]);

  const commitRename = useCallback(
    async (id: string) => {
      const title = renameText.trim();
      setRenamingId(null);
      if (!title) return;
      setChats((cs) => cs.map((c) => (c.id === id ? { ...c, title } : c)));
      await fetch(`/api/agent/chats/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title }),
      });
      void loadChats();
    },
    [renameText, loadChats],
  );

  const removeChat = useCallback(
    async (c: Chat) => {
      if (!window.confirm(`Delete "${c.title}"? This can't be undone.`)) return;
      await fetch(`/api/agent/chats/${c.id}`, { method: "DELETE" });
      setChats((cs) => cs.filter((x) => x.id !== c.id));
      if (c.id === chatId) startNew();
    },
    [chatId, startNew],
  );

  const dropOrder = useCallback(
    async (list: Chat[]) => {
      await fetch("/api/agent/chats", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ order: list.map((c) => c.id) }),
      });
    },
    [],
  );

  const onDragOverRow = useCallback(
    (overId: string) => {
      if (!dragId || dragId === overId) return;
      setChats((cs) => {
        const from = cs.findIndex((c) => c.id === dragId);
        const to = cs.findIndex((c) => c.id === overId);
        if (from < 0 || to < 0) return cs;
        const next = [...cs];
        const [moved] = next.splice(from, 1);
        if (!moved) return cs;
        next.splice(to, 0, moved);
        return next;
      });
    },
    [dragId],
  );

  const onDragEnd = useCallback(() => {
    setDragId(null);
    setChats((cs) => {
      void dropOrder(cs);
      return cs;
    });
  }, [dropOrder]);

  const active = chats.find((c) => c.id === chatId) ?? null;
  const showHero = draft || (!busy && messages.length === 0);

  const composer = (inHero: boolean): React.ReactNode => (
    <>
      <textarea
        ref={inHero ? heroRef : undefined}
        rows={inHero ? 3 : 2}
        placeholder="Ask the agent to do anything in the app… (Enter sends, Shift+Enter for a new line)"
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            void send();
          }
        }}
      />
      {busy ? (
        <button onClick={() => (stopRef.current = true)}>Stop</button>
      ) : (
        <button className="primary" disabled={!input.trim()} onClick={() => void send()}>
          Send
        </button>
      )}
    </>
  );

  return (
    <div className="chat2">
      <div className="chat2-rail">
        <div className="muted" style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase" }}>
          Sessions
        </div>
        <button className="primary" onClick={startNew}>
          + New session
        </button>
        {chats.map((c) => (
          <div
            key={c.id}
            className={`chat2-session${c.id === chatId && !draft ? " on" : ""}${dragId === c.id ? " dragging" : ""}`}
            draggable={renamingId !== c.id}
            onDragStart={(e) => {
              setDragId(c.id);
              e.dataTransfer.effectAllowed = "move";
            }}
            onDragOver={(e) => {
              e.preventDefault();
              onDragOverRow(c.id);
            }}
            onDragEnd={onDragEnd}
            onClick={() => openChat(c.id)}
            title="Drag to reorder · double-click title to rename"
          >
            <span className="grip" aria-hidden="true">⠿</span>
            <span>
              {renamingId === c.id ? (
                <input
                  className="rename-input"
                  autoFocus
                  value={renameText}
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => setRenameText(e.target.value)}
                  onBlur={() => void commitRename(c.id)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void commitRename(c.id);
                    if (e.key === "Escape") setRenamingId(null);
                  }}
                />
              ) : (
                <span
                  className="t"
                  onDoubleClick={(e) => {
                    e.stopPropagation();
                    setRenameText(c.title);
                    setRenamingId(c.id);
                  }}
                >
                  {c.title}
                </span>
              )}
              <span className="m">
                {new Date(c.created_at).toLocaleDateString([], { month: "short", day: "numeric" })} ·{" "}
                {money(c.cost_usd)} · ctx {c.ctx_pct}%
              </span>
            </span>
            <span className="acts">
              <button
                title="Rename"
                onClick={(e) => {
                  e.stopPropagation();
                  setRenameText(c.title);
                  setRenamingId(c.id);
                }}
              >
                ✎
              </button>
              <button
                title="Delete session"
                onClick={(e) => {
                  e.stopPropagation();
                  void removeChat(c);
                }}
              >
                ×
              </button>
            </span>
          </div>
        ))}
        {chats.length === 0 && <div className="empty"><p>No sessions yet — start below.</p></div>}
      </div>
      <div className="chat2-main">
        {error !== "" && <p className="note err">{error}</p>}
        {showHero ? (
          <div className="hero">
            <h2>What should the agent do?</h2>
            <p className="sub">It can draft, plan, edit, ingest and analyze anywhere in Creagent. Spends and publishing stay approval-gated.</p>
            <div className="hero-box">{composer(true)}</div>
            <div className="chips">
              {PROMPTS.map((p) => (
                <button key={p} className="chip" disabled={busy} onClick={() => void send(p)}>
                  {p}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <>
            {active && (
              <p className="muted">
                {money(active.cost_usd)} this session ·{" "}
                {(active.prompt_tokens + active.completion_tokens).toLocaleString()} tokens ·{" "}
                ctx {active.ctx_pct}%{" "}
                <button disabled={compacting} onClick={() => void compact()}>
                  {compacting ? "Compacting…" : "Compact"}
                </button>
              </p>
            )}
            <ReviewCards />
            <div className="chat2-thread">
              {messages.map((m) =>
                m.role === "tool" ? (
                  <div key={m.id} className="chat-tool" title={m.content.slice(0, 500)}>
                    ⚙ {m.toolName} {m.content.startsWith('{"ok":true') ? "✓" : "✗"}
                  </div>
                ) : (
                  <div key={m.id} className={`chat-msg ${m.role}${m.compacted ? " old" : ""}`}>
                    {m.content || <span className="muted">(working…)</span>}
                  </div>
                ),
              )}
              {messages.some((m) => m.compacted) && (
                <p className="muted" style={{ fontSize: 11 }}>
                  Dimmed messages were compacted into the summary above to save context.
                </p>
              )}
              <div ref={bottomRef} />
            </div>
            <div className="chat2-input">{composer(false)}</div>
          </>
        )}
      </div>
    </div>
  );
}
