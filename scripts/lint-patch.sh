#!/usr/bin/env bash
# lint-patch.sh —— patch 层数门禁（断言 ③，P5 新增第十门禁）。
#
# 断言出处：dev-cordis/MODULE-PLAN.md 第 6 节断言 ③ + 铁律 3。
#   · 断言 ③ 同 id 最多两层 —— 任一插件 id 最多出现在「一个 bundle 层文件 + 一个
#     用户层文件」；bundle 层之间同 id、用户层文件之间同 id、总层数超 2，均判红。
#   · 附带校验：patch 文件可解析（!!js 原文透传不求值）、顶层必须是数组、
#     每行有 id 且层内不重复。
#
# 唯一出处是那张表，本脚本只做「把它变成会红的检查」。**改表必须同时改这里。**
#
# 用法：npm run lint:patch    （退出码 0 = 通过，1 = 判红）
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

source "$REPO_ROOT/scripts/node-runtime.sh"
resolve_node_bin

printf 'patch 层数门禁：断言 ③（同 id 最多「一个 bundle 层 + 用户层」）\n'

"$NODE_BIN" --import tsx src/compose-cli.ts --lint || exit 1

# 断言 ⑨：跑过就留痕（失败不记 —— 失败要人看，不属于"悄悄跑过"）
"$NODE_BIN" scripts/record-action.mjs "gate:lint-patch" '{"ok":true}' || true
