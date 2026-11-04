-- 023: admit audience vault docs (SQLite can't ALTER a CHECK, so the
-- table is rebuilt with the widened list).
CREATE TABLE vault_docs_new (
  id TEXT PRIMARY KEY,
  doc_type TEXT NOT NULL,
  title TEXT,
  body TEXT NOT NULL,
  embedding BLOB,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  CONSTRAINT vault_docs_type_check CHECK (doc_type IN ('qa', 'principle', 'quote', 'pillar', 'metric', 'voice', 'audience'))
);
INSERT INTO vault_docs_new SELECT id, doc_type, title, body, embedding, metadata, created_at FROM vault_docs;
DROP TABLE vault_docs;
ALTER TABLE vault_docs_new RENAME TO vault_docs;
CREATE INDEX vault_docs_type_idx ON vault_docs (doc_type);
