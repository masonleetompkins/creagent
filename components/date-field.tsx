"use client";

import { useEffect, useRef, useState } from "react";

function fmt(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y ?? 2000, (m ?? 1) - 1, d ?? 1).toLocaleDateString([], {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function toISO(y: number, m: number, d: number): string {
  return `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function parse(iso: string): { y: number; m: number; d: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso.trim());
  if (!m) return null;
  return { y: Number(m[1]), m: Number(m[2]) - 1, d: Number(m[3]) };
}

const DOW = ["S", "M", "T", "W", "T", "F", "S"];

export default function DateField({
  value,
  onChange,
  label,
  placeholder,
}: {
  value: string;
  onChange: (iso: string) => void;
  label: string;
  placeholder: string;
}): React.ReactNode {
  const [open, setOpen] = useState(false);
  const today = new Date();
  const [vy, setVy] = useState(today.getFullYear());
  const [vm, setVm] = useState(today.getMonth());
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const p = parse(value);
    const t = new Date();
    setVy(p?.y ?? t.getFullYear());
    setVm(p?.m ?? t.getMonth());
    const onDown = (e: MouseEvent): void => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const move = (delta: number): void => {
    const m = vm + delta;
    if (m < 0) {
      setVy(vy - 1);
      setVm(11);
    } else if (m > 11) {
      setVy(vy + 1);
      setVm(0);
    } else {
      setVm(m);
    }
  };

  const pick = (iso: string): void => {
    onChange(iso);
    setOpen(false);
  };

  const firstDow = new Date(vy, vm, 1).getDay();
  const daysInMonth = new Date(vy, vm + 1, 0).getDate();
  const todayISO = toISO(today.getFullYear(), today.getMonth(), today.getDate());
  const cells: (number | null)[] = [
    ...Array<null>(firstDow).fill(null),
    ...Array.from({ length: daysInMonth }, (_, i) => i + 1),
  ];

  return (
    <div className="datefield" ref={wrapRef}>
      <button
        type="button"
        aria-label={label}
        className={value ? "" : "is-empty"}
        onClick={() => setOpen((o) => !o)}
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
          <path d="M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
          <path d="M16 2v4M8 2v4M3 10h18" />
        </svg>
        {value ? fmt(value) : placeholder}
      </button>
      {open && (
        <div className="date-pop" role="dialog" aria-label={label}>
          <div className="date-nav">
            <button type="button" onClick={() => move(-1)} aria-label="Previous month">←</button>
            <strong>
              {new Date(vy, vm, 1).toLocaleDateString([], { month: "long" })} {vy}
            </strong>
            <button type="button" onClick={() => move(1)} aria-label="Next month">→</button>
          </div>
          <div className="date-grid">
            {DOW.map((d, i) => (
              <span key={i} className="dow">
                {d}
              </span>
            ))}
            {cells.map((d, i) => {
              if (d === null) return <span key={`b${i}`} />;
              const iso = toISO(vy, vm, d);
              const cls = ["dcell"];
              if (iso === value) cls.push("sel");
              if (iso === todayISO) cls.push("today");
              return (
                <button key={iso} type="button" className={cls.join(" ")} onClick={() => pick(iso)}>
                  {d}
                </button>
              );
            })}
          </div>
          <div className="date-foot">
            <button type="button" onClick={() => pick(todayISO)}>
              Today
            </button>
            <button type="button" onClick={() => pick("")}>
              Clear
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
