-- 009: original post date on assets, for the historical calendar.
ALTER TABLE assets ADD COLUMN posted_at TEXT;
-- Best-effort backfill from the stored raw payload's common date keys.
UPDATE assets SET posted_at = COALESCE(
  json_extract(metadata, '$.raw.created_at'),
  json_extract(metadata, '$.raw.createdAt'),
  json_extract(metadata, '$.raw.published_at'),
  json_extract(metadata, '$.raw.publishedAt'),
  json_extract(metadata, '$.raw.date'),
  json_extract(metadata, '$.raw.timestamp'),
  json_extract(metadata, '$.raw.taken_at')
) WHERE posted_at IS NULL;
CREATE INDEX IF NOT EXISTS assets_posted_idx ON assets (posted_at);
