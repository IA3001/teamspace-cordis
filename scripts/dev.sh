#!/usr/bin/env bash
# dev.sh —— 开发模式启动（改源码自动重启）。
#
# 用法：
#   ./scripts/dev.sh
#
# 与 run.sh 的唯一差别是加了 node --watch：它会监视被加载的模块，
# 文件一改就重启进程（官方能力，不自己写 watcher）。
# 端口/主机仍只来自 .env，与 run.sh 完全一致 —— 不允许开发/生产对不齐。
#
# 交互修复（2026-09-30，与 run.sh 同款）：
#   · 依赖缺失预检（没装 node_modules 给一句话指引）
#   · 端口占用预检（先提示 stop，不等 node 抛 EADDRINUSE）
#   · 停止提示排版修复
set -euo pipefail
source "$(dirname "$0")/env.sh"

cd "$REPO_ROOT"

if [ ! -d "$REPO_ROOT/node_modules" ]; then
  printf '✗ 还没有安装依赖 —— 先执行一次：\n\n    cd %s && npm install\n\n' "$REPO_ROOT" >&2
  exit 1
fi
acquire_app_lock
if command -v lsof >/dev/null 2>&1; then
  if lsof -nP -iTCP:"$APP_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
    printf '✗ 端口 %s 已被占用 —— 先执行 ./scripts/stop.sh（或 --check 看是谁），\n  或改 .env 里的 APP_PORT 换端口。\n' "$APP_PORT" >&2
    exit 1
  fi
fi

cat <<EOF

  teamspace-cordis 开发模式（--watch，保存即重启）…

EOF
print_endpoints
say "环境       ${NODE_ENV:-development}"
say "停止       Ctrl-C"

exec node --watch --env-file="$ENV_FILE" --import tsx src/index.ts
