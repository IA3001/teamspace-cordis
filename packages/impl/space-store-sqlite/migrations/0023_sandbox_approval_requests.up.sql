CREATE TABLE IF NOT EXISTS sandbox_approval_requests (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  session_id TEXT,
  source_path TEXT NOT NULL,
  source_size INTEGER NOT NULL,
  source_mtime_ms REAL NOT NULL,
  source_ctime_ms REAL NOT NULL,
  source_inode INTEGER NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected')),
  created_at TEXT NOT NULL,
  decided_at TEXT,
  decided_by TEXT,
  decision_note TEXT NOT NULL DEFAULT '',
  delivery_path TEXT
);
CREATE INDEX IF NOT EXISTS idx_sandbox_approval_status_created ON sandbox_approval_requests(status, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_sandbox_approval_pending_dedupe
  ON sandbox_approval_requests(agent_id, ifnull(session_id, ''), source_path) WHERE status = 'pending';
