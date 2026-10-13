import { ref } from 'vue'
import type { VNode } from 'vue'
import hljs from 'highlight.js/lib/core'
import javascript from 'highlight.js/lib/languages/javascript'
import typescript from 'highlight.js/lib/languages/typescript'
import json from 'highlight.js/lib/languages/json'
import python from 'highlight.js/lib/languages/python'
import bash from 'highlight.js/lib/languages/bash'
import css from 'highlight.js/lib/languages/css'
import xml from 'highlight.js/lib/languages/xml'
import yaml from 'highlight.js/lib/languages/yaml'
import sql from 'highlight.js/lib/languages/sql'

for (const [name, language] of Object.entries({ javascript, typescript, json, python, bash, css, xml, yaml, sql })) {
  hljs.registerLanguage(name, language)
}
hljs.registerAliases(['js', 'mjs', 'cjs'], { languageName: 'javascript' })
hljs.registerAliases(['ts'], { languageName: 'typescript' })
hljs.registerAliases(['sh', 'shell'], { languageName: 'bash' })
hljs.registerAliases(['html', 'svg'], { languageName: 'xml' })

function decodeHighlightText(text: string): string {
  return text.replace(/&(?:amp|lt|gt|quot|#x27|#39);/g, (entity) => ({
    '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#x27;': "'", '&#39;': "'",
  })[entity] ?? entity)
}

/** Convert highlight.js's escaped output into VNodes; code never enters v-html. */
function highlightedNodes(source: string, h: Function, language: string): VNode[] {
  if (!hljs.getLanguage(language)) return [h('span', source)]
  const html = hljs.highlight(source, { language, ignoreIllegals: true }).value
  const roots: VNode[] = []
  const stack: Array<{ scope: string[]; children: VNode[] }> = [{ scope: [], children: roots }]
  const tokens = /<span class="((?:[a-z0-9_-]+)(?:\s+[a-z0-9_-]+)*)">|<\/span>|&(?:amp|lt|gt|quot|#x27|#39);/gi
  let cursor = 0
  for (const match of html.matchAll(tokens)) {
    const index = match.index ?? 0
    if (index > cursor) stack.at(-1)!.children.push(h('span', html.slice(cursor, index)))
    if (match[1]) {
      const classes = match[1].split(/\s+/)
      if (classes.some((name) => !/^(?:hljs-[a-z0-9_-]+|[a-z][a-z0-9_-]*)$/i.test(name)) || !classes.some((name) => name.startsWith('hljs-'))) {
        stack.at(-1)!.children.push(h('span', match[0]))
      } else {
        stack.push({ scope: classes, children: [] })
      }
    } else if (match[0] === '</span>') {
      if (stack.length > 1) {
        const frame = stack.pop()!
        stack.at(-1)!.children.push(h('span', { class: frame.scope }, frame.children))
      } else stack.at(-1)!.children.push(h('span', '</span>'))
    } else {
      stack.at(-1)!.children.push(h('span', decodeHighlightText(match[0])))
    }
    cursor = index + match[0].length
  }
  if (cursor < html.length) stack.at(-1)!.children.push(h('span', html.slice(cursor)))
  while (stack.length > 1) {
    const frame = stack.pop()!
    stack.at(-1)!.children.push(h('span', { class: frame.scope }, frame.children))
  }
  return roots
}

function cleanSourceList(text: string): string {
  const marker = '参考来源（本轮检索命中）：'
  const start = text.lastIndexOf(marker)
  if (start < 0) return text

  const body = text.slice(0, start).trimEnd()
  const rows = text.slice(start + marker.length).split('\n')
  const references = rows.flatMap((line) => {
    const match = /^\s*-\s*【来源:(event|memory|kb):([^】]+)】(.*)$/.exec(line)
    if (!match) return []
    const [, kind, id, rawLabel] = match
    const label = rawLabel!.replace(/，(?:依据事件|文档 ID).*/, '').trim() ||
      (kind === 'kb' ? '知识库文档' : kind === 'memory' ? 'Agent 记忆' : '会话消息')
    if (kind === 'event') return [`- [${label}](#space-event-${id})`]
    return [`- ${kind === 'kb' ? '知识库 · ' : '记忆 · '}${label}`]
  })
  return references.length ? `${body}\n\n### 参考来源\n\n${references.join('\n')}` : text
}

export interface AgentWorklogView {
  label: string
  at: string
  kind?: 'phase' | 'tool'
  status?: 'running' | 'success' | 'failed'
  detail?: string
  toolId?: string
  inputSummary?: string
  resultSummary?: string
  durationMs?: number
}

/** Extract the compact, persisted milestone list from an Agent receipt. */
export function extractAgentWorklog(
  text: string,
  toolCalls: Array<{ name: string; args: string }> = [],
): { text: string; steps: AgentWorklogView[] } {
  const saved = toolCalls.find((call) => call.name === 'agent.worklog')
  if (saved) {
    try {
      const parsed: unknown = JSON.parse(saved.args)
      const steps = Array.isArray(parsed)
        ? parsed.flatMap((item): AgentWorklogView[] =>
          item && typeof item.label === 'string' && typeof item.at === 'string'
            ? [{
              label: item.label, at: item.at,
              ...(item.kind === 'tool' || item.kind === 'phase' ? { kind: item.kind } : {}),
              ...(item.status === 'running' || item.status === 'success' || item.status === 'failed' ? { status: item.status } : {}),
              ...(typeof item.detail === 'string' ? { detail: item.detail.slice(0, 500) } : {}),
              ...(typeof item.toolId === 'string' ? { toolId: item.toolId.slice(0, 120) } : {}),
              ...(typeof item.inputSummary === 'string' ? { inputSummary: item.inputSummary.slice(0, 600) } : {}),
              ...(typeof item.resultSummary === 'string' ? { resultSummary: item.resultSummary.slice(0, 1200) } : {}),
              ...(Number.isFinite(item.durationMs) ? { durationMs: Math.max(0, Math.min(3_600_000, item.durationMs)) } : {}),
            }]
            : [])
        : []
      return { text, steps }
    } catch { /* Legacy marker parsing below remains available for older receipts. */ }
  }
  const marker = '【工作记录】\n'
  const start = text.lastIndexOf(marker)
  if (start < 0) return { text, steps: [] }
  const payloadStart = start + marker.length
  const candidates = ['\n【工作区】', '\n【产物清单】'].map((item) => text.indexOf(item, payloadStart)).filter((index) => index >= 0)
  const end = candidates.length ? Math.min(...candidates) : text.length
  let steps: AgentWorklogView[] = []
  try {
    const parsed: unknown = JSON.parse(text.slice(payloadStart, end).trim())
    if (Array.isArray(parsed)) {
      steps = parsed.flatMap((item): AgentWorklogView[] =>
        item && typeof item.label === 'string' && typeof item.at === 'string'
          ? [{ label: item.label, at: item.at }]
          : [])
    }
  } catch { /* Ignore malformed legacy metadata and keep the original message readable. */ }
  return { text: `${text.slice(0, start)}${text.slice(end)}`.trim(), steps }
}

/** Hide the execution receipt prefix that the runtime stores beside the final answer. */
export function visibleAgentReply(text: string): string {
  text = extractAgentWorklog(text).text
  const finalHeading = /(?:^|\n)## 最终回复\s*\n/
  const finalStart = finalHeading.exec(text)
  if (finalStart) {
    const start = finalStart.index + finalStart[0].length
    const tail = text.slice(start)
    const end = tail.search(/\n【(?:工作区|产物清单)】/)
    return cleanSourceList((end < 0 ? tail : tail.slice(0, end)).trim() || '（暂无回复内容）')
  }

  if (!/^\[@.+?\] 已领任务：/.test(text)) return text
  const userText = text
    .split('\n')
    .filter((line) => !/^\[@.+?\] 已领任务：/.test(line) &&
      !/^回执：【/.test(line) && !/^【提示词】/.test(line) &&
      !/^【(?:工作区|产物清单)】/.test(line))
    .join('\n')
    .trim()
  return cleanSourceList(userText || '任务已完成，详情见工作记录。')
}

/** Render full Markdown blocks safely, with a copy control for each fenced code block. */
export function renderMarkdown(text: string, h: Function, comps: {
  Markdown: any
  Button: any
  transformProse?: (text: string) => string
}): VNode[] {
  const children: VNode[] = []
  const prose: string[] = []
  const lines = text.split('\n')
  const flushProse = () => {
    if (!prose.length) return
    const source = prose.join('\n')
    children.push(h(comps.Markdown, {
      source: comps.transformProse?.(source) ?? source,
      class: 'sp-md-prose',
    }))
    prose.length = 0
  }

  for (let index = 0; index < lines.length; index++) {
    const opening = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(lines[index]!)
    if (!opening) {
      prose.push(lines[index]!)
      continue
    }
    const fence = opening[1]!
    const close = new RegExp(`^ {0,3}${fence[0]}{${fence.length},}[ \\t]*$`)
    let end = index + 1
    while (end < lines.length && !close.test(lines[end]!)) end++

    flushProse()
    // CommonMark closes a fenced block at end-of-document when no closing
    // fence arrives. Preserve the code block instead of handing raw fences
    // back to the prose parser (common with truncated Agent replies).
    const hasClosingFence = end < lines.length
    const code = lines.slice(index + 1, hasClosingFence ? end : lines.length).join('\n')
    const requestedLanguage = opening[2]!.trim().split(/[ \t]+/, 1)[0]?.toLowerCase() || ''
    const language = requestedLanguage && hljs.getLanguage(requestedLanguage) ? requestedLanguage : ''
    const copied = ref(false)
    const copy = async () => {
      try {
        await navigator.clipboard.writeText(code)
        copied.value = true
        window.setTimeout(() => { copied.value = false }, 1400)
      } catch { /* Clipboard may be disabled outside a secure browser context. */ }
    }
    children.push(h('div', { class: 'sp-md-code-block', key: `code-${index}` }, [
      h('div', { class: 'sp-md-code-toolbar' }, [
        h('span', { class: 'sp-md-code-language' }, language || requestedLanguage || '代码'),
        h(comps.Button, { class: 'sp-md-copy', text: true, size: 'small', onClick: copy }, {
          default: () => copied.value ? '已复制' : '复制代码',
        }),
      ]),
      h('pre', { class: 'sp-md-pre' }, [h('code', { class: language ? `language-${language}` : '' }, highlightedNodes(code, h, language))]),
    ]))
    index = hasClosingFence ? end : lines.length
  }
  flushProse()
  return [h('div', { class: 'sp-md' }, children)]
}
