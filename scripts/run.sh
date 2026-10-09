#!/usr/bin/env bash
# run.sh —— 前台启动应用（常驻，Ctrl-C 停止）。
#
# 用法：
#   ./scripts/run.sh
#
# 标准约定（不要绕过）：
#   · 端口/主机只来自 .env（经 scripts/env.sh 校验后导出）
#   · 插件清单来自组合产物 composed.cordis.yml（启动时由 patch 层叠加生成）
#   · 用 node 官方的 --env-file 载入 .env，不自己写 dotenv 解析
#
# 交互修复（2026-09-30）：
#   · 启动前预检 node_modules（没装依赖给出明确指引，不再抛裸模块错误）
#   · 启动前预检后端端口占用（提示先 stop，不再等 node 抛 EADDRINUSE 堆栈）
#   · 停止提示排版修复（不再多打两行带缩进的空行）
set -euo pipefail
source "$(dirname "$0")/env.sh"

cd "$REPO_ROOT"

# New API 网关 best-effort 拉起（2026-10-07）：系统默认经网关接模型，网关
# 不在线则尝试 docker 拉起；失败不阻塞（系统仍可在 /models 页改回直连）。
if command -v docker >/dev/null 2>&1; then
  if ! curl -sf -m 2 http://127.0.0.1:3000/api/status >/dev/null 2>&1; then
    (docker start teamspace-new-api >/dev/null 2>&1 || docker compose -f deploy/docker-compose.newapi.yml up -d >/dev/null 2>&1) &
  fi
fi

# 依赖预检：没跑过 npm install 时给一句话指引，而不是 tsx/loader 原始报错。
if [ ! -d "$REPO_ROOT/node_modules" ]; then
  printf '✗ 还没有安装依赖 —— 先执行一次：\n\n    cd %s && npm install\n\n' "$REPO_ROOT" >&2
  exit 1
fi

# 端口占用预检（lsof 缺失时静默跳过，不阻塞启动）。
if command -v lsof >/dev/null 2>&1; then
  if lsof -nP -iTCP:"$APP_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
    printf '✗ 端口 %s 已被占用 —— 先执行 ./scripts/stop.sh（或 --check 看是谁），\n  或改 .env 里的 APP_PORT 换端口。\n' "$APP_PORT" >&2
    exit 1
  fi
fi

# 构建进启动脚本（A2 口径，MODULE-PLAN 第 3.5 节）：页面产物 dist/ 不入库，
# 启动前现构建 —— 构建失败 = 启动失败（fail fast，不带上旧产物裸奔）。
npm run build:web --silent

cat <<EOF

  teamspace-cordis 启动中 …

EOF
print_endpoints
say "环境       ${NODE_ENV:-development}"
say "停止       Ctrl-C"

# --env-file：Node 20.6+ 官方能力，比自写 dotenv 少一个依赖、少一处漂移
exec node --env-file="$ENV_FILE" --import tsx src/index.ts
