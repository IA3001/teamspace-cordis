-- 0009_reactions —— 消息表情回应（IM 化 2026-10-01）。
--
-- msg_reactions：一条回应 = (事件, 用户, emoji) 三元组，一人一事件一个 emoji
-- 只能有一条（主键兜住），重复点同一个表情走 INSERT OR IGNORE 幂等。
-- 事件删除时回应随级联删除（ON DELETE CASCADE）—— 回应依附于事件存在。
--
-- DDL 权威在本迁移（断言 ⑧）；impl/src/index.ts 的 model 注册只为 5172 展示，
-- 必须与本文件逐列对齐（否则 sqlite 驱动会做临时表重建抹掉约束）。

CREATE TABLE IF NOT EXISTS msg_reactions (
    event_id   TEXT NOT NULL,   -- 被回应的事件（幂等键，见 0002 events.id）
    user_id    TEXT NOT NULL,   -- 回应人（登录用户 id）
    emoji      TEXT NOT NULL,   -- emoji 字符本身（如 👍），不做枚举表
    created_at TEXT NOT NULL,   -- ISO 8601（UTC），承全库时间戳口径
    PRIMARY KEY (event_id, user_id, emoji),
    FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE
);

-- 按事件批量查的时间线索引（主键已覆盖 event_id 前缀，此索引只为展示排序）。
CREATE INDEX IF NOT EXISTS idx_msg_reactions_event ON msg_reactions(event_id, emoji);
