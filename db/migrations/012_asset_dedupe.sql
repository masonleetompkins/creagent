-- Cross-source dedupe + reply flagging for ingested assets.
ALTER TABLE assets ADD COLUMN is_reply INTEGER NOT NULL DEFAULT 0;
ALTER TABLE assets ADD COLUMN url_norm TEXT;
CREATE INDEX IF NOT EXISTS assets_urlnorm_idx ON assets (url_norm);
-- Best-effort backfill: only high-signal reply markers (key + non-null value).
UPDATE assets SET is_reply = 1 WHERE
  metadata GLOB '*"type":"replied_to"*'
  OR metadata GLOB '*in_reply_to_status_id*:[ ]*[1-9]*'
  OR metadata GLOB '*in_reply_to_id*:[ ]*"[a-zA-Z0-9]*';
