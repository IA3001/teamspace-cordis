// ai-todo —— /todo 团队待办指令（2026-10-01）。
//
// 存储复用记忆层（不建新表）：L1 的 ctx.memory，kind='todo'。
//   · scope = `session:<sessionId>` —— 待办随会话，与记忆同域。
//   · text  = JSON.stringify({ done: boolean, text: string }) —— 状态藏在 text 里。
//   · weight = 0.8 —— 待办比普通沉淀记忆略重要，但让位于显式 note。
//
// 记忆层 append-only 无 update（seam/space-memory 的账本精神）：「标记完成」
// 是结构内的状态翻转 —— forget 旧条目 + remember 一条同文本 done=true 的。
// 旧 id 消亡、新条目 createdAt 更新，语义上等同一次状态迁移（不物理篡改历史
// 的口径由 forget 的幂等软/硬删实现层保证）。
//
// 序号口径（重要）：每次 list 都按 createdAt 升序重新编号（1-based），
// 序号**不持久化**。这与暂存区 seq 的「不重排」刻意不同 —— 暂存条目靠 seq
// 被引用且长期存在，而待办会消亡（done/del 后旧条目即被遗忘），持久化序号
// 反而会产生悬挂引用。/todo done N、/todo del N 里的 N 永远指「当前列表
// 升序排列后的第 N 条」，回执里不回指序号。
import type { Context } from 'cordis'

export const name = 'ai-todo'
export const inject = ['commands', 'memory']

/** text 字段里藏的待办载荷（JSON 序列化存进记忆层）。 */
interface TodoPayload { done: boolean; text: string }

const KIND = 'todo'
const WEIGHT = 0.8
/** 解析记忆条目 text → 载荷；解析失败（脏数据）返回 null，调用方跳过。 */
function parseTodo(m: { text: string }): TodoPayload | null {
  try {
    const p = JSON.parse(m.text) as TodoPayload
    if (typeof p?.done === 'boolean' && typeof p?.text === 'string') return p
    return null
  } catch {
    return null
  }
}

export const apply = (ctx: Context) => {
  ctx.commands.register({
    name: 'todo',
    usage: '/todo <文本> —— 新增待办；/todo list 列出；/todo done <序号> 完成；/todo del <序号> 删除',
    minArgs: 1,
    maxArgs: -1,
    run: async (c) => {
      const scope = `session:${c.sessionId}`
      const recall = async (): Promise<Array<{ id: string; payload: TodoPayload; createdAt: string }>> => {
        const list = await ctx.memory.recall(scope, { kind: KIND, limit: 50 })
        // 序号口径：按 createdAt 升序排列后 1-based 编号（见文件头注释）。
        return (Array.isArray(list) ? list : [])
          .map((m) => ({ id: m.id, payload: parseTodo(m), createdAt: m.createdAt }))
          .filter((x): x is { id: string; payload: TodoPayload; createdAt: string } => x.payload !== null)
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      }

      const sub = c.args[0]!

      // /todo list
      if (sub === 'list') {
        const todos = await recall()
        if (todos.length === 0) return { text: '暂无待办 —— 用 /todo <文本> 记一条。' }
        const lines = todos.map((x, i) =>
          `${x.payload.done ? '[x]' : '[ ]'} ${i + 1}. ${x.payload.text}`)
        const pending = todos.filter((x) => !x.payload.done).length
        return { text: `团队待办（未完成 ${pending} / 共 ${todos.length}）：\n${lines.join('\n')}` }
      }

      // /todo done <序号>
      if (sub === 'done') {
        const n = Number(c.args[1])
        if (!Number.isInteger(n) || n < 1) {
          return { text: `用法：/todo done <序号>（序号见 /todo list，1 起算）` }
        }
        const todos = await recall()
        const target = todos[n - 1]
        if (!target) return { text: `没有第 ${n} 条待办（当前共 ${todos.length} 条），见 /todo list。` }
        if (target.payload.done) return { text: `第 ${n} 条本来就已完成：${target.payload.text}` }
        // 记忆层 append-only 无 update：forget 旧条目 + remember 同文本 done=true
        //（结构内的状态翻转，见文件头注释）。
        await ctx.memory.forget(target.id)
        await ctx.memory.remember(scope, KIND, JSON.stringify({
          done: true, text: target.payload.text,
        }), { weight: WEIGHT, authorId: c.authorId })
        return { text: `已完成：${target.payload.text}` }
      }

      // /todo del <序号>
      if (sub === 'del') {
        const n = Number(c.args[1])
        if (!Number.isInteger(n) || n < 1) {
          return { text: `用法：/todo del <序号>（序号见 /todo list，1 起算）` }
        }
        const todos = await recall()
        const target = todos[n - 1]
        if (!target) return { text: `没有第 ${n} 条待办（当前共 ${todos.length} 条），见 /todo list。` }
        await ctx.memory.forget(target.id) // forget 幂等（seam 语义），不炸
        return { text: `已删除：${target.payload.text}` }
      }

      // /todo <文本>（含子命令拼错的兜底 —— 原样当待办文本记账，不猜意图）
      const text = c.arg.trim()
      await ctx.memory.remember(scope, KIND, JSON.stringify({ done: false, text }), {
        weight: WEIGHT, authorId: c.authorId,
      })
      const todos = await recall()
      const pending = todos.filter((x) => !x.payload.done).length
      return { text: `已记待办（共 ${pending} 条未完成）` }
    },
  })

  console.log(`[${name}] 就绪：/todo 指令已注册（存储复用 memory，kind='todo'）`)
}
