#!/usr/bin/env bash
# build-web.sh —— 构建全部 client-ui 页面包（A2 口径：vite build --manifest，
# 产物 dist/ 不入库；本脚本是「构建进启动脚本」的落点，run.sh 启动前调用）。
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

NODE_BIN="${NODE_BIN_DIR:-/home/ia3000/SPM/.toolchain/node24/bin}"
export PATH="$NODE_BIN:$PATH"

PAGES=(space-client-ui-teamspace)

printf '构建 client-ui 页面包（产物 dist/ 不入库，运行时 devMode:false 只读产物）\n'
for p in "${PAGES[@]}"; do
  dir="packages/client-ui/$p"
  if [ ! -f "$dir/package.json" ]; then
    printf '  ✗ %s 缺 package.json\n' "$dir"
    exit 1
  fi
  printf '  · %s …' "$p"
  (cd "$dir" && npm run build --silent > /dev/null 2>&1)
  [ -f "$dir/dist/manifest.json" ] || { printf ' ✗ 未产出 dist/manifest.json\n'; exit 1; }
  printf ' ✓（dist/manifest.json 就位）\n'
done
printf '✓ 页面包构建完成\n'
