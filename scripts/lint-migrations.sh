#!/usr/bin/env bash
# lint-migrations.sh —— 断言 ⑧：DDL 只在迁移里。
#
# 断言出处：dev-cordis/MODULE-PLAN.md 第 6 节断言 ⑧ / 决策记录待定 7。
#   判红条件：packages/** 与 plugins/** 下（**排除 **/migrations/****）出现
#   CREATE TABLE / DROP TABLE / ALTER TABLE / CREATE VIRTUAL TABLE。
#
# 为什么：
#   · 表结构改动必须有迁移 + 重置 + 种子方案（铁律 3）；DDL 散在代码里 = 绕过迁移链
#   · cordis 的 sqlite 驱动会按 model 定义做运行时 DDL —— 我们的 model 注册必须
#     与迁移 DDL 逐列对齐，任何人在代码里写 DDL 都会让"迁移是唯一权威"失效
#
# 口径说明：
#   · 扫描范围从计划的 packages/** 从宽到 packages/** + plugins/**（叶子插件同样
#     不许建表），已在 MODULE-PLAN 修订记录记账
#   · scripts/store.ts 里的 CREATE TABLE schema_version 是**记账设施**（迁移链的
#     版本表），不在业务 schema 范围内，且 scripts/ 本就不在扫描范围
#   · node_modules / dist 天然不在 packages、plugins 扫描范围内
#
# 用法：npm run lint:migrations   （退出码 0 = 通过，1 = 判红）
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

NODE_BIN="${NODE_BIN_DIR:-/home/ia3000/SPM/.toolchain/node24/bin}/node"
if [ ! -x "$NODE_BIN" ]; then
  printf '✗ 找不到 node：%s\n' "$NODE_BIN" >&2
  exit 1
fi

printf 'DDL 门禁：断言 ⑧（DDL 只在迁移里；扫描 packages/** + plugins/**，排除 **/migrations/**）\n'

"$NODE_BIN" --input-type=module - <<'NODE' || exit 1
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()
// 与迁移 0002 的 CREATE VIRTUAL TABLE、down 文件的 DROP TABLE 对齐；
// ALTER TABLE 是 SQLite 里唯一的 ALTER 形态。
const DDL_RE = /\b(CREATE|DROP|ALTER)\s+(?:VIRTUAL\s+)?TABLE\b/i

let fail = 0
let scanned = 0

function walk(dir, inMigrations) {
  for (const name of readdirSync(dir)) {
    const fp = join(dir, name)
    const st = statSync(fp)
    if (st.isDirectory()) {
      walk(fp, inMigrations || name === 'migrations')
      continue
    }
    if (!/\.(ts|tsx|js|mjs|cjs|mts|cts|vue|sql|yml|yaml)$/.test(name)) continue
    if (inMigrations) continue // 迁移目录是 DDL 的合法出处
    scanned++
    const text = readFileSync(fp, 'utf8')
    const lines = text.split('\n')
    for (let i = 0; i < lines.length; i++) {
      if (DDL_RE.test(lines[i])) {
        console.log(`  ✗ ${fp.replace(ROOT + '/', '')}:${i + 1}  ${lines[i].trim()}`)
        fail = 1
      }
    }
  }
}

for (const top of ['packages', 'plugins']) {
  try {
    walk(join(ROOT, top), false)
  } catch {
    /* 目录还不存在就跳过 */
  }
}

console.log(`  · 扫描 ${scanned} 个文件（packages/** + plugins/**，迁移目录已排除）`)
if (fail) {
  console.log('✗ 代码里出现了 DDL —— 表结构只准写在 packages/impl/*/migrations/，改完再跑')
  process.exit(1)
}
console.log('✓ DDL 门禁通过（DDL 只在迁移里）')
NODE

rc=$?
if [ "$rc" -eq 0 ]; then
  # 断言 ⑨：跑过就留痕
  "$NODE_BIN" scripts/record-action.mjs "gate:lint-migrations" '{"ok":true}' || true
fi
exit $rc

# 自检记录（2026-09-27 实测，P1 建门禁时）：
#   探针 packages/impl/space-store-sqlite/src/__probe.ts 写 `const x = "CREATE TABLE IF NOT EXISTS t1"`
#   → 红：`__probe.ts:1 CREATE TABLE ...`，退出码 1；删除后回绿。
