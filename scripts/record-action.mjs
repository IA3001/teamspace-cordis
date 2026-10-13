// 断言 ⑨ 辅助：给 gate / typecheck 等动作留痕（追加一行到 action_log）。
// 尽力而为：库文件或留痕表不存在时明确打印说明并返回 0 —— 不留痕的"静默跳过"
// 与"跑过没记录"是两回事，前者要明说，后者由 lint-observability.sh 判红。
import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const action = process.argv[2]
if (!action) {
  console.error('用法: node scripts/record-action.mjs <action> [detailJSON]')
  process.exit(2)
}
const path = resolve(process.cwd(), 'data/database.db')
if (!existsSync(path)) {
  console.log(`· 留痕跳过：${path} 尚不存在（先跑 npm run migrate）`)
  process.exit(0)
}
const db = new DatabaseSync(path)
// Several independent checks may finish together and append their receipts
// to the same SQLite action log. Wait for a peer's short write transaction
// rather than turning harmless parallel verification into a flaky failure.
db.exec('PRAGMA busy_timeout=5000')
const has = db.prepare(`SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name='action_log'`).get()
if (!has.n) {
  console.log('· 留痕跳过：action_log 表不在（迁移链未含 0003）')
  db.close()
  process.exit(0)
}
mkdirSync(dirname(path), { recursive: true })
db.prepare(`INSERT INTO action_log(action, detail, ok, created_at) VALUES (?, ?, 1, ?)`).run(
  action,
  process.argv[3] ?? '{}',
  new Date().toISOString(),
)
db.close()
console.log(`· 留痕：${action} → action_log`)
