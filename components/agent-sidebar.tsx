"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type Msg = { id: string; role: string; content: string; toolName: string | null; compacted: number; created_at: string };

export default function AgentSidebar({
  kind,
  entityId,
}: {
  kind: "carousel" | "video";
  entityId: string;
}): React.ReactNode {
  const [open, setOpen] = useState(true);
  const [chatId, setChatId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [title, setTitle] = useState(entityId);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [dirty, setDirty] = useState(false);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const storeKey = `creagent.agent.${kind}.${entityId}`;

  const loadMessages = useCallback(async (id: string) => {
    const res = await fetch(`/api/agent/chats/${id}`);
    if (res.ok) setMessages(((await res.json()) as { messages: Msg[] }).messages);
  }, []);

  useEffect(() => {
    let stored: string | null = null;
    try {
      stored = window.localStorage.getItem(storeKey);
    } catch {
      /* private mode */
    }
    if (stored) {
      setChatId(stored);
      void loadMessages(stored);
    }
  }, [storeKey, loadMessages]);

  useEffect(() => {
    const url = kind === "carousel" ? `/api/carousels/${entityId}` : `/api/video-projects/${entityId}`;
    fetch(url)
      .then(async (res) => {
        if (!res.ok) return;
        const data = (await res.json()) as { project?: { title?: unknown } };
        if (typeof data.project?.title === "string" && data.project.title.trim()) {
          setTitle(data.project.title);
        }
      })
      .catch(() => {});
  }, [kind, entityId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [messages, open]);

  useEffect(() => {
    document.body.classList.toggle("has-agent-dock", open);
    return () => {
      document.body.classList.remove("has-agent-dock");
    };
  }, [open ]);

  const ensureChat = useCallback(async (): Promise<string | null> => {
    if (chatId) return chatId;
    const res = await fetch("/api/agent/chats", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: `${kind === "carousel" ? "Carousel" : "Video"}: ${title}`.slice(0, 80) }),
    });
    if (!res.ok) {
      setError("could not create agent chat");
      return null;
    }
    const { chatId: id } = (await res.json()) as { chatId: string };
    setChatId(id);
    try {
      window.localStorage.setItem(storeKey, id);
    } catch {
      /* private mode */
    }
    return id;
  }, [chatId, kind, title, storeKey]);

  const send = useCallback(async () => {
    if (!input.trim() || busy) return;
    setBusy(true);
    setError("");
    const text = input.trim();
    setInput("");
    setMessages((m) => [
      ...m,
      { id: `local-${Date.now()}`, role: "user", content: text, toolName: null, compacted: 0, created_at: "" },
    ]);
    try {
      const id = await ensureChat();
      if (!id) return;
      const scoped =
        `[Context: I am editing the ${kind} "${title}" (id ${entityId}). ` +
        `Act on this ${kind} unless I name a different one.] ${text}`;
      const res = await fetch(`/api/agent/chats/${id}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: scoped.slice(0, 8000) }),
      });
      if (!res.ok) {
        setError("send failed");
        return;
      }
      const { jobId } = (await res.json()) as { jobId: string };
      for (let i = 0; i < 180; i++) {
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
      setDirty(true);
    } finally {
      setBusy(false);
    }
  }, [input, busy, ensureChat, loadMessages, kind, title, entityId]);

  const newConversation = useCallback(() => {
    try {
      window.localStorage.removeItem(storeKey);
    } catch {
      /* private mode */
    }
    setChatId(null);
    setMessages([]);
    setError("");
  }, [storeKey]);

  if (!open) {
    return (
      <button className="agent-tab" onClick={() => setOpen(true)} title="Open agent sidebar">
        ◀ Agent
      </button>
    );
  }

  return (
    <aside className="agent-dock">
      <div className="agent-head">
        <div>
          <strong>Agent</strong>
          <div className="muted agent-sub">
            {kind}: {title}
          </div>
        </div>
        <div className="row">
          <button title="Start a fresh conversation" onClick={newConversation}>
            New
          </button>
          <button title="Reload the editor to show agent-made changes" onClick={() => window.location.reload()}>
            Reload editor
          </button>
          <button title="Collapse sidebar" onClick={() => setOpen(false)}>
            ▶
          </button>
        </div>
      </div>
      {error !== "" && <p className="note err">{error}</p>}
      {dirty && <p className="note">The agent changed this project — Reload editor to see it.</p>}
      <div className="agent-thread">
        {messages.length === 0 && (
          <p className="muted">
            Ask for anything — drafts, edits, trims, captions, exports. The agent works on this {kind}{" "}
            directly.
          </p>
        )}
        {messages.map((m) =>
          m.role === "tool" ? (
            <div key={m.id} className="chat-tool" title={m.content.slice(0, 500)}>
              ⚙ {m.toolName} {m.content.startsWith('{"ok":true') ? "✓" : "✗"}
            </div>
          ) : (
            <div key={m.id} className={`chat-msg ${m.role}${m.compacted ? " old" : ""}`}>
              {(m.role === "user" ? m.content.replace(/^\[Context:.*?\] /, "") : m.content) || (
                <span className="muted">(working…)</span>
              )}
            </div>
          ),
        )}
        <div ref={bottomRef} />
      </div>
      <div className="row">
        <input
          type="text"
          placeholder={busy ? "Agent is working…" : `Ask the agent to edit this ${kind}…`}
          value={input}
          disabled={busy}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void send();
          }}
        />
        <button className="primary" disabled={busy || !input.trim()} onClick={() => void send()}>
          {busy ? "Working…" : "Send"}
        </button>
      </div>
    </aside>
  );
}
