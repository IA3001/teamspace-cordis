-- Archive/restore a team template family while retaining every immutable revision.
ALTER TABLE agent_templates ADD COLUMN status TEXT NOT NULL DEFAULT 'active'
  CHECK (status IN ('active', 'archived'));
