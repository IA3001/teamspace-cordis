-- Give the built-in coding and testing Agents a controlled C++ compiler/runner.
-- Preserve team customizations and make the migration safe to retry.
UPDATE agent_definitions
SET tool_ids = json_insert(tool_ids, '$[#]', 'tool.workspace.run-cpp')
WHERE id IN ('agent.coder', 'agent.tester')
  AND json_valid(tool_ids)
  AND NOT EXISTS (
    SELECT 1 FROM json_each(agent_definitions.tool_ids)
    WHERE json_each.value = 'tool.workspace.run-cpp'
  );
