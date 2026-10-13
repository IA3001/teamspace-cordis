ALTER TABLE memories ADD COLUMN folder_path TEXT NOT NULL DEFAULT '';

CREATE TABLE memory_folders (
  scope TEXT NOT NULL,
  path TEXT NOT NULL,
  name TEXT NOT NULL,
  parent_path TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  PRIMARY KEY (scope, path)
);
CREATE INDEX idx_memory_folders_parent ON memory_folders(scope, parent_path, name);
CREATE INDEX idx_memories_folder ON memories(scope, folder_path, created_at DESC);

-- Turn the old flat memory dump into useful Agent-private folders. Internal
-- cursors stay under a system folder and are excluded from the explorer UI.
UPDATE memories SET folder_path = CASE
  WHEN kind LIKE 'cursor:%' THEN '.system/cursors'
  WHEN kind LIKE 'history_bootstrap:%' THEN '会话历史/摘要'
  WHEN kind LIKE 'conversation_fact:%' THEN '会话事实'
  WHEN kind LIKE 'todo%' THEN '任务'
  ELSE '其他'
END;

INSERT OR IGNORE INTO memory_folders(scope, path, name, parent_path, created_at)
SELECT scope, folder_path,
       CASE folder_path
         WHEN '.system/cursors' THEN 'cursors'
         WHEN '会话历史/摘要' THEN '摘要'
         WHEN '会话事实' THEN '会话事实'
         WHEN '任务' THEN '任务'
         ELSE '其他'
       END,
       CASE folder_path WHEN '.system/cursors' THEN '.system' WHEN '会话历史/摘要' THEN '会话历史' ELSE '' END,
       MIN(created_at)
FROM memories GROUP BY scope, folder_path;
INSERT OR IGNORE INTO memory_folders(scope, path, name, parent_path, created_at)
SELECT DISTINCT scope, '.system', '系统', '', MIN(created_at)
FROM memories WHERE folder_path = '.system/cursors' GROUP BY scope;
INSERT OR IGNORE INTO memory_folders(scope, path, name, parent_path, created_at)
SELECT DISTINCT scope, '会话历史', '会话历史', '', MIN(created_at)
FROM memories WHERE folder_path = '会话历史/摘要' GROUP BY scope;
