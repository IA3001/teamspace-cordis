#!/usr/bin/env bash
# backup.sh —— 数据库 + 上传文件的滚动备份（运维贴心件，2026-10-01）。
#
# 用法：
#   ./scripts/backup.sh              # 备到 data/backups/<时间戳>/
#   ./scripts/backup.sh --keep 14    # 只保留最近 14 份（缺省 30）
#
# 备什么：data/database.db（WAL 模式下连 -wal/-shm 一起拷，保证一致快照口径：
#   先 sqlite3 .backup? 本项目不引 sqlite3 CLI 依赖 —— 用 node:sqlite 的
#   VACUUM INTO 生成一致性快照，再连同 uploads/ 一起归档）+ data/uploads/。
# 不备份什么：node_modules、dist、workdirs（可再生产物）。
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"
NODE_BIN="${NODE_BIN_DIR:-/home/ia3000/SPM/.toolchain/node24/bin}"
export PATH="$NODE_BIN:$PATH"

KEEP=30
if [ "${1:-}" = "--keep" ] && [ -n "${2:-}" ]; then KEEP="$2"; fi

STAMP="$(date +%Y%m%d-%H%M%S)"
DEST="data/backups/$STAMP"
mkdir -p "$DEST/uploads"

printf '备份 → %s\n' "$DEST"

# 1. 数据库一致性快照（node:sqlite VACUUM INTO：在线安全，不锁业务）。
node --input-type=module -e "
  import { DatabaseSync } from 'node:sqlite'
  const src = new DatabaseSync('data/database.db', { readOnly: true })
  src.exec(\"VACUUM INTO '$DEST/database.db'\")
  src.close()
  console.log('  · database.db（VACUUM INTO 一致性快照）✓')
"

# 2. 上传文件（存在才拷）。
if [ -d data/uploads ]; then
  cp -r data/uploads/. "$DEST/uploads/"
  n="$(find "$DEST/uploads" -type f | wc -l)"
  printf '  · uploads/（%s 个文件）✓\n' "$n"
else
  printf '  · uploads/ 不存在，跳过\n'
fi

# 3. 滚动清理：只保留最近 KEEP 份。
ls -1d data/backups/*/ 2>/dev/null | sort | head -n -"$KEEP" | while read -r old; do
  rm -rf "$old"
  printf '  · 清理旧备份 %s\n' "$old"
done

printf '✓ 备份完成（保留最近 %s 份）\n' "$KEEP"
