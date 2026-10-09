// Team-configured web search adapter. Credentials stay in ctx.settings and are
// never included in tool output or logs.
import type { Context } from 'cordis'

export const name = 'tool-web-search'
export const inject = ['tools', 'settings']

type SearchItem = { title?: unknown; url?: unknown; content?: unknown; snippet?: unknown }

export function apply(ctx: Context) {
  ctx.tools.register({
    id: 'web.search',
    title: '网页搜索',
    capabilities: ['web-search'],
    handler: async (args, invoker) => {
      let input: unknown
      try { input = JSON.parse(args) } catch { throw new Error('args 必须是 JSON：{ query, max_results? }') }
      const value = (input ?? {}) as Record<string, unknown>
      const query = typeof value.query === 'string' ? value.query.trim() : ''
      if (!query || query.length > 1000) throw new Error('query 必须为 1 到 1000 个字符')
      const requested = Number(value.max_results ?? 5)
      const maxResults = Number.isFinite(requested) ? Math.max(1, Math.min(10, Math.floor(requested))) : 5
      const baseURL = ctx.settings.get<string>('search.baseURL', '').trim().replace(/\/$/, '')
      const apiKey = ctx.settings.get<string>('search.apiKey', '').trim()
      if (!baseURL || !apiKey) throw new Error('网页搜索 API 尚未配置')

      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 15000)
      const abortFromCaller = () => controller.abort()
      invoker.signal?.addEventListener('abort', abortFromCaller, { once: true })
      try {
        const response = await fetch(`${baseURL}/search`, {
          method: 'POST',
          headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
          body: JSON.stringify({ query, max_results: maxResults }),
          signal: controller.signal,
        })
        if (!response.ok) throw new Error(`网页搜索 API 返回 HTTP ${response.status}`)
        const data = await response.json() as { results?: unknown; answer?: unknown }
        const results = Array.isArray(data.results) ? data.results.slice(0, maxResults) as SearchItem[] : []
        const formatted = results.map((item, index) => {
          const title = typeof item.title === 'string' ? item.title : '(无标题)'
          const url = typeof item.url === 'string' ? item.url : ''
          const summary = typeof item.content === 'string' ? item.content : typeof item.snippet === 'string' ? item.snippet : ''
          return `${index + 1}. ${title}${url ? `\n   ${url}` : ''}${summary ? `\n   ${summary}` : ''}`
        })
        const answer = typeof data.answer === 'string' ? data.answer : ''
        const output = [answer, ...formatted].filter(Boolean).join('\n\n') || '未找到搜索结果。'
        return output.slice(0, 12000)
      } finally {
        clearTimeout(timer)
        invoker.signal?.removeEventListener('abort', abortFromCaller)
      }
    },
  })
}
