#!/usr/bin/env bash
# lint-observability.sh —— 断言 ⑨：动作留痕（铁律 2）。
#
# 断言出处：dev-cordis/MODULE-PLAN.md 第 6 节断言 ⑨。
#   判红条件：跑过 migrate / seed 之后，库里**必须**多出可查记录；
#   「跑了但不留痕」判红。
#
# 核查口径（务实且诚实）：
#   · 库文件不存在 / 还没跑过迁移 → 没什么可查，注明后通过（不是空断言：
#     一旦跑过 migrate，下面的核查立即生效）
#   · 已迁移 → action_log 里必须查得到 migrate 与 seed 的留痕行
#     （migrate/seed/reset 由 scripts/store.ts 强制留痕；gate/typecheck 由
#     scripts/record-action.mjs 留痕）—— 有人删了留痕行，这里红
#
# 用法：npm run lint:observe   （退出码 0 = 通过，1 = 判红）
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

source "$REPO_ROOT/scripts/node-runtime.sh"
resolve_node_bin
DB="${DB_PATH:-data/database.db}"

if [ ! -f "$DB" ]; then
  echo "· 尚无库文件（$DB）——先 npm run migrate，之后本核查立即生效"
  exit 0
fi

# heredoc 用引号包分隔符：内容零展开（曾因 ${JSON.stringify(...)} 被 bash
# 展开报 bad substitution，2026-09-27 修复）；DB 路径走环境变量传入
TSDBC_DB="$REPO_ROOT/$DB" "$NODE_BIN" --input-type=module - <<'NODE' || exit 1
import { DatabaseSync } from 'node:sqlite'
const db = new DatabaseSync(process.env.TSDBC_DB, { readOnly: true })
const has = db.prepare(`SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name='schema_version'`).get()
if (!has.n) {
  console.log('· 库还没跑过迁移（无 schema_version）——先 npm run migrate，之后本核查立即生效')
  process.exit(0)
}
const exp = db.prepare(`SELECT COALESCE(MAX(version),0) AS v FROM schema_version`).get().v
const need = []
for (const action of ['migrate', 'seed']) {
  const n = db.prepare(`SELECT count(*) AS n FROM action_log WHERE action LIKE ? || '%'`).get(action).n
  if (n === 0) need.push(action)
}
const total = db.prepare(`SELECT count(*) AS n FROM action_log`).get().n
if (Number(exp) >= 3 && need.length > 0) {
  console.log(`  ✗ action_log（${total} 行）里查不到 ${need.join(' / ')} 的留痕 —— 跑过不留痕，判红（断言 ⑨）`)
  process.exit(1)
}
console.log(`  · action_log 共 ${total} 行；migrate/seed 留痕齐全（schema v${exp}）`)
console.log('✓ 动作留痕核查通过（断言 ⑨）')
NODE

rc=$?
if [ "$rc" -eq 0 ]; then
  "$NODE_BIN" scripts/record-action.mjs "gate:lint-observe" '{"ok":true}' || true
fi
exit $rc
