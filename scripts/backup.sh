#!/usr/bin/env bash
# backup.sh —— 数据库 + 上传文件的滚动备份（运维贴心件，2026-10-01）。
#
# 用法：
#   ./scripts/backup.sh                         # 数据库、日志、上传与团队共享文件
#   ./scripts/backup.sh --keep 14               # 只保留最近 14 份（缺省 30）
#   ./scripts/backup.sh --include-workdirs       # 同时备份 Agent 私有工作区（可能较大）
#
# 备什么：data/database.db、data/logs.db（分别用 node:sqlite 的 VACUUM INTO
#   生成在线一致性快照）+ data/uploads/ + data/shared-workspace/。
# Agent 私有 workdirs 可能很大，显式传 --include-workdirs 才纳入。加密主密钥
# 单独备份，不放进此目录；node_modules 和 dist 可从发布版本重建。
set -euo pipefail
umask 077
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"
KEEP=30
INCLUDE_WORKDIRS=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --keep)
      if [ "$#" -lt 2 ] || ! [[ "$2" =~ ^[1-9][0-9]*$ ]]; then
        printf '用法：%s [--keep 正整数] [--include-workdirs]\n' "$0" >&2
        exit 2
      fi
      KEEP="$2"
      shift 2
      ;;
    --include-workdirs)
      INCLUDE_WORKDIRS=1
      shift
      ;;
    *)
      printf '未知参数：%s\n用法：%s [--keep 正整数] [--include-workdirs]\n' "$1" "$0" >&2
      exit 2
      ;;
  esac
done

STAMP="$(date +%Y%m%d-%H%M%S)"
DEST="data/backups/$STAMP"
mkdir -p "$DEST/uploads"

printf '备份 → %s\n' "$DEST"

# 数据库一致性快照（node:sqlite VACUUM INTO：在线安全，不锁业务）。
snapshot_sqlite() {
  local source="$1" destination="$2" label="$3"
  node --input-type=module - "$source" "$destination" "$label" <<'NODE'
import { DatabaseSync } from 'node:sqlite'
const [source, destination, label] = process.argv.slice(2)
const db = new DatabaseSync(source, { readOnly: true })
try {
  const escaped = destination.replaceAll("'", "''")
  db.exec(`VACUUM INTO '${escaped}'`)
  console.log(`  · ${label}（VACUUM INTO 一致性快照）✓`)
} finally {
  db.close()
}
NODE
}

snapshot_sqlite 'data/database.db' "$DEST/database.db" 'database.db'
if [ -f data/logs.db ]; then
  snapshot_sqlite 'data/logs.db' "$DEST/logs.db" 'logs.db'
else
  printf '  · logs.db 不存在，跳过\n'
fi

# 2. 上传文件（存在才拷）。
if [ -d data/uploads ]; then
  cp -r data/uploads/. "$DEST/uploads/"
  n="$(find "$DEST/uploads" -type f | wc -l)"
  printf '  · uploads/（%s 个文件）✓\n' "$n"
else
  printf '  · uploads/ 不存在，跳过\n'
fi

# 4. 已批准交付的团队共享文件是持久业务数据，必须随快照备份。
if [ -d data/shared-workspace ]; then
  mkdir -p "$DEST/shared-workspace"
  cp -r data/shared-workspace/. "$DEST/shared-workspace/"
  n="$(find "$DEST/shared-workspace" -type f | wc -l)"
  printf '  · shared-workspace/（%s 个文件）✓\n' "$n"
else
  printf '  · shared-workspace/ 不存在，跳过\n'
fi

# 5. Agent 私有工作区可能包含不可重建的产物，按部署方容量策略选择纳入。
if [ "$INCLUDE_WORKDIRS" -eq 1 ]; then
  if [ -d data/workdirs ]; then
    mkdir -p "$DEST/workdirs"
    cp -r data/workdirs/. "$DEST/workdirs/"
    n="$(find "$DEST/workdirs" -type f | wc -l)"
    printf '  · workdirs/（%s 个文件）✓\n' "$n"
  else
    printf '  · workdirs/ 不存在，跳过\n'
  fi
fi

# 3. 滚动清理：只保留最近 KEEP 份。
ls -1d data/backups/*/ 2>/dev/null | sort | head -n -"$KEEP" | while read -r old; do
  rm -rf "$old"
  printf '  · 清理旧备份 %s\n' "$old"
done

printf '✓ 备份完成（保留最近 %s 份）\n' "$KEEP"
