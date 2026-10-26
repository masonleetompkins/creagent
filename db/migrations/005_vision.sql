-- 005: photo vision tags + approval-gated generation requests.
CREATE TABLE IF NOT EXISTS photo_tags (
  id TEXT PRIMARY KEY,
  asset_id TEXT REFERENCES assets(id) ON DELETE SET NULL,
  url TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '[]',
  suggested TEXT NOT NULL DEFAULT '',
  embedding BLOB,
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS photo_tags_url_idx ON photo_tags (url);

CREATE TABLE IF NOT EXISTS gen_requests (
  id TEXT PRIMARY KEY,
  slot_id TEXT REFERENCES queue_slots(id) ON DELETE SET NULL,
  project_id TEXT REFERENCES carousel_projects(id) ON DELETE CASCADE,
  slide_id TEXT REFERENCES carousel_slides(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'carousel_image',
  prompt TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL,
  decided_at TEXT,
  CONSTRAINT gen_requests_status_check CHECK (status IN ('pending', 'approved', 'rejected', 'done'))
);

CREATE INDEX IF NOT EXISTS gen_requests_slot_idx ON gen_requests (slot_id, status);
CREATE INDEX IF NOT EXISTS gen_requests_slide_idx ON gen_requests (slide_id, status);
