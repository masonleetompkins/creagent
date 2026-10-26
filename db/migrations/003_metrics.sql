-- 003: post metrics, slot attachments (upload fallback), sync cursors.
CREATE TABLE IF NOT EXISTS post_metrics (
  id TEXT PRIMARY KEY,
  asset_id TEXT REFERENCES assets(id) ON DELETE SET NULL,
  platform TEXT NOT NULL,
  post_url TEXT,
  likes INTEGER,
  comments INTEGER,
  shares INTEGER,
  views INTEGER,
  posted_at TEXT,
  collected_at TEXT NOT NULL,
  raw TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS post_metrics_platform_idx ON post_metrics (platform, collected_at);

CREATE TABLE IF NOT EXISTS slot_attachments (
  id TEXT PRIMARY KEY,
  slot_id TEXT NOT NULL REFERENCES queue_slots(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'file',
  filename TEXT NOT NULL,
  mime TEXT NOT NULL DEFAULT 'application/octet-stream',
  size INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  CONSTRAINT slot_attachments_kind_check CHECK (kind IN ('image', 'video', 'file'))
);

CREATE INDEX IF NOT EXISTS slot_attachments_slot_idx ON slot_attachments (slot_id);

CREATE TABLE IF NOT EXISTS sync_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
