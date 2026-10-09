CREATE TABLE IF NOT EXISTS session_work_owners (
  process_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  owner TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (process_id, session_id, owner)
);
CREATE INDEX IF NOT EXISTS idx_session_work_owners_lease ON session_work_owners(expires_at);

CREATE TABLE IF NOT EXISTS session_work_queue (
  queue_id INTEGER PRIMARY KEY AUTOINCREMENT,
  process_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  owner TEXT NOT NULL,
  enqueued_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  UNIQUE (process_id, session_id, owner)
);
CREATE INDEX IF NOT EXISTS idx_session_work_queue_order ON session_work_queue(queue_id);
