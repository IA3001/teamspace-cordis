// Read-only keyword search over the invoking Agent's current session history.
import type { Context } from 'cordis'
import { isAgentVisibleEvent } from 'space-event'

export const name = 'tool-session-history-search'
export const inject = ['tools', 'eventLog', 'session']

const DEFAULT_LIMIT = 10
const MAX_LIMIT = 50
const MAX_OFFSET = 10_000
const SNIPPET_RADIUS = 100

function snippet(text: string, query: string): string {
  const lower = text.toLocaleLowerCase()
  const index = lower.indexOf(query.toLocaleLowerCase())
  if (index < 0) return text.slice(0, SNIPPET_RADIUS * 2)
  const start = Math.max(0, index - SNIPPET_RADIUS)
  const end = Math.min(text.length, index + query.length + SNIPPET_RADIUS)
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`
}

export function apply(ctx: Context) {
  ctx.tools.register({
    id: 'tool.session.history-search',
    title: '搜索当前会话历史',
    description: '只读搜索调用者当前所在会话的消息历史。args: {"query":"关键词","limit":10,"offset":0}；limit 最大 50，offset 从 0 开始。返回匹配总数和分页结果（事件 ID、作者、时间、匹配文本片段）；不接受会话 ID，不支持写入。',
    capabilities: ['session.history.search'],
    handler: async (raw, invoker) => {
      let parsed: unknown
      try { parsed = JSON.parse(raw || '{}') }
      catch { throw new Error('args 必须是 JSON 对象，包含非空 query') }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('args 必须是 JSON 对象，包含非空 query')
      }
      const args = parsed as Record<string, unknown>
      if (Object.keys(args).some((key) => !['query', 'limit', 'offset'].includes(key))) {
        throw new Error('历史搜索只接受 query、limit、offset，不接受会话 ID 或其他参数')
      }
      if (typeof args.query !== 'string' || !args.query.trim()) throw new Error('搜索关键词不能为空')
      const query = args.query.trim()
      if (query.length > 200) throw new Error('搜索关键词不能超过 200 个字符')
      const limit = args.limit === undefined ? DEFAULT_LIMIT : args.limit
      const offset = args.offset === undefined ? 0 : args.offset
      if (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > MAX_LIMIT) {
        throw new Error(`limit 必须是 1 到 ${MAX_LIMIT} 的整数`)
      }
      if (!Number.isInteger(offset) || (offset as number) < 0 || (offset as number) > MAX_OFFSET) {
        throw new Error(`offset 必须是 0 到 ${MAX_OFFSET} 的整数`)
      }
      const pageSize = limit as number
      const pageOffset = offset as number

      const sessionId = invoker.sessionId?.trim()
      if (!sessionId || !ctx.session.getSession(sessionId)) throw new Error('当前会话不存在或未提供会话范围')
      const isMember = ctx.session.listMembers(sessionId, true).some((member) => member.principalId === invoker.id)
      if (!isMember) throw new Error('调用者不是当前会话成员，拒绝读取历史')

      const matches = (await ctx.eventLog.search(sessionId, query))
        .filter((event) => !event.voided && isAgentVisibleEvent(event))
      const items = matches.slice(pageOffset, pageOffset + pageSize).map((event) => ({
        eventId: event.id,
        authorId: event.authorId,
        authorKind: event.authorKind,
        timestamp: event.ts,
        matchedText: snippet(event.text, query),
      }))
      return JSON.stringify({
        sessionId,
        query,
        total: matches.length,
        offset: pageOffset,
        limit: pageSize,
        hasMore: pageOffset + items.length < matches.length,
        items,
      })
    },
  })
}
