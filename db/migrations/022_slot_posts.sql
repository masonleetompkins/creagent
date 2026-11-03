-- 022: published-post receipts. One row per slot/platform/attempt, written
-- as 'sending' before the POST so a dead retry reuses the same idempotency
-- key instead of double-posting.
CREATE TABLE IF NOT EXISTS slot_posts (
  id TEXT PRIMARY KEY,
  slot_id TEXT NOT NULL REFERENCES queue_slots(id) ON DELETE CASCADE,
  attempt INTEGER NOT NULL,
  idempotency_key TEXT NOT NULL,
  zernio_post_id TEXT,
  platform TEXT NOT NULL,
  account_id TEXT NOT NULL,
  username TEXT NOT NULL DEFAULT '',
  payload TEXT NOT NULL DEFAULT 'post',
  status TEXT NOT NULL,
  post_url TEXT,
  error TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_slot_posts_slot ON slot_posts(slot_id);
