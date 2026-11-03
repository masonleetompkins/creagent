// Server-only approval resolution: an approval always ships the latest
// version's picked option. Both the PATCH route and the agent status tool
// pin through here so the done state has one source of truth.
import { getDb } from "./db";
import { clampSelection, parseStructure, splitLegacyOptions } from "./draft-structure";

export function resolveApproval(slotId: string): { draftId: string; optionIndex: number } | null {
  const row = getDb()
    .prepare(
      `SELECT id, body, structure, selection FROM drafts
       WHERE slot_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    )
    .get(slotId) as
    | { id: string; body: string; structure: string | null; selection: string | null }
    | undefined;
  if (!row) return null;
  const structure = parseStructure(row.structure);
  const count = structure?.options.length ?? splitLegacyOptions(row.body)?.length ?? 1;
  return { draftId: row.id, optionIndex: clampSelection(row.selection, count) };
}

export function pinApproval(slotId: string): void {
  const resolved = resolveApproval(slotId);
  getDb()
    .prepare(`UPDATE queue_slots SET approved_draft_id = ?, approved_option = ? WHERE id = ?`)
    .run(resolved?.draftId ?? null, resolved?.optionIndex ?? null, slotId);
}

export function clearApproval(slotId: string): void {
  getDb()
    .prepare(`UPDATE queue_slots SET approved_draft_id = NULL, approved_option = NULL WHERE id = ?`)
    .run(slotId);
}
