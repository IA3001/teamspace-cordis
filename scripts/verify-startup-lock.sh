#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if ! command -v flock >/dev/null 2>&1; then
  printf '· 跳过启动互斥验收：当前环境没有 flock（启动脚本会提示该限制）\n'
  exit 0
fi

runtime_dir="$(mktemp -d)"
ready_file="$runtime_dir/holder.ready"
isolated_tmp="$runtime_dir/isolated-tmp"
mkdir -p "$isolated_tmp"
port=65431
export XDG_RUNTIME_DIR="$runtime_dir"
trap 'if [ -n "${holder_pid:-}" ]; then kill "$holder_pid" 2>/dev/null || true; wait "$holder_pid" 2>/dev/null || true; fi; rm -rf "$runtime_dir"' EXIT

(
  source "$ROOT/scripts/env.sh"
  APP_PORT="$port"
  acquire_app_lock
  : > "$ready_file"
  exec sleep 30
) &
holder_pid=$!

for _ in $(seq 1 200); do
  [ -f "$ready_file" ] && break
  kill -0 "$holder_pid" 2>/dev/null || { printf '✗ 启动锁持有进程意外退出\n' >&2; exit 1; }
  sleep 0.01
done
[ -f "$ready_file" ] || { printf '✗ 启动锁持有进程未就绪\n' >&2; exit 1; }

if output="$(XDG_RUNTIME_DIR="$isolated_tmp" TMPDIR="$isolated_tmp" bash -c 'source "$1"; APP_PORT="$2"; acquire_app_lock' _ "$ROOT/scripts/env.sh" "$port" 2>&1)"; then
  printf '✗ 同端口的第二个 Teamspace 进程未被启动锁拦截\n' >&2
  exit 1
fi
[[ "$output" == *"已有 Teamspace 实例或监视进程持有启动锁"* ]] || {
  printf '✗ 竞争启动失败原因不符合预期：%s\n' "$output" >&2
  exit 1
}
printf '✓ 使用独立临时目录的竞争进程仍被共享启动锁拒绝\n'

kill "$holder_pid"
wait "$holder_pid" 2>/dev/null || true
unset holder_pid
bash -c 'source "$1"; APP_PORT="$2"; acquire_app_lock' _ "$ROOT/scripts/env.sh" "$port"
printf '✓ 持锁进程退出后，同端口可以重新启动\n'
