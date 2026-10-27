"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type Item = { label: string; hint: string; href: string; keys: string; action?: "agent" };

const ITEMS: Item[] = [
  { label: "Home — command center", hint: "go", href: "/", keys: "home today dashboard start" },
  { label: "Calendar", hint: "go", href: "/queue", keys: "queue calendar slots schedule plan" },
  { label: "Brain", hint: "go", href: "/brain", keys: "brain voice vault pillars strategy" },
  { label: "Carousels", hint: "go", href: "/carousels", keys: "carousel slides images graphics" },
  { label: "Videos", hint: "go", href: "/videos", keys: "video timeline edit captions timeline" },
  { label: "Data", hint: "go", href: "/data", keys: "data metrics analytics performance" },
  { label: "Settings", hint: "go", href: "/settings", keys: "settings keys ingest appearance theme" },
  { label: "Agent chat", hint: "go", href: "/chat", keys: "agent chat talk ask" },
  { label: "New agent session", hint: "agent", href: "/chat#new", keys: "new session start chat fresh" },
  { label: "Toggle agent panel", hint: "agent", href: "", keys: "dock panel sidebar toggle show hide", action: "agent" },
];

export function openCommandBar(): void {
  window.dispatchEvent(new CustomEvent("creagent:command"));
}

export default function CommandBar(): React.ReactNode {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
      } else if (e.key === "Escape") {
        setOpen(false);
      }
    };
    const onOpen = (): void => setOpen(true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("creagent:command", onOpen);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("creagent:command", onOpen);
    };
  }, []);

  useEffect(() => {
    if (open) {
      setQ("");
      setSel(0);
      inputRef.current?.focus();
    }
  }, [open ]);

  const hits = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return ITEMS;
    return ITEMS.filter((i) => `${i.label} ${i.keys}`.toLowerCase().includes(needle));
  }, [q]);

  const go = useCallback(
    (item: Item) => {
      setOpen(false);
      if (item.action === "agent") {
        window.dispatchEvent(new CustomEvent("creagent:agent-toggle"));
        return;
      }
      window.location.href = item.href;
    },
    [],
  );

  if (!open) return null;
  return (
    <div className="cmd-backdrop" onClick={() => setOpen(false)}>
      <div className="cmd" role="dialog" aria-label="Command bar" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          placeholder="Type a command or search pages…"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setSel(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setSel((s) => Math.min(s + 1, hits.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setSel((s) => Math.max(s - 1, 0));
            } else if (e.key === "Enter" && hits[sel]) {
              go(hits[sel] as Item);
            }
          }}
        />
        <div className="cmd-list">
          {hits.map((i, idx) => (
            <button
              key={i.label}
              className={idx === sel ? "on" : ""}
              onMouseEnter={() => setSel(idx)}
              onClick={() => go(i)}
            >
              <span>{i.label}</span>
              <span className="cmd-hint">{i.hint}</span>
            </button>
          ))}
          {hits.length === 0 && <p className="muted" style={{ padding: "8px 12px" }}>No matches.</p>}
        </div>
      </div>
    </div>
  );
}
