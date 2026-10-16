-- Remove only the capability added by this migration; preserve the Agent's other tools.
UPDATE agent_definitions
SET tool_ids = (
      SELECT json_group_array(value)
      FROM json_each(agent_definitions.tool_ids)
      WHERE value <> 'tool.workspace.publish'
    ),
    updated_at = '2026-10-16T00:00:00.000Z'
WHERE id = 'agent.coder'
  AND EXISTS (
    SELECT 1 FROM json_each(agent_definitions.tool_ids)
    WHERE json_each.value = 'tool.workspace.publish'
  );
