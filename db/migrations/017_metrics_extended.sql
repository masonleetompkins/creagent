-- 017: extended reach/saves columns for Zernio analytics metrics.
ALTER TABLE post_metrics ADD COLUMN reach INTEGER;
ALTER TABLE post_metrics ADD COLUMN saves INTEGER;
