// Runs pending SQL migrations in db/migrations. Idempotent.
// Usage: npx tsx scripts/migrate.ts
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { closeDb, getDb, nowIso } from "../lib/db";

// Runs from the repo root (npm script / start.sh), so cwd-relative is correct.
const MIGRATIONS_DIR = join(process.cwd(), "db", "migrations");

// Returns the filenames applied. Quiet when there is nothing to do so the
// worker can call it every minute without spamming its log.
export function runMigrations(): string[] {
  const db = getDb();
  db.exec(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
      filename TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    )`,
  );
  const applied = new Set(
    (
      db.prepare("SELECT filename FROM schema_migrations").all() as Array<{
        filename: string;
      }>
    ).map((r) => r.filename),
  );
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  const newly: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(sql);
      db.prepare("INSERT INTO schema_migrations (filename, applied_at) VALUES (?, ?)").run(
        file,
        nowIso(),
      );
      db.exec("COMMIT");
      newly.push(file);
      console.log(`applied ${file}`);
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  return newly;
}

// CLI behavior (npx tsx scripts/migrate.ts); tests also import this module
// for its side effect. Library callers import runMigrations instead — but
// note the import itself still runs + closes, so callers must re-acquire.
try {
  runMigrations();
  console.log("migrations up to date");
} catch (error) {
  console.error(`migration failed: ${(error as Error).message}`);
  process.exit(1);
} finally {
  closeDb();
}
