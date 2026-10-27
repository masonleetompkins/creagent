-- 010: chat cost tracking, message compaction flag, pillar confirmation,
-- plus a second posted_at backfill for provider date keys the first
-- pass missed (createdUtc, createdTime, ...).
ALTER TABLE agent_chats ADD COLUMN prompt_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE agent_chats ADD COLUMN completion_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE agent_chats ADD COLUMN last_context_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE agent_messages ADD COLUMN compacted INTEGER NOT NULL DEFAULT 0;
ALTER TABLE pillars ADD COLUMN confirmed INTEGER NOT NULL DEFAULT 0;
UPDATE assets SET posted_at = COALESCE(
  CASE WHEN typeof(json_extract(metadata,'$.raw.createdUtc')) IN ('integer','real') THEN strftime('%Y-%m-%dT%H:%M:%fZ', CASE WHEN json_extract(metadata,'$.raw.createdUtc') > 100000000000 THEN json_extract(metadata,'$.raw.createdUtc')/1000.0 ELSE json_extract(metadata,'$.raw.createdUtc') END, 'unixepoch') END,
  CASE WHEN typeof(json_extract(metadata,'$.raw.created_utc')) IN ('integer','real') THEN strftime('%Y-%m-%dT%H:%M:%fZ', CASE WHEN json_extract(metadata,'$.raw.created_utc') > 100000000000 THEN json_extract(metadata,'$.raw.created_utc')/1000.0 ELSE json_extract(metadata,'$.raw.created_utc') END, 'unixepoch') END,
  CASE WHEN typeof(json_extract(metadata,'$.raw.createTime')) IN ('integer','real') THEN strftime('%Y-%m-%dT%H:%M:%fZ', CASE WHEN json_extract(metadata,'$.raw.createTime') > 100000000000 THEN json_extract(metadata,'$.raw.createTime')/1000.0 ELSE json_extract(metadata,'$.raw.createTime') END, 'unixepoch') END,
  CASE WHEN typeof(json_extract(metadata,'$.raw.create_time')) IN ('integer','real') THEN strftime('%Y-%m-%dT%H:%M:%fZ', CASE WHEN json_extract(metadata,'$.raw.create_time') > 100000000000 THEN json_extract(metadata,'$.raw.create_time')/1000.0 ELSE json_extract(metadata,'$.raw.create_time') END, 'unixepoch') END,
  CASE WHEN typeof(json_extract(metadata,'$.raw.timestamp')) IN ('integer','real') THEN strftime('%Y-%m-%dT%H:%M:%fZ', CASE WHEN json_extract(metadata,'$.raw.timestamp') > 100000000000 THEN json_extract(metadata,'$.raw.timestamp')/1000.0 ELSE json_extract(metadata,'$.raw.timestamp') END, 'unixepoch') END,
  CASE WHEN typeof(json_extract(metadata,'$.raw.taken_at')) IN ('integer','real') THEN strftime('%Y-%m-%dT%H:%M:%fZ', CASE WHEN json_extract(metadata,'$.raw.taken_at') > 100000000000 THEN json_extract(metadata,'$.raw.taken_at')/1000.0 ELSE json_extract(metadata,'$.raw.taken_at') END, 'unixepoch') END,
  json_extract(metadata, '$.raw.createdTime'),
  json_extract(metadata, '$.raw.created_time')
) WHERE posted_at IS NULL;
