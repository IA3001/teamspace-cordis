ALTER TABLE kb_documents ADD COLUMN content TEXT NOT NULL DEFAULT '';
ALTER TABLE kb_documents ADD COLUMN folder_path TEXT NOT NULL DEFAULT '';

-- Existing chunks are ordered and contain the only retained copy of old content.
-- This is best-effort for legacy records because chunking may normalize whitespace.
UPDATE kb_documents
SET content = COALESCE((
  SELECT group_concat(text, char(10) || char(10))
  FROM (SELECT text FROM kb_chunks WHERE doc_id = kb_documents.id ORDER BY idx)
), '');

CREATE TABLE kb_folders (
  path TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  parent_path TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX idx_kb_folders_parent ON kb_folders(parent_path, name);
CREATE INDEX idx_kb_documents_folder ON kb_documents(folder_path, created_at DESC);
