-- seed/0001_svc_session —— 演示会话 + 五名成员 + 三条事件。
--
-- 幂等（铁律 3 落地动作 6）：固定主键 + INSERT OR IGNORE，反复跑结果一致。
-- principals 表按待定 6 后置，principal_id 此阶段是自由字符串（约定前缀：
-- 人 "u_*" / Agent "a_*"，与旧系统一致）；身份域落地后自然对上名册。

INSERT OR IGNORE INTO sessions(id, title, current_phase, status, created_at, updated_at)
VALUES ('s_seed_demo', '演示会议（seed 生成）', NULL, 'open',
        '2026-09-27T00:00:00.000Z', '2026-09-27T00:00:00.000Z');

INSERT OR IGNORE INTO session_members(session_id, principal_id, role, status, joined_at, left_at, duty)
VALUES
  ('s_seed_demo', 'u_dri',        'DRI',        'active', '2026-09-27T00:00:00.000Z', NULL, '决策与审批'),
  ('s_seed_demo', 'a_analyst',    '需求分析师', 'active', '2026-09-27T00:00:00.000Z', NULL, ''),
  ('s_seed_demo', 'a_challenger', '挑战者',     'active', '2026-09-27T00:00:00.000Z', NULL, ''),
  ('s_seed_demo', 'a_recorder',   '会议记录官', 'active', '2026-09-27T00:00:00.000Z', NULL, ''),
  ('s_seed_demo', 'a_coordinator','协调者',     'active', '2026-09-27T00:00:00.000Z', NULL, '调度（不参与调用链）');

INSERT OR IGNORE INTO events(id, session_id, seq, phase_id, ts, author_id, author_kind, kind, text, mentions, tool_calls, reply_mode, voided)
VALUES
  ('e_seed_0001', 's_seed_demo', 1, NULL, '2026-09-27T00:00:01.000Z',
   'u_dri', 'human', 'message', '这是 seed 的示例发言：请各位先看需求草案，分析师先给边界条件。', '[]', '[]', '', 0),
  ('e_seed_0002', 's_seed_demo', 2, NULL, '2026-09-27T00:00:02.000Z',
   'a_analyst', 'agent', 'message', '需求分析师收到：草案已读，我补充三点边界条件（并发、离线、权限）。', '[]', '[]', '', 0),
  ('e_seed_0003', 's_seed_demo', 3, NULL, '2026-09-27T00:00:03.000Z',
   NULL, 'system', 'system', 'seed：演示会话已初始化。', '[]', '[]', '', 0);
