"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type Chat = {
  id: string;
  title: string;
  created_at: string;
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

export default function ChatConsole(): React.ReactNode {
  const [chats, setChats] = useState<Chat[]>([]);
  const [chatId, setChatId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [compacting, setCompacting] = useState(false);
  const [error, setError] = useState("");
  const bottomRef = useRef<HTMLDivElement | null>(null);

  const loadChats = useCallback(async () => {
    const res = await fetch("/api/agent/chats");
    if (res.ok) setChats(((await res.json()) as { chats: Chat[] }).chats);
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

  const newChat = useCallback(async () => {
    const res = await fetch("/api/agent/chats", { method: "POST" });
    if (!res.ok) {
      setError("could not create chat");
      return;
    }
    const { chatId: id } = (await res.json()) as { chatId: string };
    setError("");
    await loadChats();
    setChatId(id);
    setInput("");
  }, [loadChats]);

  const send = useCallback(async () => {
    if (!chatId || !input.trim() || busy) return;
    setBusy(true);
    setError("");
    const text = input.trim();
    setInput("");
    setMessages((m) => [
      ...m,
      { id: `local-${Date.now()}`, role: "user", content: text, toolName: null, compacted: 0, created_at: "" },
    ]);
    try {
      const res = await fetch(`/api/agent/chats/${chatId}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: text }),
      });
      if (!res.ok) {
        setError("send failed");
        return;
      }
      const { jobId } = (await res.json()) as { jobId: string };
      for (let i = 0; i < 120; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        await loadMessages(chatId);
        const poll = await fetch(`/api/jobs/${jobId}`);
        if (!poll.ok) break;
        const job = (await poll.json()) as { state: string; failedReason?: string };
        if (job.state === "completed") break;
        if (job.state === "failed") {
          setError(`agent failed: ${job.failedReason ?? "unknown"}`);
          break;
        }
      }
      await loadMessages(chatId);
      await loadChats();
    } finally {
      setBusy(false);
    }
  }, [chatId, input, busy, loadMessages, loadChats]);

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

  const active = chats.find((c) => c.id === chatId) ?? null;

  return (
    <div className="chat2">
      <div className="chat2-rail">
        <button className="primary" onClick={() => void newChat()}>
          + New
        </button>
        {chats.map((c) => (
          <button
            key={c.id}
            className={`chat2-session${c.id === chatId ? " on" : ""}`}
            onClick={() => setChatId(c.id)}
          >
            <span className="t">{c.title}</span>
            <span className="m">
              {money(c.cost_usd)} · ctx {c.ctx_pct}%
            </span>
          </button>
        ))}
        {chats.length === 0 && <p className="muted">No sessions yet.</p>}
      </div>
      <div className="chat2-main">
        {error !== "" && <p className="note err">{error}</p>}
        {!chatId && (
          <p className="muted">Start a new session to put the agent to work.</p>
        )}
        {chatId && (
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
            <div className="chat2-thread">
              {messages
                .filter((m) => m.role !== "tool")
                .map((m) => (
                  <div key={m.id} className={`chat-msg ${m.role}${m.compacted ? " old" : ""}`}>
                    {m.content || <span className="muted">(working…)</span>}
                  </div>
                ))}
              {messages
                .filter((m) => m.role === "tool")
                .map((m) => (
                  <div key={m.id} className="chat-tool" title={m.content.slice(0, 500)}>
                    ⚙ {m.toolName} {m.content.startsWith('{"ok":true') ? "✓" : "✗"}
                  </div>
                ))}
              <div ref={bottomRef} />
            </div>
            <div className="chat2-input">
              <input
                type="text"
                placeholder="Ask the agent to do anything in the app…"
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
          </>
        )}
      </div>
    </div>
  );
}
