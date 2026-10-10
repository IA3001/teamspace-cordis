-- Keep the immutable starter-template revision that was copied into each Agent.
ALTER TABLE agent_definitions ADD COLUMN template_id TEXT NOT NULL DEFAULT '';
ALTER TABLE agent_definitions ADD COLUMN template_version INTEGER NOT NULL DEFAULT 0 CHECK (template_version >= 0);
