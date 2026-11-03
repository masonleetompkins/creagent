-- 020: banked draft options. Non-winning options the user saves (right-click
-- in bank mode) wait here until placed into later red slots a few days apart.
CREATE TABLE IF NOT EXISTS option_bank (
  id TEXT PRIMARY KEY,
  body TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  pillar_id TEXT REFERENCES pillars(id) ON DELETE SET NULL,
  content_type TEXT NOT NULL,
  platforms TEXT NOT NULL DEFAULT '[]',
  source_draft_id TEXT REFERENCES drafts(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'banked',
  placed_slot_id TEXT REFERENCES queue_slots(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS option_bank_status_idx ON option_bank (status, created_at);
