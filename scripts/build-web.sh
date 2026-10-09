#!/usr/bin/env bash
# build-web.sh —— 构建全部 client-ui 页面包（A2 口径：vite build --manifest，
# 产物 dist/ 不入库；本脚本是「构建进启动脚本」的落点，run.sh 启动前调用）。
#
# 交互修复（2026-09-30）：构建失败不再把 vite 的报错丢进 /dev/null ——
# 失败时原样重跑一次并回显 stderr，用户能直接看到 TS/缺依赖错误。
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

NODE_BIN="${NODE_BIN_DIR:-/home/ia3000/SPM/.toolchain/node24/bin}"
export PATH="$NODE_BIN:$PATH"

PAGES=(space-client-ui-teamspace space-client-ui-sessions space-client-ui-auth space-client-ui-kb space-client-ui-admin space-client-ui-settings space-client-ui-agents space-client-ui-bridge)

printf '构建 client-ui 页面包（产物 dist/ 不入库，运行时 devMode:false 只读产物）\n'
for p in "${PAGES[@]}"; do
  dir="packages/client-ui/$p"
  if [ ! -f "$dir/package.json" ]; then
    printf '  ✗ %s 缺 package.json\n' "$dir"
    exit 1
  fi
  printf '  · %s …' "$p"
  if (cd "$dir" && npm run build --silent > /dev/null 2>&1); then
    [ -f "$dir/dist/manifest.json" ] || { printf ' ✗ 未产出 dist/manifest.json\n'; exit 1; }
    printf ' ✓（dist/manifest.json 就位）\n'
  else
    printf ' ✗ 构建失败 —— 回显编译错误：\n\n'
    (cd "$dir" && npm run build) || true   # 失败重跑，把 vite/TS 的报错原样打给用户
    printf '\n✗ %s 构建失败（上面就是原因）\n' "$p"
    exit 1
  fi
done
printf '✓ 页面包构建完成\n'
