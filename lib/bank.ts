// Option bank: non-winning draft options the user saves for later, then
// placed into upcoming red slots spaced a few days apart. Matching is pure
// code: same content type required, pillar match + platform overlap
// preferred, 72h minimum between auto-placements.
import { randomUUID } from "node:crypto";
import { getDb, nowIso } from "./db";
import { saveDraft, type DraftStructure } from "./drafting";

export type BankRow = {
  id: string;
  body: string;
  label: string;
  pillar_id: string | null;
  content_type: string;
  platforms: string;
  source_draft_id: string | null;
  status: string;
  placed_slot_id: string | null;
  created_at: string;
};

type RedSlot = {
  id: string;
  scheduled_at: string;
  pillar_id: string | null;
  content_type: string;
  platforms: string;
};

const GAP_MS = 72 * 3600 * 1000;

function parsePlatforms(raw: string | null | undefined): string[] {
  try {
    const parsed = JSON.parse(raw || "[]") as unknown;
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function asStructure(raw: string | null): { options: Array<{ label?: unknown; body?: unknown }> } | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) return null;
    const options = (parsed as { options?: unknown }).options;
    if (!Array.isArray(options)) return null;
    return { options: options as Array<{ label?: unknown; body?: unknown }> };
  } catch {
    return null;
  }
}

export function bankOption(draftId: string, index: number): string {
  const db = getDb();
  const draft = db
    .prepare(
      `SELECT d.id, d.kind, d.body, d.structure, s.pillar_id, s.content_type, s.platforms
       FROM drafts d JOIN queue_slots s ON s.id = d.slot_id WHERE d.id = ?`,
    )
    .get(draftId) as
    | {
        id: string;
        kind: string;
        body: string;
        structure: string | null;
        pillar_id: string | null;
        content_type: string;
        platforms: string;
      }
    | undefined;
  if (!draft) throw new Error("draft not found");
  const parsed = asStructure(draft.structure);
  const opt = parsed?.options[index];
  const body = typeof opt?.body === "string" ? opt.body.trim() : "";
  if (!body) throw new Error("option not found on this draft");
  const label = typeof opt?.label === "string" ? opt.label : `Option ${index + 1}`;
  // Hooks bank with their thread body so the placed slot stays complete.
  let banked = body;
  if (draft.content_type === "thread") {
    try {
      const threadBody = (JSON.parse(draft.structure as string) as { body?: unknown }).body;
      if (typeof threadBody === "string" && threadBody.trim()) {
        banked = `${body}\n\n${threadBody.trim()}`;
      }
    } catch {
      /* hook alone is still bankable */
    }
  }
  const existing = db
    .prepare(`SELECT id FROM option_bank WHERE source_draft_id = ? AND label = ? AND status = 'banked'`)
    .get(draftId, label) as { id: string } | undefined;
  if (existing) return existing.id;
  const id = randomUUID();
  db.prepare(
    `INSERT INTO option_bank (id, body, label, pillar_id, content_type, platforms, source_draft_id, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'banked', ?)`,
  ).run(id, banked, label, draft.pillar_id, draft.content_type, draft.platforms, draftId, nowIso());
  return id;
}

export function unbankOption(id: string): boolean {
  const info = getDb()
    .prepare(`DELETE FROM option_bank WHERE id = ? AND status = 'banked'`)
    .run(id);
  return Number(info.changes) > 0;
}

export function bankedCount(): number {
  return (
    getDb().prepare(`SELECT COUNT(*) AS n FROM option_bank WHERE status = 'banked'`).get() as {
      n: number;
    }
  ).n;
}

// Pure placement planner, oldest-banked first. Greedy by slot time with the
// 72h gap enforced across the run's own placements.
export function planBankFill(
  banked: Array<{ id: string; pillar_id: string | null; content_type: string; platforms: string }>,
  redSlots: RedSlot[],
): Array<{ bankId: string; slotId: string }> {
  const taken = new Set<string>();
  const placedAt: number[] = [];
  const out: Array<{ bankId: string; slotId: string }> = [];
  for (const item of banked) {
    const wantPlats = parsePlatforms(item.platforms);
    const candidates = redSlots
      .filter((s) => !taken.has(s.id) && s.content_type === item.content_type)
      .map((s) => {
        const overlap = parsePlatforms(s.platforms).filter((p) => wantPlats.includes(p)).length;
        return {
          slot: s,
          pillarHit: s.pillar_id !== null && s.pillar_id === item.pillar_id ? 1 : 0,
          overlap,
          time: Date.parse(s.scheduled_at),
        };
      })
      .filter((c) => !Number.isNaN(c.time))
      .sort(
        (a, b) => b.pillarHit - a.pillarHit || b.overlap - a.overlap || a.time - b.time,
      );
    const pick = candidates.find((c) => placedAt.every((t) => Math.abs(c.time - t) >= GAP_MS));
    if (!pick) continue;
    taken.add(pick.slot.id);
    placedAt.push(pick.time);
    out.push({ bankId: item.id, slotId: pick.slot.id });
  }
  return out;
}

export function fillBanked(): { placed: number; skipped: number } {
  const db = getDb();
  const banked = db
    .prepare(
      `SELECT id, pillar_id, content_type, platforms FROM option_bank
       WHERE status = 'banked' ORDER BY created_at ASC`,
    )
    .all() as Array<{ id: string; pillar_id: string | null; content_type: string; platforms: string }>;
  if (banked.length === 0) return { placed: 0, skipped: 0 };
  const redSlots = db
    .prepare(
      `SELECT s.id, s.scheduled_at, s.pillar_id, s.content_type, s.platforms FROM queue_slots s
       WHERE s.status = 'red' AND NOT EXISTS (SELECT 1 FROM drafts d WHERE d.slot_id = s.id)
       ORDER BY s.scheduled_at ASC`,
    )
    .all() as RedSlot[];
  const plan = planBankFill(banked, redSlots);
  const planned = new Set(plan.map((p) => p.bankId));
  let placed = 0;
  for (const p of plan) {
    const row = db.prepare(`SELECT body, label FROM option_bank WHERE id = ?`).get(p.bankId) as {
      body: string;
      label: string;
    };
    const structure: DraftStructure = { layout: "prose", options: [{ label: row.label || "Draft", body: row.body }] };
    const slot = db.prepare(`SELECT content_type FROM queue_slots WHERE id = ?`).get(p.slotId) as {
      content_type: string;
    };
    saveDraft(p.slotId, slot.content_type, row.body, structure);
    db.prepare(`UPDATE option_bank SET status = 'placed', placed_slot_id = ? WHERE id = ?`).run(
      p.slotId,
      p.bankId,
    );
    placed++;
  }
  return { placed, skipped: banked.length - placed };
}
