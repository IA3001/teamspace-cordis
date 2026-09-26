#!/usr/bin/env bash
# check-console.sh —— 调试控制台可达门禁（断言 ⑩，铁律 2 的落地）。
#
# 断言出处：dev-cordis/MODULE-PLAN.md 第 6 节 断言 ⑩ + .rules/IRON-RULES.md 铁律 2。
#   判红条件：启动后 5172 的**插件 / 日志 / 数据库三页 HTTP 200**；任一非 200 判红。
#
# 为什么不是「GET / 返回 200 就算过」：webui 是 catch-all 的 SPA 外壳，`/` 永远 200 ——
# 那只能证明外壳活着，**证明不了三页被加载**。所以真正的证据是：对每个页面包
# 读它的 dist/manifest.json，再按 webui 的模块 URL 规则逐个取 chunk：
#
#     {uiPath}/-/v1/modules/{manifest.path}/{chunk.file}
#
# manifest.path 由包名推导（plugin-webui 的 Entry._resolvePath：从 baseUrl 所在目录
# 往上找最近的 package.json，tail = 相对 dist 的路径）—— 官方三页固定是
# `<包名>/dist`，即 URL 里的 `@cordisjs/plugin-loader-webui/dist` 那一段。
# uiPath 默认是空串（plugin-webui 的 Config 默认值），所以 URL 以 `/-/v1/modules/` 开头。
#
# 用法：
#   npm run check:console          （需要服务已经在跑；服务没起 → 判红并提示先 npm start）
#
# 端口只来自 .env（经 scripts/env.sh），不在这里写死。
set -uo pipefail
source "$(dirname "$0")/env.sh"
set +e   # env.sh 带 -e；这里要累计失败，不许第一个 curl 失败就退出

NODE_BIN="${NODE_BIN_DIR:-/home/ia3000/SPM/.toolchain/node24/bin}/node"

# 0.0.0.0 是监听地址，不能拿去连；连本机一律用 127.0.0.1
HOST="$APP_HOST"
[ "$HOST" = "0.0.0.0" ] && HOST=127.0.0.1
BASE="http://${HOST}:${DEBUG_PORT}"

fail=0
report() { printf '  ✗ %s\n' "$*"; fail=1; }
note()   { printf '  · %s\n' "$*"; }

printf '铁律 2 门禁：调试控制台可达（断言 ⑩，端口 %s）\n' "$DEBUG_PORT"
say "观测点     ${BASE}   插件 / 日志 / 数据库 三页"

# ── 1. 外壳本身 ─────────────────────────────────────────────────────────
code="$(curl -s -o /dev/null -m 10 -w '%{http_code}' "$BASE/" 2>/dev/null)"
if [ "$code" = "200" ]; then
  note "外壳 ${BASE}/ → 200 ✅"
else
  report "外壳 ${BASE}/ 期望 200，实际 ${code:-连接失败}"
  note '服务没起？先 ./scripts/run.sh（或 npm start），再跑本检查'
  printf '\n✗ 调试控制台不可达 —— 铁律 2 判红（5172 是常驻开发设施，不许丢）\n'
  exit 1
fi

# ── 2. 三个页面包的模块 ─────────────────────────────────────────────────
# 页面包 → 人类看的名字（报错时好认）
PAGES=(
  "@cordisjs/plugin-loader-webui|插件页"
  "@cordisjs/plugin-logger-webui|日志页"
  "@cordisjs/plugin-database-webui|数据库页"
)

for entry in "${PAGES[@]}"; do
  pkg="${entry%%|*}"
  label="${entry##*|}"
  manifest="node_modules/${pkg}/dist/manifest.json"

  if [ ! -f "$manifest" ]; then
    report "${label}：找不到 ${manifest}（包没装？）"
    continue
  fi

  # 逐个 chunk（entry js + css）—— 与 webui getEntryFiles 实际会取的文件一致
  files="$("$NODE_BIN" --input-type=module -e \
    "import{readFileSync as r}from'node:fs';const m=JSON.parse(r('${manifest}','utf8'));console.log(Object.values(m).map(c=>c.file).join('\n'))" 2>/dev/null)"

  if [ -z "$files" ]; then
    report "${label}：${manifest} 里读不出 chunk 清单"
    continue
  fi

  while IFS= read -r file; do
    [ -z "$file" ] && continue
    url="${BASE}/-/v1/modules/${pkg}/dist/${file}"
    pcode="$(curl -s -o /dev/null -m 10 -w '%{http_code}' "$url" 2>/dev/null)"
    if [ "$pcode" = "200" ]; then
      note "${label} ${file} → 200 ✅"
    else
      report "${label} ${file} 期望 200，实际 ${pcode:-连接失败}   ${url}"
    fi
  done <<< "$files"
done

# ── 结论 ────────────────────────────────────────────────────────────────
echo
if [ "$fail" -ne 0 ]; then
  printf '✗ 调试控制台门禁未通过 —— 去 %s 亲眼看一眼是哪一页白的\n' "$BASE"
  printf '  规矩见 .rules/IRON-RULES.md（铁律 2）与 dev-cordis/MODULE-PLAN.md 第 6 节 断言 ⑩\n'
  exit 1
fi
printf '✓ 调试控制台门禁通过（三页均 200）—— 亲眼看：%s\n' "$BASE"

# 自检记录（2026-09-27 实测）：
#   ① 服务在跑、.env 的 DEBUG_PORT=5172 → 外壳 + 三页共 7 个 URL 全 200，退出码 0
#   ② 把 .env 的 DEBUG_PORT 改成 5999（空端口）→ `外壳 期望 200，实际 000`，退出码 1
#   复原 .env 后回到 0。这就是「断言 ⑩ 会红」的证据。