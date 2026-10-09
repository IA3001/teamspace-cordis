DROP INDEX IF EXISTS idx_memories_active_scope;
ALTER TABLE memories DROP COLUMN invalidated_at;
DROP INDEX IF EXISTS idx_memory_sources_source;
DROP TABLE IF EXISTS memory_sources;
DROP INDEX IF EXISTS idx_event_sources_source;
DROP TABLE IF EXISTS event_sources;
