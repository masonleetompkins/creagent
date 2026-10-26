// Approval-gated generation requests. The agent plans (creates requests);
// the user approves on the queue slot or in the editor; approval enqueues
// the real generation job. Nothing spends credits without a Yes.
import { randomUUID } from "node:crypto";
import { getDb, nowIso } from "./db";

export type GenRequest = {
  id: string;
  slot_id: string | null;
  project_id: string | null;
  slide_id: string | null;
  kind: string;
  prompt: string;
  status: string;
  created_at: string;
  decided_at: string | null;
};

export function createGenRequest(input: {
  slot_id?: string | null;
  project_id?: string | null;
  slide_id?: string | null;
  kind?: string;
  prompt: string;
}): GenRequest {
  const ts = nowIso();
  const row: GenRequest = {
    id: randomUUID(),
    slot_id: input.slot_id ?? null,
    project_id: input.project_id ?? null,
    slide_id: input.slide_id ?? null,
    kind: input.kind ?? "carousel_image",
    prompt: input.prompt,
    status: "pending",
    created_at: ts,
    decided_at: null,
  };
  getDb()
    .prepare(
      `INSERT INTO gen_requests (id, slot_id, project_id, slide_id, kind, prompt, status, created_at, decided_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      row.id, row.slot_id, row.project_id, row.slide_id, row.kind,
      row.prompt, row.status, row.created_at, row.decided_at,
    );
  return row;
}

export function pendingForSlide(slideId: string): GenRequest | null {
  return (
    (getDb()
      .prepare(
        `SELECT * FROM gen_requests WHERE slide_id = ? AND status = 'pending'
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(slideId) as GenRequest | undefined) ?? null
  );
}

export function listForSlot(slotId: string): GenRequest[] {
  return getDb()
    .prepare(
      `SELECT * FROM gen_requests WHERE slot_id = ?
       ORDER BY CASE status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END, created_at DESC
       LIMIT 50`,
    )
    .all(slotId) as GenRequest[];
}

export function listForProject(projectId: string): GenRequest[] {
  return getDb()
    .prepare(
      `SELECT * FROM gen_requests WHERE project_id = ?
       ORDER BY created_at DESC LIMIT 100`,
    )
    .all(projectId) as GenRequest[];
}

export function setRequestStatus(
  id: string,
  status: "approved" | "rejected" | "done",
): GenRequest | null {
  const db = getDb();
  const result = db
    .prepare(`UPDATE gen_requests SET status = ?, decided_at = ? WHERE id = ?`)
    .run(status, nowIso(), id);
  if (result.changes === 0) return null;
  return (db.prepare(`SELECT * FROM gen_requests WHERE id = ?`).get(id) as GenRequest | undefined) ?? null;
}

export function getRequest(id: string): GenRequest | null {
  return (
    (getDb().prepare(`SELECT * FROM gen_requests WHERE id = ?`).get(id) as
      | GenRequest
      | undefined) ?? null
  );
}
