-- Team-authored Agent starter templates; each save appends an immutable version.
CREATE TABLE IF NOT EXISTS agent_templates (
  id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  input TEXT NOT NULL CHECK (json_valid(input)),
  created_at TEXT NOT NULL,
  PRIMARY KEY (id, version)
);

CREATE INDEX IF NOT EXISTS idx_agent_templates_latest
  ON agent_templates(id, version DESC);
