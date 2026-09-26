#!/usr/bin/env bash
# env.sh —— 所有运行脚本的公共前置：环境变量唯一出处 + 校验 + Node 指路。
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
for key in APP_HOST APP_PORT CONSOLE_PORT TEAMSPACE_PORT; do
  if [ -z "${!key:-}" ]; then
    missing="${missing} ${key}"
  fi
done
if [ -n "$missing" ]; then
  printf '✗ .env 缺少必需变量：%s\n  请对照 %s 补齐（端口是全系统唯一出处）\n' \
    "$missing" "${ENV_EXAMPLE}" >&2
  exit 1
fi

# ── ④ Node 运行时指路 ──────────────────────────────────────────────────
# WSL 里 node 不在 PATH（系统 /usr/bin/node 不存在），统一在这里指定。
# 可用 NODE_BIN_DIR 覆盖。
export PATH="${NODE_BIN_DIR:-/home/ia3000/SPM/.toolchain/node/bin}:$PATH"

command -v node >/dev/null 2>&1 || {
  printf '✗ 找不到 node（期望在 %s）\n' "${NODE_BIN_DIR:-/home/ia3000/SPM/.toolchain/node/bin}" >&2
  exit 1
}

say() { printf '  %s\n' "$*"; }

# 打印运行时端口一览（各脚本复用，保证输出口径一致）
print_endpoints() {
  say "后端监听   http://${APP_HOST}:${APP_PORT}   （健康检查 /healthz）"
  say "控制台 dev 端口 ${CONSOLE_PORT}（Vite，暂未启用）"
  say "团队空间 dev 端口 ${TEAMSPACE_PORT}（Vite，暂未启用）"
}