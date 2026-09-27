-- 0003_svc_actions —— 动作留痕（铁律 2 / 断言 ⑨）。
--
-- 跑过 migrate / seed / reset / gate / typecheck 之后，这里**必须**多出可查记录；
-- 「跑了但不留痕」判红（dev-cordis/MODULE-PLAN.md 第 6 节断言 ⑨）。
-- 表是 append-only 的账本：只插入，不更新不删除。

CREATE TABLE IF NOT EXISTS action_log (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    action     TEXT NOT NULL,              -- migrate / migrate:down / seed / reset / gate:<名> / typecheck
    detail     TEXT NOT NULL DEFAULT '',   -- JSON：参数、结果摘要（applied 列表、退出码等）
    ok         INTEGER NOT NULL DEFAULT 1 CHECK (ok IN (0,1)),
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_action_log_created ON action_log(created_at);
