-- 025: permanently hidden library photos. Uploads are deleted from
-- disk; ingested URLs can't be removed from their asset, so the hide
-- list keeps them out of the library (and the vision scan) forever.
CREATE TABLE IF NOT EXISTS photo_hidden (
  url TEXT PRIMARY KEY,
  created_at TEXT NOT NULL
);
