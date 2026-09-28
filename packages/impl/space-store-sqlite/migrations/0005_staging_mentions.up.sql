-- 0005_staging_mentions —— 暂存条目携带 @ 提及（P4 2026-09-28）。
--
-- 用户实测「输入 @ 没有反应」：@ 提及要从输入区一路走到人类发言事件
-- （events.mentions），orchestrator 才拿得到 mentionHints（NLP 判定的提示
-- 输入）。暂存条目是合并前的人类发言载体，提及必须**随条目持久化**，
-- /commit 合并时取并集 —— 不能只在 UI 层做样子。
--
-- 存 JSON 数组文本（'["a_analyst"]'）：与 events.mentions 的存储方式一致
-- （驱动侧字符串列），SQLite 无数组类型，规范同 0003。

ALTER TABLE staging_entries ADD COLUMN mentions TEXT NOT NULL DEFAULT '[]';
