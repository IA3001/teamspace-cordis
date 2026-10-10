# build-theme.py —— 生成 packages/client-ui/space-client-ui-shared/client/theme.ts
# （令牌 light-dark + im.css 内容 JSON 安全内联）。避免 heredoc 转义坑。
import json, re, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
theme_dir = ROOT / "packages/client-ui/space-client-ui-shared/client"
imcss = (theme_dir / "im.css").read_text(encoding="utf-8")

tokens = """:root {
  color-scheme: light dark;
  --el-color-primary: light-dark(#3056d3, #7c93f0);
  --el-color-primary-light-3: light-dark(#5c78dd, #93a5f2);
  --el-color-primary-light-5: light-dark(#87a0e7, #5c6ea8);
  --el-color-primary-light-7: light-dark(#b3c4f0, #3d4a78);
  --el-color-primary-light-8: light-dark(#c9d5f5, #333e66);
  --el-color-primary-light-9: light-dark(#e8edfa, #262d47);
  --el-color-primary-dark-2: light-dark(#2645a8, #9db1f5);
  --el-color-success: light-dark(#2e9e6b, #4fbf8b);
  --el-color-warning: light-dark(#d98634, #e0a04e);
  --el-color-danger: light-dark(#d44546, #e06c6c);
  --el-color-error: light-dark(#d44546, #e06c6c);
  --el-color-info: light-dark(#6b7280, #9ca3af);
  --el-border-radius-base: 6px;
  --el-border-radius-small: 4px;
  --el-border-radius-round: 999px;
  --el-border-color: light-dark(#d9dce3, #3a3f4a);
  --el-border-color-light: light-dark(#e3e6ec, #333842);
  --el-border-color-lighter: light-dark(#eaecf1, #2c3038);
  --el-bg-color: light-dark(#ffffff, #22262e);
  --el-bg-color-page: light-dark(#f5f6f8, #171a20);
  --el-fill-color: light-dark(#f0f1f4, #2a2f38);
  --el-fill-color-light: light-dark(#f2f3f6, #262b33);
  --el-fill-color-lighter: light-dark(#f7f8fa, #22262e);
  --el-fill-color-blank: light-dark(#ffffff, #22262e);
  --el-text-color-primary: light-dark(#1f2329, #e8eaee);
  --el-text-color-regular: light-dark(#363b45, #c6cad2);
  --el-text-color-secondary: light-dark(#626b7a, #a3aab6);
  --el-box-shadow-light: 0 1px 2px rgba(0, 0, 0, .08), 0 4px 14px rgba(0, 0, 0, .10);
  --el-box-shadow: 0 2px 6px rgba(0, 0, 0, .12), 0 10px 24px rgba(0, 0, 0, .16);
  --el-font-family: "PingFang SC", "HarmonyOS Sans SC", "Microsoft YaHei",
    -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
}
.el-card {
  --el-card-border-radius: 12px;
  border: 1px solid var(--el-border-color-lighter);
  box-shadow: var(--el-box-shadow-light);
}
.el-button { font-weight: 500; }
.el-tag { border-radius: 4px; font-weight: 500; }
.el-dialog { --el-dialog-border-radius: 12px; }
"""

header = """// theme.ts —— 全站设计令牌 + 聊天骨架样式（铁律 1 修订记账的唯一例外文件）。
// 令牌 light-dark() 自适应明暗；.sp-* 为聊天骨架样式（边界见 im.css 头注）。
// ⚠ 本文件由 scripts/build-theme.py 生成：改样式请改 im.css 后重跑该脚本。
import { defineComponent, h } from 'vue'

const css = `"""

content = (
    header + "\n" + tokens + "\n` +\n  " + json.dumps(imcss) + "\n\n"
    + "/** 全站主题节点：页面根数组第一个元素渲染一次（CSS 全局生效，幂等）。 */\n"
    + "export const ThemeStyle = defineComponent({\n"
    + "  name: 'SpaceThemeStyle',\n"
    + "  setup() {\n"
    + "    return () => h('style', { 'data-space-theme': '' }, css)\n"
    + "  },\n"
    + "})\n"
)

# 校验：恰好两个反引号（模板开合），imcss 只以 JSON 字符串出现
assert len(re.findall(r"`", content)) == 2, "backtick count != 2"
(theme_dir / "theme.ts").write_text(content, encoding="utf-8")
print("theme.ts 已生成，行数:", content.count("\n"), "| backticks: 2 | 含 sp-msg:", ".sp-msg" in content)
