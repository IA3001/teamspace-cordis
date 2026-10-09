-- Persist causal provenance separately from user-visible reply threading.
ALTER TABLE events ADD COLUMN source_event_id TEXT REFERENCES events(id);
CREATE INDEX IF NOT EXISTS idx_events_source_event ON events(source_event_id);
