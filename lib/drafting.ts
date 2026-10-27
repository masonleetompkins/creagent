// Slot drafting: red slots get Meta-written drafts grounded in the vault,
// then flip to orange for review.
import { randomUUID } from "node:crypto";
import { CONTENT_TYPES, PLAYBOOK, type ContentType } from "./content";
import { getDb, nowIso } from "./db";
import { loadKeys } from "./keys";
import { getMetaClient, metaTextModel } from "./meta";
import { searchVault } from "./vault";

export type DraftResult = {
  drafted: number;
  skipped: number;
  failures: Array<{ slot: string; error: string }>;
};

type SlotRow = {
  id: string;
  scheduled_at: string;
  pillar_id: string | null;
  pillar_name: string | null;
  pillar_desc: string | null;
  content_type: string;
  platforms: string;
};

function guideFor(contentType: string): string {
  return PLAYBOOK[contentType] ?? "Write the content for this slot.";
}

async function draftOne(slot: SlotRow): Promise<void> {
  const metaKey = loadKeys().meta;
  if (!metaKey) throw new Error("save a Meta key in Settings first");
  const typeLabel =
    (CONTENT_TYPES as Record<string, { label: string }>)[slot.content_type]?.label ??
    slot.content_type;
  const pillarLine = slot.pillar_name
    ? `Pillar: ${slot.pillar_name}${slot.pillar_desc ? ` — ${slot.pillar_desc}` : ""}`
    : "Pillar: (none assigned)";
  const query = `${slot.pillar_name ?? ""} ${typeLabel} ${(slot.content_type as ContentType) ?? ""}`.trim();
  const hits = await searchVault(query || "voice", 5);
  const context =
    hits.length > 0
      ? hits.map((h) => `[${h.doc_type}] ${h.title ?? ""}\n${h.body}`).join("\n\n---\n\n")
      : "(vault is empty — write in a clear, confident creator voice)";

  const client = getMetaClient(metaKey);
  const resp = await client.responses.create(
    {
      model: metaTextModel(),
      input: `You are the creator's ghostwriter. Match their voice exactly from the VAULT CONTEXT.\n\n${pillarLine}\nContent type: ${typeLabel}\nPlatforms: ${slot.platforms}\n\n${guideFor(slot.content_type)}\n\nVAULT CONTEXT:\n${context}`,
      max_output_tokens: 3000,
    },
    { timeout: 120000 },
  );
  const body = resp.output_text.trim();
  if (!body) throw new Error("model returned an empty draft");
  saveDraft(slot.id, slot.content_type, body);
}

export function saveDraft(slotId: string, kind: string, body: string): string {
  const db = getDb();
  const id = randomUUID();
  db.prepare(
    `INSERT INTO drafts (id, slot_id, kind, body, status, created_at)
     VALUES (?, ?, ?, ?, 'draft', ?)`,
  ).run(id, slotId, kind, body, nowIso());
  db.prepare(`UPDATE queue_slots SET status = 'orange' WHERE id = ?`).run(slotId);
  return id;
}

function loadSlot(id: string): SlotRow | null {
  return (
    (getDb()
      .prepare(
        `SELECT s.id, s.scheduled_at, s.pillar_id, p.name AS pillar_name,
                p.description AS pillar_desc, s.content_type, s.platforms
         FROM queue_slots s LEFT JOIN pillars p ON p.id = s.pillar_id
         WHERE s.id = ?`,
      )
      .get(id) as SlotRow | undefined) ?? null
  );
}

function hasDrafts(slotId: string): boolean {
  const row = getDb()
    .prepare(`SELECT COUNT(*) AS n FROM drafts WHERE slot_id = ?`)
    .get(slotId) as { n: number };
  return row.n > 0;
}

export async function runDraftSlot(slotId: string): Promise<void> {
  const slot = loadSlot(slotId);
  if (!slot) throw new Error("slot not found");
  await draftOne(slot);
}

export async function runDraftAll(
  limit = 10,
  onProgress?: (done: number, total: number) => void,
): Promise<DraftResult> {
  const horizon = new Date(Date.now() + 14 * 24 * 3600 * 1000).toISOString();
  const slots = getDb()
    .prepare(
      `SELECT s.id, s.scheduled_at, s.pillar_id, p.name AS pillar_name,
              p.description AS pillar_desc, s.content_type, s.platforms
       FROM queue_slots s LEFT JOIN pillars p ON p.id = s.pillar_id
       WHERE s.status = 'red' AND s.scheduled_at <= ?
       ORDER BY s.scheduled_at ASC LIMIT ?`,
    )
    .all(horizon, Math.max(1, Math.min(limit, 25))) as SlotRow[];
  const out: DraftResult = { drafted: 0, skipped: 0, failures: [] };
  let done = 0;
  for (const slot of slots) {
    if (hasDrafts(slot.id)) {
      out.skipped++;
    } else {
      try {
        await draftOne(slot);
        out.drafted++;
      } catch (error) {
        out.failures.push({
          slot: slot.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    done++;
    if (onProgress) onProgress(done, slots.length);
  }
  return out;
}
