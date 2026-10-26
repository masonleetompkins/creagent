-- 001: core tables for ingest, vault, pillars, queue, drafts, jobs.
-- SQLite dialect. IDs are UUID text generated in JS. Embeddings are 384-dim
-- float32 BLOBs (local MiniLM); similarity is computed in JS.

CREATE TABLE IF NOT EXISTS schema_migrations (
  filename TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS assets (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  source_url TEXT,
  kind TEXT NOT NULL DEFAULT 'unknown',
  title TEXT,
  transcript TEXT,
  metadata TEXT NOT NULL DEFAULT '{}',
  analyzed_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS vault_docs (
  id TEXT PRIMARY KEY,
  doc_type TEXT NOT NULL,
  title TEXT,
  body TEXT NOT NULL,
  embedding BLOB,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  CONSTRAINT vault_docs_type_check CHECK (doc_type IN ('qa', 'principle', 'quote', 'pillar', 'metric', 'voice'))
);

CREATE TABLE IF NOT EXISTS pillars (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS queue_slots (
  id TEXT PRIMARY KEY,
  scheduled_at TEXT NOT NULL,
  pillar_id TEXT REFERENCES pillars(id) ON DELETE SET NULL,
  content_type TEXT NOT NULL,
  platforms TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'red',
  brief TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  CONSTRAINT queue_slots_status_check CHECK (status IN ('red', 'orange', 'green', 'gray'))
);

CREATE TABLE IF NOT EXISTS drafts (
  id TEXT PRIMARY KEY,
  slot_id TEXT NOT NULL REFERENCES queue_slots(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  data TEXT NOT NULL DEFAULT '{}',
  state TEXT NOT NULL DEFAULT 'pending',
  progress TEXT,
  result TEXT,
  failed_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CONSTRAINT jobs_state_check CHECK (state IN ('pending', 'running', 'completed', 'failed'))
);

CREATE INDEX IF NOT EXISTS vault_docs_type_idx ON vault_docs (doc_type);
CREATE INDEX IF NOT EXISTS queue_slots_time_idx ON queue_slots (scheduled_at);
CREATE INDEX IF NOT EXISTS assets_analyzed_idx ON assets (analyzed_at);
CREATE INDEX IF NOT EXISTS jobs_state_idx ON jobs (state, created_at);
