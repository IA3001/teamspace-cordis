-- 0039_agent_workspace_publish — grant the generic coding Agent the controlled
-- tool that atomically publishes a complete personal project to team shared storage.
UPDATE agent_definitions
SET tool_ids = json_insert(tool_ids, '$[#]', 'tool.workspace.publish'),
    updated_at = '2026-10-16T00:00:00.000Z'
WHERE id = 'agent.coder'
  AND NOT EXISTS (
    SELECT 1 FROM json_each(agent_definitions.tool_ids)
    WHERE json_each.value = 'tool.workspace.publish'
  );
