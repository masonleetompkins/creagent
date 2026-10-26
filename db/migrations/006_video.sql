-- 006: video editor - projects, media, tracks, clips, transcripts, takes,
-- captions, review notes, audio library.
CREATE TABLE IF NOT EXISTS video_projects (
  id TEXT PRIMARY KEY,
  slot_id TEXT REFERENCES queue_slots(id) ON DELETE SET NULL,
  title TEXT NOT NULL DEFAULT 'Untitled video',
  width INTEGER NOT NULL DEFAULT 1080,
  height INTEGER NOT NULL DEFAULT 1920,
  fps REAL NOT NULL DEFAULT 30,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS media_assets (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  path TEXT NOT NULL,
  filename TEXT NOT NULL,
  mime TEXT NOT NULL DEFAULT 'application/octet-stream',
  duration_ms INTEGER,
  width INTEGER,
  height INTEGER,
  fps REAL,
  has_audio INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  CONSTRAINT media_assets_kind_check CHECK (kind IN ('video', 'audio', 'image'))
);

CREATE INDEX IF NOT EXISTS media_assets_kind_idx ON media_assets (kind, created_at);

CREATE TABLE IF NOT EXISTS video_tracks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES video_projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  position INTEGER NOT NULL DEFAULT 0,
  muted INTEGER NOT NULL DEFAULT 0,
  hidden INTEGER NOT NULL DEFAULT 0,
  locked INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  CONSTRAINT video_tracks_kind_check CHECK (kind IN ('video', 'audio', 'caption', 'graphics', 'review'))
);

CREATE INDEX IF NOT EXISTS video_tracks_project_idx ON video_tracks (project_id, position);

CREATE TABLE IF NOT EXISTS video_clips (
  id TEXT PRIMARY KEY,
  track_id TEXT NOT NULL REFERENCES video_tracks(id) ON DELETE CASCADE,
  asset_id TEXT REFERENCES media_assets(id) ON DELETE SET NULL,
  name TEXT NOT NULL DEFAULT '',
  start_ms INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  in_ms INTEGER NOT NULL DEFAULT 0,
  speed REAL NOT NULL DEFAULT 1,
  transform TEXT NOT NULL DEFAULT '{}',
  payload TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS video_clips_track_idx ON video_clips (track_id, start_ms);

CREATE TABLE IF NOT EXISTS transcripts (
  id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL UNIQUE REFERENCES media_assets(id) ON DELETE CASCADE,
  lang TEXT NOT NULL DEFAULT 'en',
  full_text TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS transcript_words (
  id TEXT PRIMARY KEY,
  transcript_id TEXT NOT NULL REFERENCES transcripts(id) ON DELETE CASCADE,
  idx INTEGER NOT NULL,
  word TEXT NOT NULL,
  start_ms INTEGER NOT NULL,
  end_ms INTEGER NOT NULL,
  conf REAL
);

CREATE INDEX IF NOT EXISTS transcript_words_t_idx ON transcript_words (transcript_id, idx);

CREATE TABLE IF NOT EXISTS takes (
  id TEXT PRIMARY KEY,
  transcript_id TEXT NOT NULL REFERENCES transcripts(id) ON DELETE CASCADE,
  label TEXT NOT NULL DEFAULT '',
  start_ms INTEGER NOT NULL,
  end_ms INTEGER NOT NULL,
  text TEXT NOT NULL DEFAULT '',
  score REAL,
  verdict TEXT NOT NULL DEFAULT 'unsure',
  created_at TEXT NOT NULL,
  CONSTRAINT takes_verdict_check CHECK (verdict IN ('keep', 'cut', 'unsure'))
);

CREATE INDEX IF NOT EXISTS takes_transcript_idx ON takes (transcript_id, start_ms);

CREATE TABLE IF NOT EXISTS captions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES video_projects(id) ON DELETE CASCADE,
  track_id TEXT REFERENCES video_tracks(id) ON DELETE SET NULL,
  start_ms INTEGER NOT NULL,
  end_ms INTEGER NOT NULL,
  lines TEXT NOT NULL DEFAULT '[]',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS captions_project_idx ON captions (project_id, start_ms);

CREATE TABLE IF NOT EXISTS review_notes (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES video_projects(id) ON DELETE CASCADE,
  start_ms INTEGER NOT NULL,
  end_ms INTEGER NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL,
  CONSTRAINT review_notes_status_check CHECK (status IN ('open', 'done'))
);

CREATE INDEX IF NOT EXISTS review_notes_project_idx ON review_notes (project_id, start_ms);

CREATE TABLE IF NOT EXISTS audio_library (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  source TEXT NOT NULL,
  url TEXT,
  local_path TEXT,
  duration_ms INTEGER,
  license TEXT,
  created_at TEXT NOT NULL,
  CONSTRAINT audio_library_kind_check CHECK (kind IN ('sfx', 'music'))
);

CREATE INDEX IF NOT EXISTS audio_library_kind_idx ON audio_library (kind, created_at);
