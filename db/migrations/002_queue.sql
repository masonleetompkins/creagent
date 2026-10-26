-- 002: job retry attempts + weekly queue templates (posting cadence).
ALTER TABLE jobs ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS queue_templates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  weekday INTEGER NOT NULL,
  time TEXT NOT NULL,
  pillar_id TEXT REFERENCES pillars(id) ON DELETE SET NULL,
  content_type TEXT NOT NULL,
  platforms TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  CONSTRAINT queue_templates_weekday_check CHECK (weekday >= 0 AND weekday <= 6)
);

CREATE INDEX IF NOT EXISTS queue_templates_day_idx ON queue_templates (weekday, time);
