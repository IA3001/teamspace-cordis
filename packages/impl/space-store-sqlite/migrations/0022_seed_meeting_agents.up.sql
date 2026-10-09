-- 0022_seed_meeting_agents — meeting-role Agents are shared catalog data too.
-- Orchestrator remains a system service; these are ordinary configurable Agents.
INSERT OR IGNORE INTO prompt_templates(ref, title, body, updated_at) VALUES
  (
    'prompt.analysis', '需求分析提示词',
    '你是团队的需求分析师。先复述目标与约束，再列出关键需求、未决问题和验收条件。区分已知事实与假设，不擅自补充需求。',
    '2026-10-09T00:00:00.000Z'
  ),
  (
    'prompt.challenge', '方案挑战提示词',
    '你是团队的方案挑战者。检查当前方案的隐含假设、反例、边界条件、失败路径和潜在副作用。针对风险给出可验证的问题或替代方案，不为了反对而反对。',
    '2026-10-09T00:00:00.000Z'
  );

INSERT OR IGNORE INTO agent_definitions(
    id, title, description, prompt_ref, model_ref, tool_ids, context_sources,
    memory_policy, speech_policy, status, created_at, updated_at
) VALUES
  (
    'a_analyst', '需求分析师', '拆解目标、约束、未决问题和验收条件，区分事实与假设。',
    'prompt.analysis', '', '["web.search"]',
    '["session","agent-memory","team-kb"]', 'agent', 'proactive', 'active',
    '2026-10-09T00:00:00.000Z', '2026-10-09T00:00:00.000Z'
  ),
  (
    'a_challenger', '挑战者', '检查方案假设、反例、边界条件、失败路径和副作用。',
    'prompt.challenge', '', '["web.search"]',
    '["session","agent-memory","team-kb"]', 'agent', 'passive', 'active',
    '2026-10-09T00:00:00.000Z', '2026-10-09T00:00:00.000Z'
  ),
  (
    'a_recorder', '会议记录官', '整理讨论结论、关键决策、责任人与下一步事项。',
    'prompt.minutes', '', '[]',
    '["session","agent-memory","team-kb"]', 'agent', 'passive', 'active',
    '2026-10-09T00:00:00.000Z', '2026-10-09T00:00:00.000Z'
  );
