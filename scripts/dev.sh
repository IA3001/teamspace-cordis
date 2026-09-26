#!/usr/bin/env bash
# dev.sh —— 开发模式启动（改源码自动重启）。
#
# 用法：
#   ./scripts/dev.sh
#
# 与 run.sh 的唯一差别是加了 node --watch：它会监视被加载的模块，
# 文件一改就重启进程（官方能力，不自己写 watcher）。
# 端口/主机仍只来自 .env，与 run.sh 完全一致 —— 不允许开发/生产对不齐。
set -euo pipefail
source "$(dirname "$0")/env.sh"

cd "$REPO_ROOT"

cat <<EOF

  teamspace-cordis 开发模式（--watch，保存即重启）…

EOF
print_endpoints
say "环境       ${NODE_ENV:-development}"
say "停止       Ctrl-C

"

exec node --watch --env-file="$ENV_FILE" --import tsx src/index.ts