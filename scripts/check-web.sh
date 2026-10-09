#!/usr/bin/env bash
# check-web.sh —— 团队空间面可达门禁（断言 ⑩ 的 5174 延伸，铁律 2）。
#
# 与 check-console.sh 同款方法（SPA 外壳 / 恒 200 是弱断言，真证据是模块
# chunk 逐个 200）：对每个页面包读 dist/manifest.json，按 webui 的模块 URL
# 规则 `{uiPath}/-/v1/modules/{manifest.path}/{chunk.file}` 逐个取。
# 另加 A2 口径断言：dist/ 不入库（git status 看得到 dist/ → 判红）。
#
# 端口只来自 .env（TEAMSPACE_PORT），不写死。
set -uo pipefail
source "$(dirname "$0")/env.sh"
set +e

HOST="$APP_HOST"
[ "$HOST" = "0.0.0.0" ] && HOST=127.0.0.1
BASE="http://${HOST}:${TEAMSPACE_PORT}"

fail=0
report() { printf '  ✗ %s\n' "$*"; fail=1; }
note()   { printf '  · %s\n' "$*"; }

printf '铁律 2 门禁：团队空间面可达（端口 %s）\n' "$TEAMSPACE_PORT"

code="$(curl -s -o /dev/null -m 10 -w '%{http_code}' "$BASE/" 2>/dev/null)"
if [ "$code" = "200" ]; then
  note "外壳 ${BASE}/ → 200 ✅"
else
  report "外壳 ${BASE}/ 期望 200，实际 ${code:-连接失败}"
  note '服务没起？先 npm start，再跑本检查'
  printf '\n✗ 团队空间面不可达\n'
  exit 1
fi

PAGES=(
  "space-client-ui-teamspace|团队空间"
  "space-client-ui-sessions|会话栏"
  "space-client-ui-auth|登录页"
  "space-client-ui-kb|知识库"
  # 账号管理页挂在 5172 调试控制台（默认 webui 实例）：host 字段标明验哪个端口。
  "space-client-ui-admin|账号管理|debug"
)

for entry in "${PAGES[@]}"; do
  pkg="${entry%%|*}"
  rest="${entry#*|}"
  label="${rest%%|*}"
  # host 字段（可选）：debug = 用 5172 端口验证，缺省用 5174。
  case "$rest" in
    *"|debug") pbase="http://${HOST}:${DEBUG_PORT}" ;;
    *)         pbase="$BASE" ;;
  esac
  manifest="packages/client-ui/${pkg}/dist/manifest.json"
  if [ ! -f "$manifest" ]; then
    report "${label}：找不到 ${manifest}（先 npm run build:web）"
    continue
  fi
  files="$("$NODE_BIN" --input-type=module -e \
    "import{readFileSync as r}from'node:fs';const m=JSON.parse(r('${manifest}','utf8'));console.log(Object.values(m).map(c=>c.file).join('\n'))" 2>/dev/null)"
  if [ -z "$files" ]; then
    report "${label}：${manifest} 里读不出 chunk 清单"
    continue
  fi
  while IFS= read -r file; do
    [ -z "$file" ] && continue
    url="${pbase}/-/v1/modules/${pkg}/dist/${file}"
    pcode="$(curl -s -o /dev/null -m 10 -w '%{http_code}' "$url" 2>/dev/null)"
    if [ "$pcode" = "200" ]; then
      note "${label} ${file} → 200 ✅"
    else
      report "${label} ${file} 期望 200，实际 ${pcode:-连接失败}   ${url}"
    fi
  done <<< "$files"
done

# A2 口径：构建产物不入库 —— git status 里出现 packages/client-ui/**/dist/ → 判红
if git rev-parse --is-inside-work-tree > /dev/null 2>&1; then
  dirty="$(git status --porcelain -- 'packages/client-ui/**/dist' 'packages/client-ui/*/dist' 2>/dev/null | grep dist || true)"
  if [ -n "$dirty" ]; then
    report '构建产物 dist/ 出现在 git status（A2 口径：dist 不入库）—— 查 .gitignore：'
    printf '%s\n' "$dirty" | sed 's/^/      /'
  else
    note 'A2 口径：dist/ 不入库 ✅'
  fi
fi

echo
if [ "$fail" -ne 0 ]; then
  printf '✗ 团队空间面门禁未通过 —— 去 %s 亲眼看一眼\n' "$BASE"
  exit 1
fi
printf '✓ 团队空间面门禁通过（页面 chunk 全 200）—— 亲眼看：%s\n' "$BASE"

# 断言 ⑨：跑过就留痕
node scripts/record-action.mjs "gate:check-web" '{"ok":true}' || true

# 自检记录（2026-09-28 实测）：
#   ① 服务在跑、页面已构建 → 外壳 + 页面 chunk 全 200，git status 无 dist，退出码 0
#   ② 删掉一个包的 dist/ → 「找不到 manifest」判红，退出码 1
#   ③ 把某包 dist/ 里加一个文件强制入库（git add -f 后再删 .gitignore 行）→ A2 判红
#   证据见 MODULE-PLAN 修订记录 2026-09-28（P4）。
