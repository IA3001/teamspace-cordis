// staging-commands —— 暂存区指令族 + 入站消息路由（P2）。
//
// 指令族（承旧前端 StagingPanel.vue 契约 + project_memory 硬约束，2026-09-27 首次真实现）：
//   /add <文本>            追加一条暂存发言（保留原文空格）→「已记下 #N（当前共 M 条）」
//   /cur                   列出全部条目（编号 + 预览 + 总数）
//   /del <序号>            删除**自己的**一条（别人的 → not_author 判红）
//   /change <序号> <文本>  改写**自己的**一条（保留原文空格）
//   /clear                 两段式：第一段只给确认话术；/clear confirm 才真清
//   /commit                合并提交：恰一条人类发言事件 + 恰好一次 Plan 信号
//
// 入站路由（承旧 POST /messages + GET /staging 契约）：
//   POST /api/sessions/:id/messages —— 入站唯一写入口：
//     行首 '/' → Parse/Dispatch（指令）；否则 → 自动入暂存区，
//     **不落人类发言事件、不触发 Plan**（旧 message 管线的 Stage 语义）。
//   GET /api/sessions/:id/staging —— 只读清单；写操作一律走 / 指令。
//
// authorId 调试期由请求体提供（M1 无登录）；身份域落地后由身份注入替换。
import type { Context } from 'cordis'
import { CommandError, parse } from 'space-command'
import type { CommandCtx, CommandService } from 'space-command'
import { StagingError } from 'space-staging'
import type { StagingService } from 'space-staging'

export const name = 'staging-commands'
export const inject = ['server', 'commands', 'staging', 'session']

export interface Config {}

/**
 * 注册六条指令。从 apply 里拆出来：scripts/verify-staging.ts 的进程内
 * 断言（Part A）用实例直接调用，不必起 HTTP 服务。
 */
export function registerCommands(commands: CommandService, staging: StagingService): void {
  commands.register({
    name: 'add',
    usage: '/add <文本> —— 追加一条暂存发言（保留原文空格）',
    minArgs: 1,
    maxArgs: -1,
    run: (c: CommandCtx) => {
      const entry = staging.append(c.sessionId, c.authorId, c.arg)
      return { text: `已记下 #${entry.seq}（当前共 ${staging.count(c.sessionId)} 条）` }
    },
  })

  commands.register({
    name: 'cur',
    usage: '/cur —— 查看暂存区全部条目',
    minArgs: 0,
    maxArgs: 0,
    run: (c: CommandCtx) => {
      const entries = staging.list(c.sessionId)
      if (entries.length === 0) return { text: '暂存区为空（0 条）' }
      const lines = entries.map((e) => `#${e.seq} ${e.text}`).join('\n')
      return { text: `暂存区共 ${entries.length} 条：\n${lines}` }
    },
  })

  commands.register({
    name: 'del',
    usage: '/del <序号> —— 删除自己的一条暂存发言',
    minArgs: 1,
    maxArgs: 1,
    run: (c: CommandCtx) => {
      const seq = toSeq(c.args[0]!)
      staging.remove(c.sessionId, seq, c.authorId)
      return { text: `已删除 #${seq}（当前共 ${staging.count(c.sessionId)} 条）` }
    },
  })

  commands.register({
    name: 'change',
    usage: '/change <序号> <新文本> —— 改写自己的一条暂存发言（保留原文空格）',
    minArgs: 2,
    maxArgs: -1,
    run: (c: CommandCtx) => {
      const seq = toSeq(c.args[0]!)
      // 新文本取 seq 之后 arg 的原文剩余 —— 不能 args.slice(1).join(' ')，
      // 那会把连续空格压扁（/add 同理用 c.arg）。
      const text = c.arg.slice(c.args[0]!.length).trim()
      staging.update(c.sessionId, seq, c.authorId, text)
      return { text: `已改写 #${seq}` }
    },
  })

  commands.register({
    name: 'clear',
    usage: '/clear —— 清空暂存区（两段式：确认请再发 /clear confirm）',
    minArgs: 0,
    maxArgs: 1,
    run: (c: CommandCtx) => {
      if (c.args.length === 0) {
        const n = staging.count(c.sessionId)
        return { text: `确认清空？将删除全部 ${n} 条暂存发言。确认请再发一次：/clear confirm` }
      }
      if (c.args[0] !== 'confirm') {
        throw new CommandError('bad_args', `/clear 不认识参数 ${JSON.stringify(c.args[0])}。用法：${c.raw}（确认请再发 /clear confirm）`)
      }
      const n = staging.clear(c.sessionId)
      return { text: `已清空（原 ${n} 条）` }
    },
  })

  commands.register({
    name: 'commit',
    usage: '/commit —— 把暂存区全部发言合并提交（一条人类发言事件），协调者才开始处理',
    minArgs: 0,
    maxArgs: 0,
    run: (c: CommandCtx) => {
      const r = staging.commit(c.sessionId, c.authorId)
      if (!r) return { text: '暂存区为空，没有可提交的发言' }
      return { text: `已提交 ${r.merged} 条发言（事件 seq=${r.event.seq}）` }
    },
  })
}

function toSeq(s: string): number {
  const n = Number(s)
  if (!Number.isInteger(n) || n <= 0) {
    throw new CommandError('bad_args', `序号必须是正整数，实际 ${JSON.stringify(s)}`)
  }
  return n
}

/**
 * 入站消息的语义处理体（HTTP 路由与 P4 composer 页共用同一条路径 ——
 * 语义只有一份：行首 / 走指令（Consume），否则入暂存区（Stage）。
 * 返回结构化结果而不是 Response：调用方自己决定 HTTP 形状。
 */
export async function handleInbound(
  ctx: Context,
  sessionId: string,
  authorId: string,
  text: string,
  mentions: string[] = [],
): Promise<{ reply: string } | { error: string; code?: string; detail: string }> {
  const session = ctx.session.getSession(sessionId)
  if (!session) {
    return { error: 'session_not_found', detail: `会话 ${sessionId} 不存在` }
  }
  if (!text.trim()) {
    return { error: 'empty_text', detail: '消息文本为空' }
  }
  if (!authorId.trim()) {
    return { error: 'missing_author', detail: '缺少 authorId（调试期由调用方提供，身份域落地后由登录身份注入）' }
  }

  const base: CommandCtx = { sessionId, authorId, arg: '', args: [], raw: text }
  const inv = parse(text)
  if (inv) {
    // 指令路径（Consume 语义）：执行并把回执回给人类。
    try {
      const reply = await ctx.commands.dispatch(base, inv)
      return { reply: reply.text }
    } catch (e) {
      if (e instanceof CommandError || e instanceof StagingError) {
        return { error: e.name, code: e.code, detail: e.message }
      }
      console.error('[staging-commands] 指令执行失败（500）：', e)
      throw e
    }
  }

  // 非 / 消息：自动入暂存区（Stage 语义）——
  // 不落人类发言事件、不触发 Plan，最小确认「已记下 #N」。
  // 提及在服务端解析（@token 与在册成员 id 精确匹配），与调用方显式给的
  // mentions 取并集 —— UI 与 curl 都不需要自己懂成员表。
  try {
    const memberIds = ctx.session.listMembers(sessionId, true).map((m) => m.principalId)
    const textMentions = (text.match(/@([^\s@]+)/g) ?? []).map((t) => t.slice(1)).filter((t) => memberIds.includes(t))
    const entry = ctx.staging.append(sessionId, authorId, text, [...new Set([...mentions, ...textMentions])])
    return { reply: `已记下 #${entry.seq}（当前共 ${ctx.staging.count(sessionId)} 条）` }
  } catch (e) {
    if (e instanceof CommandError || e instanceof StagingError) {
      return { error: e.name, code: e.code, detail: e.message }
    }
    throw e
  }
}

export function apply(ctx: Context) {
  registerCommands(ctx.commands, ctx.staging)

  // ── 入站唯一写入口 ────────────────────────────────────────────────────
  ctx.server.post('/api/sessions/:id/messages', async (req) => {
    const sessionId = req.params.id
    const body = await req.json().catch(() => null as Record<string, unknown> | null)
    const text = typeof body?.text === 'string' ? body.text : ''
    const authorId = typeof body?.authorId === 'string' ? body.authorId.trim() : ''
    const mentions = Array.isArray(body?.mentions) ? body.mentions.map(String) : []

    const result = await handleInbound(ctx, sessionId, authorId, text, mentions)
    if ('reply' in result) return Response.json(result)
    const status = result.error === 'session_not_found' ? 404 : 400
    return Response.json(result, { status })
  })

  // ── 暂存区只读清单（写操作一律走 / 指令，承旧契约）──────────────────
  ctx.server.get('/api/sessions/:id/staging', async (req) => {
    return Response.json(ctx.staging.list(req.params.id))
  })
}
