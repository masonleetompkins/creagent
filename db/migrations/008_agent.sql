-- 008: agent chat persistence.
CREATE TABLE IF NOT EXISTS agent_chats (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT 'New chat',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_messages (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL REFERENCES agent_chats(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  tool_name TEXT,
  created_at TEXT NOT NULL,
  CONSTRAINT agent_messages_role_check CHECK (role IN ('user', 'assistant', 'tool'))
);

CREATE INDEX IF NOT EXISTS agent_messages_chat_idx ON agent_messages (chat_id, created_at);
