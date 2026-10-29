-- Video speech-transcript backfill support.
ALTER TABLE assets ADD COLUMN is_video INTEGER NOT NULL DEFAULT 0;
ALTER TABLE assets ADD COLUMN transcribed_at TEXT;
CREATE INDEX IF NOT EXISTS assets_transcribe_idx ON assets (is_video, transcribed_at);
-- Backfill: TikTok/YouTube assets are always video.
UPDATE assets SET is_video = 1 WHERE source LIKE '%tiktok%' OR source LIKE '%youtube%';
-- Instagram reels/video posts via media markers (LIKE is case-insensitive).
UPDATE assets SET is_video = 1 WHERE source LIKE '%instagram%' AND (
  metadata LIKE '%"mediaType":"%video%' OR metadata LIKE '%"mediaType":"%reel%' OR
  metadata LIKE '%"productType":"%clip%' OR metadata LIKE '%"productType":"%reel%' OR
  metadata LIKE '%videoUrl%' OR metadata LIKE '%"durationSeconds%'
);
-- Transcript-source ingests arrive already transcribed.
UPDATE assets SET transcribed_at = created_at WHERE source IN ('youtube_transcript', 'instagram_reel');
