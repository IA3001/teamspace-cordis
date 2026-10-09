-- 0021_seed_shared_agents — promote the built-in coding roles to ordinary
-- team-wide catalog data. The generic Agent registry/runtime owns execution.
-- INSERT OR IGNORE preserves any existing definition with these stable IDs.
INSERT OR IGNORE INTO agent_definitions(
    id, title, description, prompt_ref, model_ref, tool_ids, context_sources,
    memory_policy, speech_policy, status, created_at, updated_at
) VALUES
  (
    'agent.coder', '编码者', '检查任务相关代码，在个人工作区内实现并运行必要验证，汇报改动和结果。',
    'prompt.coding', '', '["tool.workspace.read","tool.workspace.write","tool.code.execute"]',
    '["session","agent-memory","team-kb"]', 'agent', 'proactive', 'active',
    '2026-10-09T00:00:00.000Z', '2026-10-09T00:00:00.000Z'
  ),
  (
    'agent.tester', '测试者', '围绕正常、边界和异常行为设计并运行可执行测试，明确通过标准。',
    'prompt.testing', '', '["tool.workspace.read","tool.code.execute"]',
    '["session","agent-memory","team-kb"]', 'agent', 'proactive', 'active',
    '2026-10-09T00:00:00.000Z', '2026-10-09T00:00:00.000Z'
  ),
  (
    'agent.reviewer', '代码审查者', '优先识别可复现缺陷、回归风险和验证缺口，并指出对应位置。',
    'prompt.review', '', '["tool.workspace.read"]',
    '["session","agent-memory","team-kb"]', 'agent', 'proactive', 'active',
    '2026-10-09T00:00:00.000Z', '2026-10-09T00:00:00.000Z'
  );
