CREATE TABLE IF NOT EXISTS file_attachments (
  stored_name TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  uploader_id TEXT NOT NULL,
  original_name TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_file_attachments_session ON file_attachments(session_id, created_at);

-- Keep legacy timeline attachments available only to members of their session.
INSERT OR IGNORE INTO file_attachments(stored_name, session_id, uploader_id, original_name, size_bytes, created_at)
SELECT substr(substr(text, instr(text, char(10)) + 1), 14), session_id, coalesce(author_id, ''),
  substr(substr(text, instr(text, char(10)) + 1), 51), 0, ts
FROM events
WHERE text LIKE '[文件]%' AND instr(text, char(10)) > 0
  AND substr(substr(text, instr(text, char(10)) + 1), 1, 13) = '/api/uploads/'
  AND substr(substr(text, instr(text, char(10)) + 1), 14) NOT LIKE '%/%'
  AND substr(substr(text, instr(text, char(10)) + 1), 14) NOT LIKE '%..%';
