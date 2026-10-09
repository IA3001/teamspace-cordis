DROP INDEX IF EXISTS idx_memories_source_kind;
DROP INDEX IF EXISTS idx_memories_source_event;
ALTER TABLE memories DROP COLUMN source_event_id;
