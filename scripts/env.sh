#!/usr/bin/env bash
# env.sh —— 所有运行脚本的公共前置：环境变量唯一出处 + 校验 + Node 运行时校验。
#
# 为什么单独抽一个文件：端口/主机这类值一旦散落在多个脚本里，迟早对不齐
# （上一版 teamspace 就吃过这个亏）。规矩是**只在 .env 定义一次**，
# 其它脚本 source 本文件后再用，谁也不许自带默认值。
#
# 用法（在其它脚本里）：
#   source "$(dirname "$0")/env.sh"
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$REPO_ROOT/.env"
ENV_EXAMPLE="$REPO_ROOT/.env.example"

# ── ① 首次运行：由模板生成 .env ────────────────────────────────────────
if [ ! -f "$ENV_FILE" ]; then
  cp "$ENV_EXAMPLE" "$ENV_FILE"
  printf '  · 已由 .env.example 生成 .env（首次运行）\n'
fi

# ── ② 载入 .env（set -a：所有变量自动导出给子进程）─────────────────────
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

# ── ③ 校验：缺一个就直接拒绝启动 ───────────────────────────────────────
# 宁可直接报错，也不要退回内置默认值悄悄跑歪 —— 那正是"端口不一致"的来源。
missing=""
for key in APP_HOST APP_PORT DEBUG_PORT CONSOLE_PORT TEAMSPACE_PORT; do
  if [ -z "${!key:-}" ]; then
    missing="${missing} ${key}"
  fi
done
if [ -n "$missing" ]; then
  printf '✗ .env 缺少必需变量：%s\n  请对照 %s 补齐（端口是全系统唯一出处）\n' \
    "$missing" "${ENV_EXAMPLE}" >&2
  exit 1
fi

# ── ④ Node 运行时解析 + 版本检查 ──────────────────────────────────────
# 生产环境默认使用系统 PATH；需要指定版本时可设置 NODE_BIN_DIR。
source "$(dirname "${BASH_SOURCE[0]}")/node-runtime.sh"
resolve_node_bin

say() { printf '  %s\n' "$*"; }

# start/dev 共用 APP_PORT 锁，在端口检查与 bind 之间防止并发竞态。
# exec 后文件描述符仍由 Node 进程持有，进程退出时自动释放 flock。
acquire_app_lock() {
  if ! command -v flock >/dev/null 2>&1; then
    printf '⚠ 未找到 flock，无法防止并发应用启动；请避免同时运行 npm start 和 npm run dev。\n' >&2
    return 0
  fi
  # Store the lock under data/, which remains shared when systemd uses PrivateTmp=true.
  # Keep the UID in the name so separate service accounts do not collide on file permissions.
  mkdir -p "$REPO_ROOT/data"
  APP_LOCK_FILE="$REPO_ROOT/data/.teamspace-cordis-app-${UID}-${APP_PORT}.lock"
  exec 9>"$APP_LOCK_FILE"
  if ! flock -n 9; then
    printf '✗ APP_PORT=%s 已有 Teamspace 实例或监视进程持有启动锁。\n  请先执行 ./scripts/stop.sh --check 检查，再停止旧的 npm start 或 npm run dev 进程。\n' "$APP_PORT" >&2
    return 1
  fi
  return 0
}

# 打印运行时端口一览（各脚本复用，保证输出口径一致）
# 2026-09-30 修正：5174 团队空间页面已启用（IM 式聊天，需登录）——
# 旧文案「暂未启用」与 check-web.sh 断言 5174 必须 200 矛盾。
print_endpoints() {
  say "后端监听   http://${APP_HOST}:${APP_PORT}   （健康检查 /healthz、认证 /api/auth/*）"
  say "调试控制台 http://${APP_HOST}:${DEBUG_PORT}   （插件 / 日志 / 数据库，无登录直达）"
  say "控制台 dev 端口 ${CONSOLE_PORT}（暂未启用）"
  say "团队空间   http://${APP_HOST}:${TEAMSPACE_PORT}   （IM 聊天页，注册 /login）"
}
