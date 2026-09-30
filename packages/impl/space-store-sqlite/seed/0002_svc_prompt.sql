-- seed/0002_svc_prompt —— 4 条**占位**提示词（P8 机制层，2026-09-30）。
--
-- 角色 1~4 的原文等用户提供（待定 10），这里只落机制占位：内容明示「待原文」，
-- ref 是稳定标识（agent stub 的 promptRef 指向它们；原文到位后经
-- ctx.prompts.upsert 语义替换正文，ref 与名单零改动）。
--
-- 幂等（铁律 3 落地动作 6）：固定主键 + 固定 updated_at + INSERT OR IGNORE，
-- 反复跑结果一致。
-- 修订（2026-09-30 P8 接线时实测）：初版每行只有 3 个值（漏 updated_at），
-- seed 报 "3 values for 4 columns" —— typecheck 不覆盖 SQL 语义，跑 seed 才暴露。

INSERT OR IGNORE INTO prompt_templates(ref, title, body, updated_at) VALUES
  ('prompt.minutes',
   '会议记录官提示词（角色1）',
   '【占位提示词 —— 等待角色 1（会议记录）原文】原文到位后经 ctx.prompts.upsert 替换本正文；ref 不变，名单零改动。当前行为：stub（不接真模型）。',
   '2026-09-30T00:00:00.000Z'),
  ('prompt.coding',
   '编码者提示词（角色2）',
   '【占位提示词 —— 等待角色 2（编码）原文】原文到位后经 ctx.prompts.upsert 替换本正文；ref 不变，名单零改动。当前行为：stub（不接真模型）。',
   '2026-09-30T00:00:00.000Z'),
  ('prompt.testing',
   '测试者提示词（角色3）',
   '【占位提示词 —— 等待角色 3（测试）原文】原文到位后经 ctx.prompts.upsert 替换本正文；ref 不变，名单零改动。当前行为：stub（不接真模型）。',
   '2026-09-30T00:00:00.000Z'),
  ('prompt.review',
   '代码审查者提示词（角色4）',
   '【占位提示词 —— 等待角色 4（代码审查）原文】原文到位后经 ctx.prompts.upsert 替换本正文；ref 不变，名单零改动。当前行为：stub（不接真模型）。',
   '2026-09-30T00:00:00.000Z');
