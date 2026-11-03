-- 019: code-assembled draft structure (fan-out options per draft) plus the
-- user's persisted pick. Structure is assembled in code from N single-purpose
-- model calls — never parsed out of one JSON blob.
ALTER TABLE drafts ADD COLUMN structure TEXT;
ALTER TABLE drafts ADD COLUMN selection TEXT;
