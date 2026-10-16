// tool-session-todos —— 只读查询调用者当前会话的团队待办。
//
// 待办仍由 ai-todo 写入 memory 的 session:<id>/kind=todo；本插件仅注册
// L3 工具，不读取全局或其他会话，也不提供任何写入路径。
import type { Context } from 'cordis'

export const name = 'tool-session-todos'
export const inject = ['tools', 'memory', 'session']

interface TodoPayload { done: boolean; text: string }

function parseTodo(text: string): TodoPayload | null {
  try {
    const value = JSON.parse(text) as Partial<TodoPayload> | null
    return value && typeof value.done === 'boolean' && typeof value.text === 'string'
      ? { done: value.done, text: value.text }
      : null
  } catch { return null }
}

export function apply(ctx: Context) {
  ctx.tools.register({
    id: 'tool.session.todos',
    title: '读取当前会话待办',
    description: '只读查询当前会话待办。args: {} 或 {"action":"list"}。返回 JSON，包含 sessionId、待办 ID、状态、文本和创建时间；不支持创建、完成或删除。',
    capabilities: ['session.todos.read'],
    handler: async (raw, invoker) => {
      let args: unknown
      try { args = JSON.parse(raw || '{}') }
      catch { throw new Error('args 必须是 JSON 对象 {} 或 {"action":"list"}') }
      if (!args || typeof args !== 'object' || Array.isArray(args)) {
        throw new Error('args 必须是 JSON 对象 {} 或 {"action":"list"}')
      }
      const action = (args as Record<string, unknown>).action
      if (action === 'create' || action === 'complete' || action === 'delete') {
        throw new Error('该待办工具为只读工具，不支持创建、完成或删除待办')
      }
      if (action !== undefined && action !== 'list') throw new Error('只支持读取当前会话待办（action=list）')
      if (Object.keys(args).some((key) => key !== 'action')) throw new Error('待办查询不接受会话 ID 或其他参数')

      const sessionId = invoker.sessionId?.trim()
      if (!sessionId || !ctx.session.getSession(sessionId)) throw new Error('当前会话不存在或未提供会话范围')
      const isMember = ctx.session.listMembers(sessionId, true).some((member) => member.principalId === invoker.id)
      if (!isMember) throw new Error('调用者不是当前会话成员，拒绝读取待办')

      const memories = await ctx.memory.recall(`session:${sessionId}`, { kind: 'todo', limit: 50 })
      const items = memories.flatMap((item) => {
        const todo = parseTodo(item.text)
        return todo ? [{
          id: item.id,
          status: todo.done ? 'completed' : 'pending',
          text: todo.text,
          createdAt: item.createdAt,
        }] : []
      }).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
      return JSON.stringify({ sessionId, count: items.length, items })
    },
  })
}
