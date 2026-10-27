-- Chat sessions: manual ordering for the draggable rail.
ALTER TABLE agent_chats ADD COLUMN position INTEGER NOT NULL DEFAULT 0;
UPDATE agent_chats SET position = (
  SELECT COUNT(*) FROM agent_chats c2 WHERE c2.created_at > agent_chats.created_at
);
