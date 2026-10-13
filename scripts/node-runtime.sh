#!/usr/bin/env bash
# Shared Node.js resolution and minimum-version check for project scripts.

resolve_node_bin() {
  local candidate
  if [ -n "${NODE_BIN:-}" ]; then
    candidate="$NODE_BIN"
  elif [ -n "${NODE_BIN_DIR:-}" ]; then
    candidate="${NODE_BIN_DIR%/}/node"
  else
    candidate="$(command -v node 2>/dev/null || true)"
  fi

  if [ -z "$candidate" ] || [ ! -x "$candidate" ]; then
    printf '✗ 找不到可执行的 Node.js；请安装 Node ≥ 22.18 或设置 NODE_BIN_DIR\n' >&2
    return 1
  fi
  if ! "$candidate" -e 'const [major, minor] = process.versions.node.split(".").map(Number); if (major < 22 || (major === 22 && minor < 18)) process.exit(1)'; then
    printf '✗ Node 版本过低：%s（需要 ≥ 22.18）\n' "$($candidate -v)" >&2
    return 1
  fi

  NODE_BIN="$candidate"
  NODE_BIN_DIR="$(dirname "$candidate")"
  export NODE_BIN NODE_BIN_DIR
  PATH="$NODE_BIN_DIR:$PATH"
  export PATH
}
