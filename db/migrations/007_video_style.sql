-- 007: video style guide + export history.
ALTER TABLE video_projects ADD COLUMN style TEXT NOT NULL DEFAULT '{}';

CREATE TABLE IF NOT EXISTS video_exports (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES video_projects(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  fps REAL NOT NULL,
  captions INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS video_exports_project_idx ON video_exports (project_id, created_at);
