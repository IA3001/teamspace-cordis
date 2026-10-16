-- Grant the built-in coding Agent read-only current-session history search.
UPDATE agent_definitions
SET tool_ids = json_insert(tool_ids, '$[#]', 'tool.session.history-search'),
    updated_at = '2026-10-16T00:00:00.000Z'
WHERE id = 'agent.coder'
  AND NOT EXISTS (
    SELECT 1 FROM json_each(agent_definitions.tool_ids)
    WHERE json_each.value = 'tool.session.history-search'
  );
