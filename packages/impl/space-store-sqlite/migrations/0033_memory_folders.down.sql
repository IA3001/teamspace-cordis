DROP INDEX IF EXISTS idx_memories_folder;
DROP INDEX IF EXISTS idx_memory_folders_parent;
DROP TABLE IF EXISTS memory_folders;
ALTER TABLE memories DROP COLUMN folder_path;
