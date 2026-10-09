-- 0014_agent_catalog —— team-shared, data-driven Agent definitions.
--
-- Definitions deliberately have no creator/owner column: every Team member
-- shares the Agent catalog. Session membership is stored separately.
CREATE TABLE IF NOT EXISTS agent_definitions (
    id               TEXT PRIMARY KEY,
    title            TEXT NOT NULL COLLATE NOCASE UNIQUE,
    description      TEXT NOT NULL,
    prompt_ref       TEXT NOT NULL DEFAULT '',
    model_ref        TEXT NOT NULL DEFAULT '',
    tool_ids         TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(tool_ids)),
    context_sources  TEXT NOT NULL DEFAULT '["session","agent-memory","team-kb"]' CHECK (json_valid(context_sources)),
    memory_policy    TEXT NOT NULL DEFAULT 'agent',
    speech_policy    TEXT NOT NULL DEFAULT 'passive',
    status           TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
    created_at       TEXT NOT NULL,
    updated_at       TEXT NOT NULL
);
