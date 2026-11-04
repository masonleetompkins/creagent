-- 024: forbidden-text regions per library photo. Fractions of photo
-- width/height (0-1) so they survive resizes; the renderer keeps text
-- clear of them and the agent sees them when placing copy.
CREATE TABLE IF NOT EXISTS photo_regions (
  id TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  x REAL NOT NULL,
  y REAL NOT NULL,
  w REAL NOT NULL,
  h REAL NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  CONSTRAINT photo_regions_bounds_check CHECK (x >= 0 AND y >= 0 AND w > 0 AND h > 0 AND x + w <= 1 AND y + h <= 1)
);
CREATE INDEX IF NOT EXISTS photo_regions_url_idx ON photo_regions (url);
