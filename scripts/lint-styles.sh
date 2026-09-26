#!/usr/bin/env bash
# lint-styles.sh —— 铁律 1（web 端 UI 禁止手写 / 自制样式）的门禁断言。
#
# 铁律正文在 .rules/IRON-RULES.md，本脚本只负责「把它变成会红的检查」。
# 铁律原文要求：断言必须**故意改坏一次确认它真的会红** —— 见文末自检记录。
#
# 扫描范围严格对齐铁律的「适用范围」：
#   ✅ 扫描：src/ plugins/ web/            （web 端产品界面代码）
#   ⬜ 不扫：docs/                          （一次性文档，铁律明确不覆盖）
#   ⬜ 不扫：node_modules/                  （第三方包自带样式，非我方代码）
#
# 用法：npm run lint:styles      （退出码 0 = 通过，1 = 判红）
#
# 实现注意（踩过的坑，别改回去）：grep 是 GNU grep，**没有** --glob 参数
# （那是 ripgrep 的）。用 --glob 会让 grep 直接报错退出，而错误被 `|| true`
# 吃掉后表现为「什么都扫不到」—— 门禁永远绿，等于空断言。
# 因此这里只用 GNU grep 支持的 --exclude-dir / --include，文件枚举用 find。
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

fail=0
report() { printf '  ✗ %s\n' "$*"; fail=1; }
note()   { printf '  · %s\n' "$*"; }

printf '铁律 1 门禁：web 端 UI 禁止手写 / 自制样式\n'

# ── 扫描范围 ────────────────────────────────────────────────────────────
scan_dirs=()
for d in src plugins web; do
  [ -d "$d" ] && scan_dirs+=("$d")
done

if [ "${#scan_dirs[@]}" -eq 0 ]; then
  note 'src/ plugins/ web/ 都不存在，无代码可扫（不是错误）'
fi

EXCLUDE_DIRS=(--exclude-dir=node_modules --exclude-dir=dist --exclude-dir=build --exclude-dir=.git)
SRC_INCLUDES=(--include='*.ts' --include='*.tsx' --include='*.js' --include='*.jsx'
              --include='*.mjs' --include='*.cjs' --include='*.vue' --include='*.html')

# ── 断言 ①：不许有自写样式文件 ──────────────────────────────────────────
# 样式文件的出现本身就是判红条件，不需要看内容。
stylefiles=()
if [ "${#scan_dirs[@]}" -gt 0 ]; then
  while IFS= read -r f; do
    [ -n "$f" ] && stylefiles+=("$f")
  done < <(find "${scan_dirs[@]}" -type f \
             \( -name '*.css' -o -name '*.scss' -o -name '*.sass' \
                -o -name '*.less' -o -name '*.styl' -o -name '*.vue' \) \
             -not -path '*/node_modules/*' -not -path '*/dist/*' 2>/dev/null)
fi

if [ "${#stylefiles[@]}" -gt 0 ]; then
  report '出现自写样式文件 / 单文件组件（铁律 1 判红条件）：'
  printf '      %s\n' "${stylefiles[@]}"
  note '样式只能来自组件库 props、布局原语、设计令牌 —— 不许新建文件定义'
else
  note '① 无自写样式文件 ✅'
fi

# ── 断言 ②：源码里不许有内联样式 ────────────────────────────────────────
inline_hits=""
if [ "${#scan_dirs[@]}" -gt 0 ]; then
  inline_hits="$(grep -rnE 'style[[:space:]]*=|:style[[:space:]]*=|v-bind:style' \
      "${SRC_INCLUDES[@]}" "${EXCLUDE_DIRS[@]}" "${scan_dirs[@]}" 2>/dev/null || true)"
fi

if [ -n "$inline_hits" ]; then
  report '出现内联样式（铁律 1 判红条件）：'
  printf '%s\n' "$inline_hits" | sed 's/^/      /'
else
  note '② 无内联样式 ✅'
fi

# ── 断言 ③：源码里不许有自写样式块与硬编码视觉值 ────────────────────────
hard_hits=""
if [ "${#scan_dirs[@]}" -gt 0 ]; then
  hard_hits="$(grep -rnE '#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?\b|rgba?\(|hsla?\(|<style|StyleSheet\.create' \
      "${SRC_INCLUDES[@]}" "${EXCLUDE_DIRS[@]}" "${scan_dirs[@]}" 2>/dev/null || true)"
fi

if [ -n "$hard_hits" ]; then
  report '出现硬编码颜色 / 自写样式块（铁律 1 判红条件）：'
  printf '%s\n' "$hard_hits" | sed 's/^/      /'
else
  note '③ 无硬编码颜色、无 <style> 块 ✅'
fi

# ── 断言 ④：选型没有被悄悄换掉 ──────────────────────────────────────────
# 铁律「选型」表定死了组件库与外壳，这几项一旦被换掉，前面三条的通过就没有意义。
# 检查 node_modules 里**实际装到**的版本（不是 package.json 里的声明）——
# @cordisjs/components 是外壳的传递依赖，不由我们直接声明，所以才要按实际解析查。
NODE_BIN="${NODE_BIN_DIR:-/home/ia3000/SPM/.toolchain/node24/bin}/node"
if [ -x "$NODE_BIN" ]; then
  sel_check="$("$NODE_BIN" -e '
    const fs = require("node:fs");
    const required = {
      "@cordisjs/components": "组件库",
      "@cordisjs/client": "平台外壳",
      "@cordisjs/plugin-webui": "webui 服务",
      "@cordisjs/plugin-loader-webui": "插件系统查看页",
      "@cordisjs/plugin-logger-webui": "日志系统页",
      "@cordisjs/plugin-database-webui": "数据库系统页",
    };
    const bad = [];
    const ok = [];
    for (const [name, why] of Object.entries(required)) {
      const pj = `node_modules/${name}/package.json`;
      if (!fs.existsSync(pj)) { bad.push(`${name} 未安装（${why}）`); continue; }
      try { ok.push(`${name}@${JSON.parse(fs.readFileSync(pj, "utf8")).version}`); }
      catch { bad.push(`${name} 的 package.json 读不了（${why}）`); }
    }
    if (bad.length) process.stdout.write("BAD\n" + bad.join("\n"));
    else process.stdout.write("OK\n" + ok.join("  "));
  ' 2>/dev/null || true)"

  case "$sel_check" in
    OK*)
      note "④ 选型依赖齐全：$(printf '%s' "$sel_check" | tail -n +2) ✅"
      ;;
    BAD*)
      report '铁律选型表里的依赖不对：'
      printf '%s\n' "$sel_check" | tail -n +2 | sed 's/^/      /'
      note '选型要换，先改 .rules/IRON-RULES.md 的选型表，再改代码'
      ;;
    *)
      note '④ 选型依赖检查执行异常（未计入判红）'
      ;;
  esac
else
  note "④ 跳过选型依赖检查（找不到 node：$NODE_BIN）"
fi

# ── 结论 ────────────────────────────────────────────────────────────────
echo
if [ "$fail" -ne 0 ]; then
  printf '✗ 铁律 1 门禁未通过。规矩见 .rules/IRON-RULES.md（铁律 1 · 落地动作）\n'
  exit 1
fi
printf '✓ 铁律 1 门禁通过\n'

# 自检记录（2026-09-27 实测）：
#   ① 建 plugins/__lintprobe.css                    → 断言 ① 红
#   ② 在 plugins/__lintprobe.ts 写 style="color:#f00" → 断言 ②③ 红
#   ③ 移走 node_modules/@cordisjs/components         → 断言 ④ 红
#   三种改坏都确认会让脚本以退出码 1 结束，复原后回到 0。