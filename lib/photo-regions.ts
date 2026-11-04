// Forbidden-text regions: fraction-of-photo rectangles (0-1) where copy
// must never sit — faces, signage, busy texture. Marked by the user in
// the editor or by the agent; enforced by the slide renderer.
import { randomUUID } from "node:crypto";
import { getDb, nowIso } from "./db";

export type PhotoRegion = {
  id: string;
  url: string;
  x: number;
  y: number;
  w: number;
  h: number;
  label: string;
  created_at: string;
};

export function listRegions(url: string): PhotoRegion[] {
  return getDb()
    .prepare(`SELECT * FROM photo_regions WHERE url = ? ORDER BY created_at`)
    .all(url) as PhotoRegion[];
}

export function addRegion(
  url: string,
  box: { x: number; y: number; w: number; h: number; label?: string },
): PhotoRegion {
  const { x, y, w, h } = box;
  if (![x, y, w, h].every((n) => typeof n === "number" && Number.isFinite(n))) {
    throw new Error("region box must be four finite numbers");
  }
  if (x < 0 || y < 0 || w <= 0 || h <= 0 || x + w > 1 || y + h > 1) {
    throw new Error("region must fit inside the photo (0-1 fractions)");
  }
  const row: PhotoRegion = {
    id: randomUUID(),
    url,
    x, y, w, h,
    label: (box.label ?? "").slice(0, 60),
    created_at: nowIso(),
  };
  getDb()
    .prepare(
      `INSERT INTO photo_regions (id, url, x, y, w, h, label, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(row.id, row.url, row.x, row.y, row.w, row.h, row.label, row.created_at);
  return row;
}

export function deleteRegion(id: string): boolean {
  const res = getDb().prepare(`DELETE FROM photo_regions WHERE id = ?`).run(id);
  return res.changes > 0;
}

// Where may a text band of `bandH` (fraction of height) sit? Scan candidate
// top-edges from the bottom up, return the first band whose vertical span
// overlaps no region. Falls back to the photo's bottom when every slot
// overlaps (regions are advice, text must still render).
export function clearBand(
  regions: PhotoRegion[],
  bandH: number,
  step = 0.05,
): { top: number; bottom: boolean } {
  const h = Math.min(Math.max(bandH, 0.1), 0.9);
  for (let top = 1 - h; top >= -1e-9; top -= step) {
    const t = Math.max(0, Math.round(top * 1000) / 1000);
    const overlaps = regions.some((r) => t < r.y + r.h && t + h > r.y);
    if (!overlaps) return { top: t, bottom: t + h >= 1 - 1e-9 };
  }
  return { top: 1 - h, bottom: true };
}
