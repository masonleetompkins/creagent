// Queue planner: keep N days of slots materialized from weekly templates,
// and roll overdue slots forward to their next matching occurrence.
import { randomUUID } from "node:crypto";
import { getDb, nowIso } from "./db";

export type PlannerResult = {
  created: number;
  rolled: number;
  stuck: number;
};

type TemplateRow = {
  id: string;
  name: string;
  weekday: number;
  time: string;
  pillar_id: string | null;
  content_type: string;
  platforms: string;
};

type SlotRow = {
  id: string;
  scheduled_at: string;
  pillar_id: string | null;
  content_type: string;
  status: string;
};

function occurrenceIso(day: Date, time: string): string {
  const [h, m] = time.split(":").map((n) => Number(n));
  const d = new Date(day);
  d.setHours(Number.isFinite(h) ? h : 9, Number.isFinite(m) ? m : 0, 0, 0);
  return d.toISOString();
}

function nextOccurrence(
  templates: TemplateRow[],
  pillarId: string | null,
  contentType: string,
  from: Date,
): string | null {
  const strict = templates.filter(
    (t) => t.content_type === contentType && t.pillar_id === pillarId,
  );
  const loose = templates.filter((t) => t.content_type === contentType);
  for (const pool of [strict, loose]) {
    if (pool.length === 0) continue;
    for (let ahead = 0; ahead < 15; ahead++) {
      const day = new Date(from);
      day.setDate(day.getDate() + ahead);
      const matches = pool
        .filter((t) => t.weekday === day.getDay())
        .map((t) => ({ t, iso: occurrenceIso(day, t.time) }))
        .filter((o) => o.iso > from.toISOString())
        .sort((a, b) => (a.iso < b.iso ? -1 : 1));
      if (matches.length > 0) return matches[0].iso;
    }
  }
  return null;
}

export function runPlanner(days = 14): PlannerResult {
  const db = getDb();
  const templates = db
    .prepare(`SELECT * FROM queue_templates ORDER BY weekday, time`)
    .all() as TemplateRow[];
  let created = 0;
  let rolled = 0;
  let stuck = 0;

  const findSlot = db.prepare(
    `SELECT id FROM queue_slots
     WHERE scheduled_at = ? AND content_type = ?
       AND ((pillar_id IS NULL AND ? IS NULL) OR pillar_id = ?)
       AND status != 'gray' LIMIT 1`,
  );
  const insertSlot = db.prepare(
    `INSERT INTO queue_slots (id, scheduled_at, pillar_id, content_type, platforms, status, brief, created_at)
     VALUES (?, ?, ?, ?, ?, 'red', ?, ?)`,
  );

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  for (let ahead = 0; ahead < days; ahead++) {
    const day = new Date(today);
    day.setDate(day.getDate() + ahead);
    for (const t of templates) {
      if (t.weekday !== day.getDay()) continue;
      const iso = occurrenceIso(day, t.time);
      if (iso <= new Date().toISOString() && ahead === 0) continue;
      const existing = findSlot.get(iso, t.content_type, t.pillar_id, t.pillar_id) as
        | { id: string }
        | undefined;
      if (existing) continue;
      insertSlot.run(
        randomUUID(),
        iso,
        t.pillar_id,
        t.content_type,
        t.platforms,
        JSON.stringify({ template_id: t.id }),
        nowIso(),
      );
      created++;
    }
  }

  // Rollover: overdue red/orange slots move to their next matching occurrence.
  const overdue = db
    .prepare(
      `SELECT id, scheduled_at, pillar_id, content_type, status FROM queue_slots
       WHERE scheduled_at < ? AND status IN ('red', 'orange')`,
    )
    .all(new Date().toISOString()) as SlotRow[];
  const moveSlot = db.prepare(`UPDATE queue_slots SET scheduled_at = ? WHERE id = ?`);
  for (const slot of overdue) {
    const next = nextOccurrence(templates, slot.pillar_id, slot.content_type, new Date());
    if (next) {
      moveSlot.run(next, slot.id);
      rolled++;
    } else {
      stuck++;
    }
  }

  return { created, rolled, stuck };
}
