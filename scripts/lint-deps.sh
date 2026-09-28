#!/usr/bin/env bash
# lint-deps.sh —— 依赖方向门禁（断言 ①②⑦）。
#
# 断言出处：dev-cordis/MODULE-PLAN.md 第 3.7 节（依赖方向表）+ 第 6 节（门禁断言表）。
#   · 断言 ① 依赖方向矩阵 —— 任意 package.json 的依赖违反第 3.7 节允许表 → 判红
#   · 断言 ② seam 无实现   —— packages/seam/** 出现 IO 依赖，或 dependencies 越出白名单 → 判红
#   · 断言 ⑦ 包一律私有   —— private 不为 true，或出现 publishConfig → 判红
#
# 唯一出处是那张表，本脚本只做「把它变成会红的检查」。**改表必须同时改这里。**
#
# 允许表（与 3.7 节逐字对应，压缩成「本层可以引用哪些层的包」）：
#   seam        → seam                       （只有同层）
#   impl        → seam                       （任何其它 impl 都不允许）
#   policy      → seam                       （impl 的具体实现类不允许）
#   client-ui   → seam                       （impl / policy / bundle 不允许）
#   bundle      → 全部                        （它只写清单不写代码）
#   反向：任何包都不得引用 bundle —— 上表里没有 bundle 就是这条的落地
#   plugins/ 叶子（有 package.json 时一并检查）→ seam、policy
#     （P3 起允许 policy：叶子插件是组合点，要把 policy 纯函数接到能力上 ——
#      如 plugins/orchestrator 引 space-authz。纯函数无状态，不构成第二实现）
#
# 用法：npm run lint:deps      （退出码 0 = 通过，1 = 判红）
#
# 实现注意（踩过的坑，别改回去）：包名的层归属**按路径判**（packages/<层>/<包>），
# 不按包名前缀猜 —— 前缀是给人看的，路径是唯一不会说谎的。JSON 一律用 node 解析，
# 不要用 grep/sed 抠字段（package.json 里 dependencies 是多行且顺序不固定）。
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

NODE_BIN="${NODE_BIN_DIR:-/home/ia3000/SPM/.toolchain/node24/bin}/node"
if [ ! -x "$NODE_BIN" ]; then
  printf '✗ 找不到 node：%s\n' "$NODE_BIN" >&2
  exit 1
fi

printf '依赖方向门禁：断言 ①（方向矩阵） ②（seam 无实现） ⑦（包一律私有）\n'

rc=0
"$NODE_BIN" --input-type=module - <<'NODE' || rc=$?
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()
const PKG_DIR = join(ROOT, 'packages')

// ── 允许表（唯一出处 = MODULE-PLAN.md 第 3.7 节）────────────────────────
const LAYERS = ['seam', 'impl', 'policy', 'client-ui', 'bundle']
const ALLOWED = {
  seam: ['seam'],
  impl: ['seam'],
  policy: ['seam'],
  'client-ui': ['seam'],
  bundle: ['seam', 'impl', 'policy', 'client-ui', 'bundle'],
}

// seam 的 dependencies 白名单（除同层 seam 外的外部包）。
// 依据 3.7 节 seam 行：cordis、同层 seam、schemastery。cordis 按官方惯例走 peerDependencies。
const SEAM_EXTERNAL_WHITELIST = ['schemastery']

// seam 源码里出现即判红的东西：任何 node 内置模块（IO 必经之路）+ 常见网络/驱动库。
const IO_PKG_RE = /^(ws|axios|undici|node-fetch|better-sqlite3|sqlite3|ioredis|pg|mysql2|knex|@cordisjs\/plugin-database.*)$/

let fail = 0
const report = (s) => { console.log(`  ✗ ${s}`); fail = 1 }
const note = (s) => console.log(`  · ${s}`)

// ── 收集：packages/<层>/<包> ───────────────────────────────────────────
const pkgs = []
for (const layer of LAYERS) {
  const dir = join(PKG_DIR, layer)
  if (!existsSync(dir)) continue
  for (const name of readdirSync(dir)) {
    const pj = join(dir, name, 'package.json')
    if (!existsSync(pj)) continue
    let json
    try {
      json = JSON.parse(readFileSync(pj, 'utf8'))
    } catch (e) {
      report(`packages/${layer}/${name}/package.json 解析失败：${e.message}`)
      continue
    }
    pkgs.push({ layer, dir: `packages/${layer}/${name}`, abs: join(dir, name), json, name: json.name ?? name })
  }
}

// plugins/ 叶子：有 package.json 才检查（health/app 这类是裸 index.ts，不参与包检查）
const leafPkgs = []
if (existsSync(join(ROOT, 'plugins'))) {
  for (const name of readdirSync(join(ROOT, 'plugins'))) {
    const pj = join(ROOT, 'plugins', name, 'package.json')
    if (!existsSync(pj)) continue
    try {
      leafPkgs.push({ layer: 'plugins', dir: `plugins/${name}`, abs: join(ROOT, 'plugins', name), json: JSON.parse(readFileSync(pj, 'utf8')), name })
    } catch (e) {
      report(`plugins/${name}/package.json 解析失败：${e.message}`)
    }
  }
}
for (const p of leafPkgs) { p.name = p.json.name ?? p.name; ALLOWED.plugins = ['seam', 'policy'] }

const all = [...pkgs, ...leafPkgs]
const layerOf = new Map(all.map((p) => [p.name, p.layer]))

if (all.length === 0) {
  console.log('  · packages/ 下还没有包，无依赖可查（不是错误）')
}
note(`扫描 ${pkgs.length} 个 packages/ 包${leafPkgs.length ? ` + ${leafPkgs.length} 个 plugins/ 叶子包` : ''}`)

// ── 断言 ① 依赖方向矩阵 ────────────────────────────────────────────────
const depHits = []
for (const p of all) {
  const allow = ALLOWED[p.layer] ?? []
  for (const [dep, ver] of Object.entries(p.json.dependencies ?? {})) {
    const target = layerOf.get(dep)
    if (!target) continue // 外部包，方向矩阵不管
    if (!allow.includes(target)) {
      depHits.push(`${p.dir}  →  ${dep}（${target} 层）  ✗  ${p.layer} 层只允许引用 ${allow.join(' / ')}`)
    }
  }
}
if (depHits.length) {
  report('依赖方向越界（断言 ①）：')
  for (const h of depHits) console.log(`      ${h}`)
} else {
  note('① 依赖方向矩阵 ✅')
}

// ── 断言 ② seam 无实现 ─────────────────────────────────────────────────
const seamHits = []
for (const p of pkgs.filter((x) => x.layer === 'seam')) {
  for (const dep of Object.keys(p.json.dependencies ?? {})) {
    if (layerOf.get(dep) === 'seam') continue // 同层 seam 合法
    if (SEAM_EXTERNAL_WHITELIST.includes(dep)) continue
    seamHits.push(`${p.dir}: dependencies 里的 "${dep}" 不在 seam 白名单（只许同层 seam / ${SEAM_EXTERNAL_WHITELIST.join(' / ')}）`)
  }
  const srcDir = join(p.abs, 'src')
  if (!existsSync(srcDir)) continue
  const walk = (d) => {
    for (const f of readdirSync(d, { withFileTypes: true })) {
      const fp = join(d, f.name)
      if (f.isDirectory()) { walk(fp); continue }
      if (!/\.(ts|tsx|js|mjs|cjs)$/.test(f.name)) continue
      const text = readFileSync(fp, 'utf8')
      for (const m of text.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)) {
        const mod = m[1]
        if (mod.startsWith('node:') || mod.startsWith('fs') || IO_PKG_RE.test(mod)) {
          seamHits.push(`${fp.replace(`${ROOT}/`, '')}: import "${mod}" —— seam 不许有 IO`)
        }
      }
    }
  }
  walk(srcDir)
}
if (seamHits.length) {
  report('seam 层出现实现 / IO（断言 ②）：')
  for (const h of seamHits) console.log(`      ${h}`)
} else {
  note('② seam 无 IO 依赖 ✅')
}

// ── 断言 ⑦ 包一律私有 + 内部引用用 workspace: 协议 ────────────────────
const privHits = []
for (const p of all) {
  if (p.json.private !== true) privHits.push(`${p.dir}: private 不是 true（当前 ${JSON.stringify(p.json.private)}）`)
  if (p.json.publishConfig) privHits.push(`${p.dir}: 出现 publishConfig（方案 A 决定不发布，见 MODULE-PLAN 待定 3）`)
  for (const section of ['dependencies', 'peerDependencies', 'devDependencies']) {
    for (const [dep, ver] of Object.entries(p.json[section] ?? {})) {
      if (!layerOf.has(dep)) continue
      // npm workspaces 的官方口径是 "*"（workspace:* 是 pnpm/yarn 协议，
      // npm 直接 EUNSUPPORTEDPROTOCOL —— 2026-09-27 P1 实测）。npm 会把命中
      // workspace 范围的 "*" 解析成仓内符号链接，不会装到 npm 源上。
      if (ver !== '*') privHits.push(`${p.dir}: ${section} 里的内部包 "${dep}" 必须写 "*"（npm workspaces 口径），当前是 "${ver}"`)
    }
  }
}
if (privHits.length) {
  report('包私有性 / 内部引用协议（断言 ⑦）：')
  for (const h of privHits) console.log(`      ${h}`)
} else {
  note('⑦ 包一律私有 + 内部引用 workspace:* ✅')
}

console.log()
if (fail) {
  console.log('✗ 依赖方向门禁未通过。真相在 dev-cordis/MODULE-PLAN.md 第 3.7 节')
  process.exit(1)
}
console.log('✓ 依赖方向门禁通过')
NODE

if [ "$rc" -ne 0 ]; then
  exit 1
fi

# 断言 ⑨：跑过就留痕（失败不记 —— 失败要人看，不属于"悄悄跑过"）
"$NODE_BIN" scripts/record-action.mjs "gate:lint-deps" '{"ok":true}' || true

# 自检记录（2026-09-27 实测，逐条单独改坏、单独验证）：
#   ① packages/impl/__probe-impl-a 依赖 packages/impl/__probe-impl-b（同层 impl）
#        → 断言 ① 红：`__probe-impl-a → __probe-impl-b（impl 层）✗ impl 层只允许引用 seam`，退出码 1
#   ② packages/impl/__probe-impl-b 的 private 改成 false
#        → 断言 ⑦ 红：`private 不是 true（当前 false）`，退出码 1（同一次 ① 已恢复绿）
#   ③ packages/seam/__probe-seam/src/index.ts 写 import 'node:fs'
#        → 断言 ② 红：`import "node:fs" —— seam 不许有 IO`，退出码 1
#   三处探针全部删除后回到退出码 0（扫描 13 个包，三条断言全绿）。