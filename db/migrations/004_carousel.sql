-- 004: carousel projects and slides.
CREATE TABLE IF NOT EXISTS carousel_projects (
  id TEXT PRIMARY KEY,
  slot_id TEXT REFERENCES queue_slots(id) ON DELETE SET NULL,
  title TEXT NOT NULL DEFAULT 'Untitled carousel',
  primary_color TEXT NOT NULL DEFAULT '#0b5fff',
  secondary_color TEXT NOT NULL DEFAULT '#111111',
  background_color TEXT NOT NULL DEFAULT '#ffffff',
  heading_font TEXT NOT NULL DEFAULT 'system-black',
  body_font TEXT NOT NULL DEFAULT 'system',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS carousel_slides (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES carousel_projects(id) ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 0,
  layout TEXT NOT NULL DEFAULT 'content',
  heading TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  image_path TEXT,
  image_source TEXT,
  image_prompt TEXT,
  created_at TEXT NOT NULL,
  CONSTRAINT carousel_slides_layout_check CHECK (layout IN ('cover', 'content', 'photo', 'cta'))
);

CREATE INDEX IF NOT EXISTS carousel_slides_project_idx ON carousel_slides (project_id, position);
CREATE INDEX IF NOT EXISTS carousel_projects_slot_idx ON carousel_projects (slot_id);
