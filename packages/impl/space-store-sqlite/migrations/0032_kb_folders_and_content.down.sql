DROP INDEX IF EXISTS idx_kb_documents_folder;
DROP INDEX IF EXISTS idx_kb_folders_parent;
DROP TABLE IF EXISTS kb_folders;
ALTER TABLE kb_documents DROP COLUMN folder_path;
ALTER TABLE kb_documents DROP COLUMN content;
