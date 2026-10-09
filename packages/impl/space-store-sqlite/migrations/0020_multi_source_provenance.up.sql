-- Preserve complete event and memory provenance rather than a single source pointer.
CREATE TABLE IF NOT EXISTS event_sources (
  event_id TEXT NOT NULL,
  source_event_id TEXT NOT NULL,
  relation TEXT NOT NULL DEFAULT 'context',
  PRIMARY KEY (event_id, source_event_id),
  FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE,
  FOREIGN KEY (source_event_id) REFERENCES events(id) ON DELETE CASCADE
);
INSERT OR IGNORE INTO event_sources(event_id, source_event_id, relation)
  SELECT id, source_event_id, 'trigger' FROM events WHERE source_event_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_event_sources_source ON event_sources(source_event_id);

CREATE TABLE IF NOT EXISTS memory_sources (
  memory_id TEXT NOT NULL,
  source_event_id TEXT NOT NULL,
  PRIMARY KEY (memory_id, source_event_id),
  FOREIGN KEY (memory_id) REFERENCES memories(id) ON DELETE CASCADE,
  FOREIGN KEY (source_event_id) REFERENCES events(id) ON DELETE CASCADE
);
INSERT OR IGNORE INTO memory_sources(memory_id, source_event_id)
  SELECT id, source_event_id FROM memories WHERE source_event_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_memory_sources_source ON memory_sources(source_event_id);

ALTER TABLE memories ADD COLUMN invalidated_at TEXT;
CREATE INDEX IF NOT EXISTS idx_memories_active_scope
  ON memories(scope, created_at DESC) WHERE invalidated_at IS NULL;
