-- Track the event that produced a memory so recalled or withdrawn information
-- can be traced and invalidated without searching free-form memory text.
ALTER TABLE memories ADD COLUMN source_event_id TEXT;
CREATE INDEX IF NOT EXISTS idx_memories_source_event
  ON memories(source_event_id) WHERE source_event_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_memories_source_kind
  ON memories(scope, kind, source_event_id) WHERE source_event_id IS NOT NULL;
