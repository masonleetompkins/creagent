-- Repair YouTube assets collapsed by the old normalizeUrl, which stripped
-- the ?v= query param and merged every youtube.com/watch URL into one row
-- (first video's text kept, the rest lost). Same-source merge evidence
-- (raw_<source> keys) marks affected rows. Safe to delete: YouTube ingest
-- is free and restores each video as its own asset on the next run.
-- Re-run YouTube ingest afterwards, then re-run analysis or Regenerate.
DELETE FROM assets WHERE
  (source = 'zernio_youtube' AND metadata LIKE '%raw\_zernio\_youtube%' ESCAPE '\')
  OR (source = 'youtube_transcript' AND metadata LIKE '%raw\_youtube\_transcript%' ESCAPE '\');
