// Slot file uploads: finished edits and graphics attach to queue slots
// until the video/image editors land. Files live under the config dir;
// only the DB id + extension form the disk name, so user filenames can
// never escape the uploads folder.
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { extname, join } from "node:path";
import { getDb, nowIso } from "./db";

export const MAX_UPLOAD_BYTES = 500 * 1024 * 1024;

export function uploadsDir(): string {
  const dir =
    process.env.UPLOADS_DIR ?? join(homedir(), ".config", "creagent", "uploads");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function diskName(id: string, original: string): string {
  const ext = extname(original).replace(/[^a-zA-Z0-9.]/g, "").slice(0, 10);
  return `${id}${ext}`;
}

export function attachmentPath(id: string): string | null {
  const row = getDb()
    .prepare(`SELECT id, filename FROM slot_attachments WHERE id = ?`)
    .get(id) as { id: string; filename: string } | undefined;
  if (!row) return null;
  return join(uploadsDir(), diskName(row.id, row.filename));
}

export function kindForMime(mime: string): "image" | "video" | "file" {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  return "file";
}

export type Attachment = {
  id: string;
  slot_id: string;
  kind: string;
  filename: string;
  mime: string;
  size: number;
  created_at: string;
};

export async function saveUpload(
  slotId: string,
  file: { name: string; type: string; size: number; arrayBuffer: () => Promise<ArrayBuffer> },
): Promise<Attachment> {
  const slot = getDb().prepare(`SELECT id FROM queue_slots WHERE id = ?`).get(slotId);
  if (!slot) throw new Error("slot not found");
  if (file.size > MAX_UPLOAD_BYTES) throw new Error("file is over the 500MB cap");
  const buf = Buffer.from(await file.arrayBuffer());
  const id = randomUUID();
  await writeFile(join(uploadsDir(), diskName(id, file.name || "file")), buf);
  const row: Attachment = {
    id,
    slot_id: slotId,
    kind: kindForMime(file.type || ""),
    filename: (file.name || "file").slice(0, 200),
    mime: file.type || "application/octet-stream",
    size: buf.length,
    created_at: nowIso(),
  };
  getDb()
    .prepare(
      `INSERT INTO slot_attachments (id, slot_id, kind, filename, mime, size, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(row.id, row.slot_id, row.kind, row.filename, row.mime, row.size, row.created_at);
  return row;
}

export function listAttachments(slotId: string): Attachment[] {
  return getDb()
    .prepare(
      `SELECT id, slot_id, kind, filename, mime, size, created_at
       FROM slot_attachments WHERE slot_id = ? ORDER BY created_at ASC`,
    )
    .all(slotId) as Attachment[];
}

export function getAttachment(id: string): Attachment | null {
  return (
    (getDb()
      .prepare(
        `SELECT id, slot_id, kind, filename, mime, size, created_at
         FROM slot_attachments WHERE id = ?`,
      )
      .get(id) as Attachment | undefined) ?? null
  );
}

export async function readAttachment(id: string): Promise<{ row: Attachment; data: Buffer }> {
  const row = getAttachment(id);
  if (!row) throw new Error("attachment not found");
  const data = await readFile(join(uploadsDir(), diskName(row.id, row.filename)));
  return { row, data };
}

export function deleteAttachment(id: string): boolean {
  const row = getAttachment(id);
  if (!row) return false;
  getDb().prepare(`DELETE FROM slot_attachments WHERE id = ?`).run(id);
  rmSync(join(uploadsDir(), diskName(row.id, row.filename)), { force: true });
  return true;
}

export function uploadsUsage(): { files: number; bytes: number } {
  const row = getDb()
    .prepare(`SELECT COUNT(*) AS files, COALESCE(SUM(size), 0) AS bytes FROM slot_attachments`)
    .get() as { files: number; bytes: number };
  return row;
}
