#!/usr/bin/env bash
# run.sh —— 前台启动应用（常驻，Ctrl-C 停止）。
#
# 用法：
#   ./scripts/run.sh
#
# 标准约定（不要绕过）：
#   · 端口/主机只来自 .env（经 scripts/env.sh 校验后导出）
#   · 插件清单来自 cordis.yml
#   · 用 node 官方的 --env-file 载入 .env，不自己写 dotenv 解析
set -euo pipefail
source "$(dirname "$0")/env.sh"

cd "$REPO_ROOT"

cat <<EOF

  teamspace-cordis 启动中 …

EOF
print_endpoints
say "环境       ${NODE_ENV:-development}"
say "停止       Ctrl-C

"

# --env-file：Node 20.6+ 官方能力，比自写 dotenv 少一个依赖、少一处漂移
exec node --env-file="$ENV_FILE" --import tsx src/index.ts