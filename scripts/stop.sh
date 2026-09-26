#!/usr/bin/env bash
# stop.sh —— 按端口停掉本项目的进程。
#
# 用法：
#   ./scripts/stop.sh          停掉 .env 里那几个端口上的进程
#   ./scripts/stop.sh --check  只看谁占着，不杀
#
# 为什么按端口找而不是按进程名：进程名会变（node / tsx / npm 各不相同），
# 端口来自 .env 是稳定且唯一的标识 —— 和启动用的是同一份口径。
set -euo pipefail
source "$(dirname "$0")/env.sh"

CHECK_ONLY=false
[ "${1:-}" = "--check" ] && CHECK_ONLY=true

if ! command -v lsof >/dev/null 2>&1; then
  printf '✗ 需要 lsof 才能按端口定位进程（sudo apt install lsof）\n' >&2
  exit 1
fi

found=0
# DEBUG_PORT 必须在列 —— 5172 是铁律 2 要求常驻的开发设施，漏了它就会出现
# 「以为停了服务、其实 5172 还活着」的假象（P0 实测踩到过，见已知缺陷 D1）。
for port in "$APP_PORT" "$DEBUG_PORT" "$CONSOLE_PORT" "$TEAMSPACE_PORT"; do
  pids="$(lsof -ti:"$port" 2>/dev/null || true)"
  if [ -z "$pids" ]; then
    continue
  fi
  found=1
  if $CHECK_ONLY; then
    say "端口 ${port} 被占用：PID ${pids}"
    continue
  fi
  printf '  端口 %s → 停止 PID %s …' "$port" "$pids"
  kill $pids 2>/dev/null || true
  for _ in 1 2 3; do
    lsof -ti:"$port" >/dev/null 2>&1 || break
    sleep 1
  done
  if lsof -ti:"$port" >/dev/null 2>&1; then
    kill -9 $pids 2>/dev/null || true
    printf ' 已强杀\n'
  else
    printf ' 已停止\n'
  fi
done

if [ "$found" = 0 ]; then
  say "没有进程占用这些端口（${APP_PORT}/${DEBUG_PORT}/${CONSOLE_PORT}/${TEAMSPACE_PORT}）"
fi