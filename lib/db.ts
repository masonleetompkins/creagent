// Embedded SQLite store. Zero daemons: the whole database is one file at
// ~/.config/creagent/data.sqlite (override with SQLITE_PATH).
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export function sqlitePath(): string {
  return (
    process.env.SQLITE_PATH ??
    join(homedir(), ".config", "creagent", "data.sqlite")
  );
}

let db: DatabaseSync | null = null;

export function getDb(): DatabaseSync {
  if (!db) {
    const path = sqlitePath();
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    db = new DatabaseSync(path);
    db.exec(
      "PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;",
    );
  }
  return db;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function getSyncState(key: string): string | null {
  const row = getDb().prepare(`SELECT value FROM sync_state WHERE key = ?`).get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

export function setSyncState(key: string, value: string): void {
  getDb()
    .prepare(
      `INSERT INTO sync_state (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .run(key, value, nowIso());
}

export function clearSyncState(key: string): void {
  getDb().prepare(`DELETE FROM sync_state WHERE key = ?`).run(key);
}

export function checkDb(): { ok: boolean; error?: string } {
  try {
    getDb()
      .prepare("SELECT 1 AS ok")
      .get();
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

// node:sqlite has no transaction helper, so this is the shared one.
export function withTransaction<T>(fn: () => T): T {
  const conn = getDb();
  conn.exec("BEGIN IMMEDIATE");
  try {
    const out = fn();
    conn.exec("COMMIT");
    return out;
  } catch (error) {
    try {
      conn.exec("ROLLBACK");
    } catch {
      /* already rolled back */
    }
    throw error;
  }
}
