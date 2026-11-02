ALTER TABLE assets ADD COLUMN pillar_id TEXT REFERENCES pillars(id) ON DELETE SET NULL;
ALTER TABLE assets ADD COLUMN multiplier REAL;
CREATE INDEX IF NOT EXISTS assets_pillar_idx ON assets (pillar_id);
