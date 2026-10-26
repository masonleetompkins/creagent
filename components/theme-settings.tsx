"use client";

import { useCallback, useEffect, useState } from "react";

const KEY = "creagent.theme";
const DEFAULT_HUE = 217;

type Mode = "dark" | "light";

const PRESETS: { name: string; hue: number }[] = [
  { name: "Blue", hue: 217 },
  { name: "Red", hue: 345 },
  { name: "Violet", hue: 275 },
  { name: "Teal", hue: 175 },
  { name: "Green", hue: 140 },
  { name: "Orange", hue: 25 },
];

function readTheme(): { hue: number; mode: Mode } {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (raw) {
      const t = JSON.parse(raw) as { hue?: unknown; mode?: unknown };
      return {
        hue: typeof t.hue === "number" && t.hue >= 0 && t.hue <= 360 ? Math.round(t.hue) : DEFAULT_HUE,
        mode: t.mode === "light" ? "light" : "dark",
      };
    }
  } catch {
    /* corrupted or private mode */
  }
  const root = document.documentElement;
  const hue = Number.parseInt(root.style.getPropertyValue("--hue") || `${DEFAULT_HUE}`, 10);
  return {
    hue: Number.isFinite(hue) ? hue : DEFAULT_HUE,
    mode: root.dataset.mode === "light" ? "light" : "dark",
  };
}

function applyTheme(hue: number, mode: Mode): void {
  const root = document.documentElement;
  root.style.setProperty("--hue", `${hue}`);
  root.dataset.mode = mode;
  try {
    window.localStorage.setItem(KEY, JSON.stringify({ hue, mode }));
  } catch {
    /* private mode */
  }
}

export default function ThemeSettings(): React.ReactNode {
  const [hue, setHue] = useState(DEFAULT_HUE);
  const [mode, setMode] = useState<Mode>("dark");

  useEffect(() => {
    const t = readTheme();
    setHue(t.hue);
    setMode(t.mode);
  }, []);

  const changeHue = useCallback(
    (next: number) => {
      const h = Math.max(0, Math.min(360, Math.round(next)));
      setHue(h);
      applyTheme(h, mode);
    },
    [mode],
  );

  const changeMode = useCallback(
    (next: Mode) => {
      setMode(next);
      applyTheme(hue, next);
    },
    [hue],
  );

  return (
    <section className="keycard">
      <h2>Appearance</h2>
      <p className="muted">Glass tint and brightness. Saved on this machine only.</p>
      <div className="theme-row">
        <label>Mode</label>
        <div className="seg">
          <button className={mode === "dark" ? "on" : ""} onClick={() => changeMode("dark")}>
            Dark
          </button>
          <button className={mode === "light" ? "on" : ""} onClick={() => changeMode("light")}>
            Light
          </button>
        </div>
      </div>
      <div className="theme-row">
        <label htmlFor="hue">Tint</label>
        <input
          id="hue"
          type="range"
          className="hue"
          min={0}
          max={360}
          step={1}
          value={hue}
          onChange={(e) => changeHue(Number(e.target.value))}
          aria-label="Glass tint hue"
        />
      </div>
      <div className="theme-row">
        <label>Presets</label>
        {PRESETS.map((p) => (
          <button
            key={p.name}
            className={`swatch${Math.abs(hue - p.hue) < 4 ? " on" : ""}`}
            style={{ background: `hsl(${p.hue} 85% 55%)` }}
            title={p.name}
            aria-label={`${p.name} tint`}
            onClick={() => changeHue(p.hue)}
          />
        ))}
      </div>
    </section>
  );
}
