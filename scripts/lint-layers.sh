#!/usr/bin/env bash
# lint-layers.sh —— 分层章程的静态判红器（docs/ARCHITECTURE.md 第三节的机械检查）。
#
# 规矩（先立后行）：
#   1. packages/client-ui/** 的客户端源码（client/ 目录）禁止 import 任何
#      服务端包：space-*（除 space-client-ui-shared）、packages/impl/**、
#      packages/policy/**、plugins/** —— 显示/交互层只认 RPC 契约。
#   2. packages/impl/** 与 plugins/** 禁止 import 其它 impl 实现细节
#      （跨实现复用必须下沉成 seam 依赖）。
#   3. plugins/orchestrator（流转层）禁止 import agent-runtime/workdir 的
#      实现模块 —— 流转层只调度，通过事件与 seam 服务说话。
# 本脚本为静态 grep 级检查：有少量豁免需求时，在行尾加 `# layer:allow` 注释。
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

fail=0

# 规矩 1：客户端源码不得 import 服务端包。
while IFS= read -r -d '' f; do
  if grep -nE "from 'space-(session|event|staging|identity|message|memory|retrieval|context|tool|llm|agent|orchestrator|command)'" "$f" | grep -v 'layer:allow' >/dev/null 2>&1; then
    printf '✗ [L12 违章] %s：客户端不得 import 服务端 seam\n' "$f"
    fail=1
  fi
  if grep -nE "from '.*((packages/impl)|(packages/policy)|(plugins))/" "$f" | grep -v 'layer:allow' >/dev/null 2>&1; then
    printf '✗ [L12 违章] %s：客户端不得 import impl/policy/plugins 实现\n' "$f"
    fail=1
  fi
done < <(find packages/client-ui -path '*/client/*' -name '*.ts' -not -path '*/node_modules/*' -print0)

# 规矩 2：impl 之间禁止互相 import（跨实现复用必须走 seam）。
for impl in packages/impl/*/src; do
  own="$(basename "$(dirname "$impl")")"
  while IFS= read -r f; do
    while IFS= read -r dep; do
      other="$(basename "$dep")"
      [ "$other" = "$own" ] && continue
      printf '✗ [impl 违章] %s：impl/%s import 了 impl/%s（应下沉成 seam 依赖）\n' "$f" "$own" "$other"
      fail=1
    done < <(grep -oE "from '(space-[a-z-]+)/(src/)?" "$f" | sed "s/from '//; s|/(src/)\?||" | sort -u | grep -v '^$' || true)
  done < <(find "$impl" -name '*.ts' -print0)
done

# 规矩 3：流转层不得摸 Agent 实现细节。
if grep -rnE "from '.*(space-agent-runtime|space-workdir-local)/" plugins/orchestrator/ | grep -v 'layer:allow' >/dev/null 2>&1; then
  printf '✗ [L7 违章] plugins/orchestrator：流转层不得 import Agent 实现（只准走事件与 seam）\n'
  fail=1
fi

if [ "$fail" -eq 0 ]; then
  printf '✓ 分层章程检查通过（docs/ARCHITECTURE.md）\n'
else
  printf '✗ 存在分层违章 —— 依据 docs/ARCHITECTURE.md 修复\n'
  exit 1
fi
