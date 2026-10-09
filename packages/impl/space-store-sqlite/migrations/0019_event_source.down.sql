DROP INDEX IF EXISTS idx_events_source_event;
ALTER TABLE events DROP COLUMN source_event_id;
