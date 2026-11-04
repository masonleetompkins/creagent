-- Separate post-caption block for media drafts (carousel + video): the
-- draft body stays the outline/script, the caption ships with the upload.
-- approved_media pins which finished video a slot uploads (NULL = auto).
ALTER TABLE drafts ADD COLUMN caption TEXT;
ALTER TABLE queue_slots ADD COLUMN approved_media TEXT;
