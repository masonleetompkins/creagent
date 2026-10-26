// Embedded job queue backed by SQLite. Single-worker, poll-based: good
// enough for a local single-user app, zero daemons.
import { randomUUID } from "node:crypto";
import { getDb, nowIso } from "./db";

export type JobState = "pending" | "running" | "completed" | "failed";

export type JobRow = {
  id: string;
  name: string;
  data: unknown;
  state: JobState;
  progress: unknown;
  result: unknown;
  failedReason: string | null;
  attempts: number;
  created_at: string;
  updated_at: string;
};

type RawJob = {
  id: string;
  name: string;
  data: string;
  state: JobState;
  progress: string | null;
  result: string | null;
  failed_reason: string | null;
  attempts: number;
  created_at: string;
  updated_at: string;
};

function parseJson(value: string | null): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function toJob(row: RawJob): JobRow {
  return {
    id: row.id,
    name: row.name,
    data: parseJson(row.data),
    state: row.state,
    progress: parseJson(row.progress),
    result: parseJson(row.result),
    failedReason: row.failed_reason,
    attempts: row.attempts ?? 0,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function enqueue(name: string, data: unknown): string {
  const id = randomUUID();
  const ts = nowIso();
  getDb()
    .prepare(
      `INSERT INTO jobs (id, name, data, state, created_at, updated_at)
       VALUES (?, ?, ?, 'pending', ?, ?)`,
    )
    .run(id, name, JSON.stringify(data ?? {}), ts, ts);
  return id;
}

export function getJob(id: string): JobRow | null {
  const row = getDb()
    .prepare(`SELECT * FROM jobs WHERE id = ?`)
    .get(id) as RawJob | undefined;
  return row ? toJob(row) : null;
}

export function claimNext(): JobRow | null {
  const db = getDb();
  db.exec("BEGIN IMMEDIATE");
  try {
    const row = db
      .prepare(
        `SELECT * FROM jobs WHERE state = 'pending'
         ORDER BY created_at ASC LIMIT 1`,
      )
      .get() as RawJob | undefined;
    if (!row) {
      db.exec("COMMIT");
      return null;
    }
    db.prepare(`UPDATE jobs SET state = 'running', updated_at = ? WHERE id = ?`).run(
      nowIso(),
      row.id,
    );
    db.exec("COMMIT");
    return toJob({ ...row, state: "running" });
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* already rolled back */
    }
    throw error;
  }
}

export function updateProgress(id: string, progress: unknown): void {
  getDb()
    .prepare(`UPDATE jobs SET progress = ?, updated_at = ? WHERE id = ?`)
    .run(JSON.stringify(progress ?? null), nowIso(), id);
}

export function completeJob(id: string, result: unknown): void {
  getDb()
    .prepare(
      `UPDATE jobs SET state = 'completed', result = ?, updated_at = ? WHERE id = ?`,
    )
    .run(JSON.stringify(result ?? null), nowIso(), id);
}

export function failJob(id: string, reason: string): void {
  getDb()
    .prepare(
      `UPDATE jobs SET state = 'failed', failed_reason = ?, updated_at = ? WHERE id = ?`,
    )
    .run(reason.slice(0, 2000), nowIso(), id);
}

// Stale-claim reaper: jobs stuck in 'running' past the timeout are
// presumed crashed. They return to pending (attempts+1) until the retry
// budget is spent, then fail permanently.
const STALE_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 3;

export function reapStaleJobs(): { requeued: number; failed: number } {
  const db = getDb();
  const cutoff = new Date(Date.now() - STALE_MS).toISOString();
  const stale = db
    .prepare(`SELECT * FROM jobs WHERE state = 'running' AND updated_at < ?`)
    .all(cutoff) as RawJob[];
  let requeued = 0;
  let failed = 0;
  for (const job of stale) {
    const attempts = (job.attempts ?? 0) + 1;
    if (attempts >= MAX_ATTEMPTS) {
      db.prepare(
        `UPDATE jobs SET state = 'failed', failed_reason = ?, attempts = ?, updated_at = ? WHERE id = ?`,
      ).run("worker died repeatedly; retry budget spent", attempts, nowIso(), job.id);
      failed++;
    } else {
      db.prepare(
        `UPDATE jobs SET state = 'pending', attempts = ?, updated_at = ? WHERE id = ?`,
      ).run(attempts, nowIso(), job.id);
      requeued++;
    }
  }
  return { requeued, failed };
}

export function checkQueue(): { ok: boolean; error?: string } {
  try {
    getDb()
      .prepare("SELECT COUNT(*) AS n FROM jobs")
      .get();
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
