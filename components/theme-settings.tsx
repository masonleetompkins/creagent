"use client";

import { useCallback, useEffect, useState } from "react";

const KEY = "creagent.theme";
const DEFAULT_HUE = 217;

type Mode = "dark" | "light";
type Flat = "black" | "white" | null;

const COLORS: { name: string; hue: number }[] = [
  { name: "Red", hue: 0 },
  { name: "Orange", hue: 25 },
  { name: "Gold", hue: 45 },
  { name: "Green", hue: 140 },
  { name: "Teal", hue: 168 },
  { name: "Cyan", hue: 195 },
  { name: "Blue", hue: 217 },
  { name: "Indigo", hue: 245 },
  { name: "Violet", hue: 275 },
  { name: "Magenta", hue: 320 },
];

function readTheme(): { hue: number; mode: Mode; flat: Flat } {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (raw) {
      const t = JSON.parse(raw) as { hue?: unknown; mode?: unknown; flat?: unknown };
      return {
        hue: typeof t.hue === "number" && t.hue >= 0 && t.hue <= 360 ? Math.round(t.hue) : DEFAULT_HUE,
        mode: t.mode === "light" ? "light" : "dark",
        flat: t.flat === "black" || t.flat === "white" ? t.flat : null,
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
    flat: root.dataset.flat === "black" || root.dataset.flat === "white" ? root.dataset.flat : null,
  };
}

function applyTheme(hue: number, mode: Mode, flat: Flat): void {
  const root = document.documentElement;
  root.style.setProperty("--hue", `${hue}`);
  root.dataset.mode = mode;
  if (flat) root.dataset.flat = flat;
  else delete root.dataset.flat;
  try {
    window.localStorage.setItem(KEY, JSON.stringify({ hue, mode, flat }));
  } catch {
    /* private mode */
  }
}

export default function ThemeSettings(): React.ReactNode {
  const [hue, setHue] = useState(DEFAULT_HUE);
  const [mode, setMode] = useState<Mode>("dark");
  const [flat, setFlat] = useState<Flat>(null);

  useEffect(() => {
    const t = readTheme();
    setHue(t.hue);
    setMode(t.mode);
    setFlat(t.flat);
  }, []);

  const changeHue = useCallback(
    (next: number) => {
      const h = Math.max(0, Math.min(360, Math.round(next)));
      setHue(h);
      setFlat(null);
      applyTheme(h, mode, null);
    },
    [mode],
  );

  const changeMode = useCallback(
    (next: Mode) => {
      setMode(next);
      applyTheme(hue, next, flat);
    },
    [hue, flat],
  );

  const changeFlat = useCallback(
    (next: Flat) => {
      setFlat(next);
      applyTheme(hue, mode, next);
    },
    [hue, mode],
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
        <label>Colors</label>
        {COLORS.map((p) => (
          <button
            key={p.name}
            className={`swatch${flat === null && Math.abs(hue - p.hue) < 4 ? " on" : ""}`}
            style={{ background: `hsl(${p.hue} 85% 55%)` }}
            title={p.name}
            aria-label={`${p.name} tint`}
            onClick={() => changeHue(p.hue)}
          />
        ))}
        <button
          className={`swatch mono${flat === "black" ? " on" : ""}`}
          style={{ background: "#000" }}
          title="Black (no gradient)"
          aria-label="True black, no gradient"
          onClick={() => changeFlat("black")}
        />
        <button
          className={`swatch mono${flat === "white" ? " on" : ""}`}
          style={{ background: "#fff" }}
          title="White (no gradient)"
          aria-label="True white, no gradient"
          onClick={() => changeFlat("white")}
        />
      </div>
    </section>
  );
}
