-- Per-slide background override. NULL/'' follows the kit background;
-- a #rrggbb value paints the slide flat; 'gradient' blends primary to
-- secondary. The renderer picks readable ink from the resolved color.
ALTER TABLE carousel_slides ADD COLUMN background TEXT;
