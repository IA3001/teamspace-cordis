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
# Node --watch 保留父监视进程；只杀监听端口的子进程会让它稍后重新启动。
# 仅识别当前 checkout、当前 .env 启动的主应用 watcher，并先显示在 --check 中。
watcher_pids=()
if command -v pgrep >/dev/null 2>&1; then
  while IFS= read -r pid; do
    [ -n "$pid" ] || continue
    [ "$(ps -p "$pid" -o comm= 2>/dev/null | tr -d ' ')" = "node" ] || continue
    cmd="$(ps -p "$pid" -o args= 2>/dev/null || true)"
    case "$cmd" in
      *"node --watch --env-file=$ENV_FILE --import tsx src/index.ts"*) ;;
      *) continue ;;
    esac
    cwd="$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -n 1)"
    [ "$cwd" = "$REPO_ROOT" ] || continue
    watcher_pids+=("$pid")
  done < <(pgrep -f 'node --watch.*src/index.ts' || true)
fi

descendant_pids() {
  local parent="$1" child
  for child in $(pgrep -P "$parent" 2>/dev/null || true); do
    [ -n "$child" ] || continue
    descendant_pids "$child"
    printf '%s\n' "$child"
  done
}

if [ "${#watcher_pids[@]}" -gt 0 ]; then
  found=1
  if $CHECK_ONLY; then
    say "当前仓库开发 watcher：PID ${watcher_pids[*]}（停止时会一并关闭其子进程）"
  else
    for pid in "${watcher_pids[@]}"; do
      kill -0 "$pid" 2>/dev/null || continue
      printf '  开发 watcher PID %s → 停止进程树 …' "$pid"
      children="$(descendant_pids "$pid" || true)"
      # 先停 watcher，关闭自动重启窗口；再清理它未能回收的所有后代。
      kill "$pid" 2>/dev/null || true
      forced=false
      for _ in 1 2 3; do
        kill -0 "$pid" 2>/dev/null || break
        sleep 1
      done
      if kill -0 "$pid" 2>/dev/null; then
        kill -9 "$pid" 2>/dev/null || true
        forced=true
      fi
      for child in $children; do
        kill -0 "$child" 2>/dev/null && kill "$child" 2>/dev/null || true
      done
      for _ in 1 2 3; do
        alive=false
        for child in $children; do
          kill -0 "$child" 2>/dev/null && alive=true
        done
        $alive || break
        sleep 1
      done
      for child in $children; do
        if kill -0 "$child" 2>/dev/null; then
          kill -9 "$child" 2>/dev/null || true
          forced=true
        fi
      done
      if $forced; then
        printf ' 已强制清理\n'
      else
        printf ' 已停止\n'
      fi
    done
  fi
fi

listener_pids() {
  lsof -nP -tiTCP:"$1" -sTCP:LISTEN 2>/dev/null || true
}

is_repo_app_process() {
  local pid="$1" cwd cmd
  cwd="$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -n 1)"
  [ "$cwd" = "$REPO_ROOT" ] || return 1
  cmd="$(ps -p "$pid" -o args= 2>/dev/null || true)"
  [[ "$cmd" == *"--env-file=$ENV_FILE"* && "$cmd" == *"src/index.ts"* ]]
}

# DEBUG_PORT 必须在列 —— 5172 是铁律 2 要求常驻的开发设施，漏了它就会出现
# 「以为停了服务、其实 5172 还活着」的假象（P0 实测踩到过，见已知缺陷 D1）。
for port in "$APP_PORT" "$DEBUG_PORT" "$CONSOLE_PORT" "$TEAMSPACE_PORT"; do
  all_pids="$(listener_pids "$port")"
  if [ -z "$all_pids" ]; then
    continue
  fi
  pids=""
  foreign_pids=""
  for pid in $all_pids; do
    if is_repo_app_process "$pid"; then
      pids="${pids}${pids:+$'\n'}$pid"
    else
      foreign_pids="${foreign_pids}${foreign_pids:+$'\n'}$pid"
    fi
  done
  if $CHECK_ONLY; then
    if [ -n "$pids" ]; then
      found=1
      say "端口 ${port} 由当前仓库服务监听：PID ${pids}"
    fi
    if [ -n "$foreign_pids" ]; then
      found=1
      say "端口 ${port} 由其他工作目录的进程监听，停止命令会保留：PID ${foreign_pids}"
    fi
    continue
  fi
  if [ -z "$pids" ]; then
    found=1
    say "端口 ${port} 的监听者不属于当前仓库，已保留：PID ${foreign_pids}"
    continue
  fi
  found=1
  printf '  端口 %s → 停止 PID %s …' "$port" "$pids"
  kill $pids 2>/dev/null || true
  for _ in 1 2 3; do
    remaining=""
    for pid in $(listener_pids "$port"); do
      is_repo_app_process "$pid" && remaining="${remaining}${remaining:+$'\n'}$pid"
    done
    [ -n "$remaining" ] || break
    sleep 1
  done
  remaining=""
  for pid in $(listener_pids "$port"); do
    is_repo_app_process "$pid" && remaining="${remaining}${remaining:+$'\n'}$pid"
  done
  if [ -n "$remaining" ]; then
    pids="$remaining"
    kill -9 $pids 2>/dev/null || true
    printf ' 已强杀\n'
  else
    printf ' 已停止\n'
  fi
done

if [ "$found" = 0 ]; then
  say "没有进程占用这些端口（${APP_PORT}/${DEBUG_PORT}/${CONSOLE_PORT}/${TEAMSPACE_PORT}）"
fi
