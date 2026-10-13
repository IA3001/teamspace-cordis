#!/usr/bin/env bash
# run.sh —— 前台启动应用（常驻，Ctrl-C 停止）。
#
# 用法：
#   ./scripts/run.sh
#
# 标准约定（不要绕过）：
#   · 端口/主机只来自 .env（经 scripts/env.sh 校验后导出）
#   · 插件清单来自 composed.cordis.yml（启动时由 patch 层叠加生成）
#   · 用 node 官方的 --env-file 载入 .env，不自己写 dotenv 解析
#
# 交互修复（2026-09-30）：
#   · 启动前预检 node_modules（没装依赖给出明确指引，不再抛裸模块错误）
#   · 启动前预检后端端口占用（提示先 stop，不再等 node 抛 EADDRINUSE 堆栈）
#   · 停止提示排版修复（不再多打两行带缩进的空行）
set -euo pipefail
source "$(dirname "$0")/env.sh"

cd "$REPO_ROOT"

# 依赖预检：没跑过 npm install 时给一句话指引，而不是 tsx/loader 原始报错。
if [ ! -d "$REPO_ROOT/node_modules" ]; then
  printf '✗ 还没有安装依赖 —— 先执行一次：\n\n    cd %s && npm install\n\n' "$REPO_ROOT" >&2
  exit 1
fi

acquire_app_lock

# 端口占用预检（lsof 缺失时静默跳过，不阻塞启动）。
if command -v lsof >/dev/null 2>&1; then
  if lsof -nP -iTCP:"$APP_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
    printf '✗ 端口 %s 已被占用 —— 先执行 ./scripts/stop.sh（或 --check 看是谁），\n  或改 .env 里的 APP_PORT 换端口。\n' "$APP_PORT" >&2
    exit 1
  fi
fi

# 开发环境启动前构建页面；生产构建由发布阶段完成，使运行账号只读代码目录。
# 生产启动只校验 dist 清单和入口文件，缺失即 fail fast，不重建或复用不完整产物。
if [ "${NODE_ENV:-development}" = "production" ]; then
  npm run check:release-artifacts --silent
  if [ ! -f "$REPO_ROOT/composed.cordis.yml" ] || [ ! -w "$REPO_ROOT/composed.cordis.yml" ]; then
    printf '✗ 生产组合清单不存在或不可写；发布前生成 composed.cordis.yml 并授予运行账号单文件写权限。\n' >&2
    exit 1
  fi
else
  npm run build:web --silent
fi

cat <<EOF

  teamspace-cordis 启动中 …

EOF
print_endpoints
say "环境       ${NODE_ENV:-development}"
say "停止       Ctrl-C"

# --env-file：Node 20.6+ 官方能力，比自写 dotenv 少一个依赖、少一处漂移
exec node --env-file="$ENV_FILE" --import tsx src/index.ts
