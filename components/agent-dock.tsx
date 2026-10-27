"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import ReviewCards from "./review-cards";

type Chat = {
  id: string;
  title: string;
  created_at: string;
  prompt_tokens: number;
  completion_tokens: number;
  cost_usd: number;
  ctx_pct: number;
};
type Msg = {
  id: string;
  role: string;
  content: string;
  toolName: string | null;
  compacted: number;
};

function money(n: number): string {
  return n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
}

export function toggleAgentDock(): void {
  window.dispatchEvent(new CustomEvent("creagent:agent-toggle"));
}

export function openAgentDock(): void {
  window.dispatchEvent(new CustomEvent("creagent:agent-open"));
}

export default function AgentDock(): React.ReactNode {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<"thread" | "list">("thread");
  const [chats, setChats] = useState<Chat[]>([]);
  const [chatId, setChatId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [compacting, setCompacting] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameText, setRenameText] = useState("");
  const [dragId, setDragId] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const stopRef = useRef(false);

  useEffect(() => {
    try {
      if (localStorage.getItem("creagent.dockOpen") === "1") setOpen(true);
    } catch {
      /* closed */
    }
    const onToggle = (): void =>
      setOpen((o) => {
        try {
          localStorage.setItem("creagent.dockOpen", o ? "0" : "1");
        } catch {
          /* ignore */
        }
        return !o;
      });
    const onOpen = (): void => {
      try {
        localStorage.setItem("creagent.dockOpen", "1");
      } catch {
        /* ignore */
      }
      setOpen(true);
    };
    const onKey = (e: KeyboardEvent): void => {
      const t = e.target as HTMLElement | null;
      const typing =
        t !== null &&
        (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);
      if (e.altKey && !e.metaKey && !e.ctrlKey && e.key.toLowerCase() === "a" && !typing) {
        e.preventDefault();
        onToggle();
      }
    };
    window.addEventListener("creagent:agent-toggle", onToggle);
    window.addEventListener("creagent:agent-open", onOpen);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("creagent:agent-toggle", onToggle);
      window.removeEventListener("creagent:agent-open", onOpen);
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  useEffect(() => {
    document.body.classList.toggle("has-dock", open);
    return () => document.body.classList.remove("has-dock");
  }, [open]);

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
      if (stored && list.some((c) => c.id === stored)) return stored;
      return cur ?? list[0]?.id ?? null;
    });
  }, []);

  const loadMessages = useCallback(async (id: string) => {
    const res = await fetch(`/api/agent/chats/${id}`);
    if (res.ok) setMessages(((await res.json()) as { messages: Msg[] }).messages);
  }, []);

  useEffect(() => {
    if (open) void loadChats();
  }, [open, loadChats]);

  useEffect(() => {
    if (open && chatId) void loadMessages(chatId);
    if (!chatId) setMessages([]);
  }, [open, chatId, loadMessages]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [messages, open, view]);

  const pick = useCallback((id: string | null) => {
    setChatId(id);
    try {
      if (id) localStorage.setItem("creagent.activeChat", id);
    } catch {
      /* ignore */
    }
  }, []);

  const enter = useCallback(
    (id: string) => {
      pick(id);
      setView("thread");
    },
    [pick],
  );

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || busy) return;
    setBusy(true);
    stopRef.current = false;
    setInput("");
    setMessages((m) => [
      ...m,
      { id: `local-${Date.now()}`, role: "user", content: text, toolName: null, compacted: 0 },
    ]);
    try {
      let id = chatId;
      if (!id) {
        const res = await fetch("/api/agent/chats", { method: "POST" });
        if (!res.ok) return;
        id = ((await res.json()) as { chatId: string }).chatId;
        pick(id);
        void loadChats();
      }
      const res = await fetch(`/api/agent/chats/${id}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: text }),
      });
      if (!res.ok) return;
      const { jobId } = (await res.json()) as { jobId: string };
      for (let i = 0; i < 120 && !stopRef.current; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        await loadMessages(id);
        const poll = await fetch(`/api/jobs/${jobId}`);
        if (!poll.ok) break;
        const job = (await poll.json()) as { state: string };
        if (job.state === "completed" || job.state === "failed") break;
      }
      await loadMessages(id);
      await loadChats();
      window.dispatchEvent(new CustomEvent("creagent:agent-updated"));
    } finally {
      setBusy(false);
    }
  }, [chatId, input, busy, loadMessages, loadChats, pick]);

  const compact = useCallback(async () => {
    if (!chatId || compacting) return;
    setCompacting(true);
    try {
      await fetch(`/api/agent/chats/${chatId}/compact`, { method: "POST" });
      await loadMessages(chatId);
      await loadChats();
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
      if (c.id === chatId) pick(null);
    },
    [chatId, pick],
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
      void fetch("/api/agent/chats", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ order: cs.map((c) => c.id) }),
      });
      return cs;
    });
  }, []);

  const close = useCallback(() => {
    try {
      localStorage.setItem("creagent.dockOpen", "0");
    } catch {
      /* ignore */
    }
    setOpen(false);
  }, []);

  if (!open) return null;
  const active = chats.find((c) => c.id === chatId) ?? null;
  return (
    <div className="g-dock">
      <div className="agent-dock">
        <div className="agent-head">
          <div>
            <strong>Agent</strong>
            <div className="agent-sub muted">
              {active ? active.title : "New session"}
              {active ? ` · ${money(active.cost_usd)} · ctx ${active.ctx_pct}%` : ""}
            </div>
          </div>
          <div className="row">
            <button onClick={() => setView((v) => (v === "list" ? "thread" : "list"))} title="Chat sessions">
              {view === "list" ? "Back" : "Chats"}
            </button>
            <button disabled={!chatId || compacting} onClick={() => void compact()} title="Compact context">
              {compacting ? "…" : "Compact"}
            </button>
            <button className="icon" onClick={close} title="Close panel (⌥A)">
              ×
            </button>
          </div>
        </div>
        {view === "list" ? (
          <div className="dock-list">
            <button
              className="primary"
              onClick={() => {
                pick(null);
                setView("thread");
              }}
            >
              + New session
            </button>
            {chats.map((c) => (
              <div
                key={c.id}
                className={`chat2-session${c.id === chatId ? " on" : ""}${dragId === c.id ? " dragging" : ""}`}
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
                onClick={() => enter(c.id)}
                title="Open · drag to reorder · double-click title to rename"
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
            {chats.length === 0 && <p className="muted">No sessions yet — start one above.</p>}
          </div>
        ) : (
          <>
            <ReviewCards />
            <div className="agent-thread">
              {!chatId && messages.length === 0 && (
                <p className="muted">New session — send a message below to start.</p>
              )}
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
              <div ref={bottomRef} />
            </div>
            <div className="composer">
              <textarea
                rows={2}
                placeholder="Ask the agent… (Enter sends)"
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
            </div>
          </>
        )}
      </div>
    </div>
  );
}
