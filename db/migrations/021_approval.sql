-- 021: approvals pin the shipped post — latest version's picked option.
ALTER TABLE queue_slots ADD COLUMN approved_draft_id TEXT REFERENCES drafts(id) ON DELETE SET NULL;
ALTER TABLE queue_slots ADD COLUMN approved_option INTEGER;
