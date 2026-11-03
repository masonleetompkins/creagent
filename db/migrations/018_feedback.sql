-- 018: per-draft feedback plus distilled style rules (the meta feedback
-- repo). Raw feedback is never injected into prompts; approvals distill it
-- into small scoped rules that drafting retrieves top-3.
CREATE TABLE IF NOT EXISTS draft_feedback (
  id TEXT PRIMARY KEY,
  slot_id TEXT NOT NULL REFERENCES queue_slots(id) ON DELETE CASCADE,
  draft_id TEXT REFERENCES drafts(id) ON DELETE SET NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS draft_feedback_slot_idx ON draft_feedback (slot_id);

CREATE TABLE IF NOT EXISTS style_rules (
  id TEXT PRIMARY KEY,
  pillar_id TEXT REFERENCES pillars(id) ON DELETE SET NULL,
  content_type TEXT,
  rule TEXT NOT NULL,
  uses INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS style_rules_scope_idx ON style_rules (pillar_id, content_type);
