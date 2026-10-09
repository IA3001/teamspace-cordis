// md.ts —— AI/系统消息的轻量 Markdown 渲染（够用即止，手写分词，不做完整 parser）。
// 安全铁律：全部用 h() 分词渲染，零 v-html / innerHTML；pre/code 是语义标签不是样式。
// 支持语法：
//   a. 代码块：``` 围栏 → pre > code（逐字保留原文，无嵌套解析）；
//   b. 行内代码 `code` → code 标签；
//   c. 粗体 **text** → b 标签；
//   d. 链接 http(s)://… → a 标签（新窗打开，文本取域名缩写）；
//   e. 其余原样文本节点。
// 确定性优先：未闭合围栏（``` 出现奇数次）整体按普通文本兜底。
import type { VNode } from 'vue'

/** 行内分词：行内代码 / 粗体 / 链接，按出现顺序切分（单行内不嵌套）。 */
const INLINE_RE = /`([^`]+)`|\*\*([^*]+)\*\*|(https?:\/\/[^\s]+)/g

/** 链接显示文本：协议后的域名缩写（如 https://a.b/c → a.b）。 */
function shortHost(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

/** 单行行内分词渲染：命中的片段渲染成对应标签，其余原样文本。 */
function renderInline(line: string, h: Function, comps: { ElText: any }): VNode[] {
  const out: VNode[] = []
  let last = 0
  for (const m of line.matchAll(INLINE_RE)) {
    const i = m.index ?? 0
    if (i > last) out.push(h(comps.ElText, {}, { default: () => line.slice(last, i) }))
    if (m[1] !== undefined) {
      // 行内代码
      out.push(h('code', m[1]))
    } else if (m[2] !== undefined) {
      // 粗体
      out.push(h('b', m[2]))
    } else if (m[3] !== undefined) {
      // 链接：新窗打开，显示域名缩写
      out.push(h('a', { href: m[3], target: '_blank' }, shortHost(m[3])))
    }
    last = i + m[0].length
  }
  if (last < line.length) out.push(h(comps.ElText, {}, { default: () => line.slice(last) }))
  return out
}

/**
 * 轻量 Markdown → VNode 列表。
 * @param text 原始消息文本
 * @param h Vue 的 h 函数（调用方传入，避免额外依赖）
 * @param comps 外壳组件表（纯文本段用 ElText 渲染，保持语义一致）
 */
export function renderMarkdown(text: string, h: Function, comps: { ElText: any }): VNode[] {
  const out: VNode[] = []
  // 围栏切分：``` 出现偶数次才按代码块解析；奇数次（未闭合）整段普通文本兜底。
  const fences = text.split('```')
  if (fences.length % 2 === 0) {
    // 未闭合围栏：按普通文本走（确定性优先）。
    return renderInline(text, h, comps)
  }
  for (let i = 0; i < fences.length; i++) {
    const seg = fences[i]!
    if (i % 2 === 1) {
      // 围栏内：逐字保留原文进 code（去掉可能残留的首个换行，由语言标记行产生）。
      const body = seg.startsWith('\n') ? seg.slice(1) : seg
      out.push(h('pre', h('code', body)))
    } else if (seg) {
      // 普通段：逐行行内分词，行间用 br 保留换行结构。
      const lines = seg.split('\n')
      lines.forEach((line, li) => {
        if (li > 0) out.push(h('br'))
        out.push(...renderInline(line, h, comps))
      })
    }
  }
  return out
}
