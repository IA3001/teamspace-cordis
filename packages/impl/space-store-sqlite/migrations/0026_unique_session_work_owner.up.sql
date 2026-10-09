-- A logical owner (for example orchestrator:<session-id>) may run only once
-- in a session, even when multiple application processes share the database.
DELETE FROM session_work_owners
WHERE EXISTS (
  SELECT 1 FROM session_work_owners AS newer
  WHERE newer.session_id = session_work_owners.session_id
    AND newer.owner = session_work_owners.owner
    AND (newer.expires_at > session_work_owners.expires_at OR
      (newer.expires_at = session_work_owners.expires_at AND newer.rowid > session_work_owners.rowid))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_session_work_owner_unique
  ON session_work_owners(session_id, owner);
