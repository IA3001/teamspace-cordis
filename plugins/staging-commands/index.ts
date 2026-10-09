// staging-commands —— 暂存区指令族 + 入站消息路由（P2）。
//
// 指令族（2026-10-02 用户拍板注销暂存族 /add /stage /cur /del /change /clear
//   /commit —— IM 直达时间线后失去主路径地位；seam/表/RPC 保留，恢复随时加回）：
//   本插件现只注册 /help（动态列出其它插件注册的指令族）。
//
// 入站路由（承旧 POST /messages + GET /staging 契约；IM 化 2026-09-30）：
//   POST /api/sessions/:id/messages —— 入站唯一写入口：
//     身份改由 space-auth 的 HttpOnly cookie（space_token）注入，忽略
//     body.authorId（未登录 → 401）。
//     行首 '/' → Parse/Dispatch（指令）；否则 → **直达时间线**：直接落
//     人类发言事件（eventLog.append）并 emit 'space/plan' 触发 AI ——
//     /stage /commit 降级为可选批量起草路径（@提及某成员会触发 AI，
//     见 orchestrator 的 'space/plan' 订阅）。
//   GET /api/sessions/:id/staging —— 只读清单；写操作一律走 / 指令。
import { randomUUID } from 'node:crypto'
import type { Context } from 'cordis'
import { CommandError, parse } from 'space-command'
import type { CommandCtx, CommandService } from 'space-command'
import { IdentityError } from 'space-identity'
import { StagingError } from 'space-staging'
import type { StagingService } from 'space-staging'

/**
 * 从 space-auth 签发的 cookie 里取 token。space-auth 是插件不是包
 * （plugins/ 下没有 package.json，裸名解析不到），故在本文件内自实现
 * 同口径的解析，规则与 plugins/space-auth/index.ts 的 readToken 一致：
 * 只认 space_token=。
 */
function readToken(req: Request): string {
  // 2026-10-02：除 cookie 外支持 Authorization: Bearer（浏览器页面与后端
  // 不同端口，fetch 需带头的场景：撤回/上传）。
  const bearer = req.headers.get('authorization')
  if (bearer?.startsWith('Bearer ')) return bearer.slice(7).trim()
  const header = req.headers.get('cookie')
  if (!header) return ''
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    if (part.slice(0, eq).trim() === 'space_token') {
      return decodeURIComponent(part.slice(eq + 1).trim())
    }
  }
  return ''
}

/** cookie 换当前登录用户；无效/过期 → 401（调用方直接返回）。 */
async function requireUser(ctx: Context, req: Request) {
  return ctx.users.verifyToken(readToken(req))
}

export const name = 'staging-commands'
export const inject = ['server', 'commands', 'staging', 'session', 'eventLog', 'users']

export interface Config {}

/**
 * 注册指令族。从 apply 里拆出来：scripts/verify-staging.ts 的进程内
 * 断言（Part A）用实例直接调用，不必起 HTTP 服务。
 */
export function registerCommands(commands: CommandService, staging: StagingService): void {
  // 暂存指令族（/add /stage /cur /del /change /clear /commit）已于 2026-10-02
  // 注销 —— IM 化后普通消息直达时间线，暂存工作流失去主路径地位（用户拍板）。
  // seam / 数据表 / RPC 读取全部保留：想恢复 = 在这里加回注册行，零结构调整。
  // staging 参数保留（签名兼容 verify-staging 与未来恢复）。

  // /help：动态列出全部注册指令（当前 = 流程指令 + /todo /tell /summary）。
  commands.register({
    name: 'help',
    usage: '/help —— 列出全部可用指令',
    minArgs: 0,
    maxArgs: 0,
    run: () => {
      const all = commands.list()
      if (all.length === 0) return { text: '（当前没有任何指令）' }
      const lines = all.map((c) => `  ${c.usage}`).join('\n')
      return {
        text: `可用指令（${all.length} 个）：\n${lines}\n` +
          '提示：普通消息直接上时间线；@成员可召唤 AI；@所有人召唤全体。',
      }
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
 * 语义只有一份：行首 / 走指令（Consume），否则直达时间线（IM 化：
 * append 人类发言事件 + emit 'space/plan'）。
 * 返回结构化结果而不是 Response：调用方自己决定 HTTP 形状。
 */
export async function handleInbound(
  ctx: Context,
  sessionId: string,
  authorId: string,
  text: string,
  mentions: string[] = [],
  replyTo?: string | null,
): Promise<{ reply: string } | { error: string; code?: string; detail: string }> {
  const session = ctx.session.getSession(sessionId)
  if (!session) {
    return { error: 'session_not_found', detail: `会话 ${sessionId} 不存在` }
  }
  if (!text.trim()) {
    return { error: 'empty_text', detail: '消息文本为空' }
  }
  if (text.length > 5000) {
    return { error: 'text_too_long', detail: `消息过长（${text.length} 字符，上限 5000）—— 长内容请走文件消息` }
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

  // 非 / 消息：直达时间线（IM 化语义）——
  // 直接落一条人类发言事件（eventLog.append，用法对齐 staging.commit），
  // 并 emit 'space/plan' 让 AI 侧（orchestrator 订阅）开始处理。
  // /stage /commit 保留为可选的批量起草路径；@提及某成员会触发 AI
  //（mentions 由服务端解析：@token 与在册成员 id 精确匹配，与调用方
  // 显式给的 mentions 取并集 —— UI 与 curl 都不需要自己懂成员表）。
  if (session.status === 'closed') {
    return { error: 'session_closed', detail: '会话已结束，不能再发言' }
  }
  try {
    const members = ctx.session.listMembers(sessionId, true)
    const memberIds = members.map((m) => m.principalId)
    // @token 解析（2026-10-05 放宽）：除了精确 id，还认**角色/分工显示名**
    //（如「@需求分析师」「@编码者」）—— 普通用户不会去背内部 id。匹配别名 =
    // principalId / role / duty，命中即归一到成员 id。末尾标点剥掉（中文
    // 输入法高频：'@需求分析师，' 不该匹配失败）。
    const aliasMap = new Map<string, string>()
    for (const m of members) {
      for (const alias of [m.principalId, m.role, m.duty ?? '']) {
        const a = alias.trim()
        if (a) aliasMap.set(a, m.principalId)
      }
    }
    const stripPunc = (t: string) => t.replace(/[，。！？、；：）】」』"'\.,!?;:\)]+$/u, '')
    const rawTokens = (text.match(/@([^\s@]+)/g) ?? []).map((t) => stripPunc(t.slice(1)))
    const textMentions = rawTokens
      .filter((t) => /^(所有人|all|everyone)$/i.test(t))
      .map(() => '__all__')
      .concat(rawTokens.map((t) => aliasMap.get(t) ?? t))
      .filter((t) => t === '__all__' || memberIds.includes(t))
    // @所有人 = 显式召唤全体（含协调者以外所有角色）：UI 侧把 '@所有人' 归一成
    // 哨兵 '__all__' 传上来，这里展开为全部在册成员 id，下游 'space/plan' 订阅方
    // 无需理解哨兵、看到的始终是真实成员清单。
    const expanded = mentions.includes('__all__') ? [...mentions, ...memberIds] : mentions
    const allMentions = [...new Set([...expanded, ...textMentions])]
    // 引用校验（引用系统化 2026-10-02）：目标事件必须存在且属于本会话。
    let validatedReplyTo: string | null = null
    if (replyTo) {
      const target = ctx.eventLog.listBySession(sessionId).find((e) => e.id === replyTo)
      if (!target) {
        return { error: 'reply_target_not_found', detail: `引用目标事件不存在或不属于本会话：${replyTo}` }
      }
      validatedReplyTo = replyTo
    }
    const event = ctx.eventLog.append({
      id: randomUUID(),
      sessionId,
      authorId,
      phaseId: null,
      authorKind: 'human',
      kind: 'message',
      text,
      mentions: allMentions,
      toolCalls: [],
      replyMode: '',
        replyTo: validatedReplyTo,
      })
    // AI 触发源：谁在哪个会话 @ 了谁（空 mentions = 纯聊天，不打扰 AI）。
    ctx.emit('space/plan', { sessionId, authorId, mentions: allMentions, event })
    return { reply: '' }
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
    // IM 化：身份由 cookie 注入（space-auth 签发的 space_token），
    // 忽略 body.authorId —— 客户端不能自称别人。
    let authorId: string
    try {
      authorId = (await requireUser(ctx, req)).id
    } catch (e) {
      if (e instanceof IdentityError) {
        return Response.json({ error: 'unauthorized', detail: '请先登录' }, { status: 401 })
      }
      throw e
    }
    const body = await req.json().catch(() => null as Record<string, unknown> | null)
    const text = typeof body?.text === 'string' ? body.text : ''
    const mentions = Array.isArray(body?.mentions) ? body.mentions.map(String) : []
    const replyTo = typeof body?.replyTo === 'string' ? body.replyTo : null

    const result = await handleInbound(ctx, sessionId, authorId, text, mentions, replyTo).catch((e) => {
      console.error('[staging-commands] 入站处理异常：', e)
      throw e
    })
    if ('reply' in result) return Response.json(result)
    const status =
      result.error === 'session_not_found' ? 404 : result.error === 'session_closed' ? 403 : 400
    return Response.json(result, { status })
  })

  // ── 消息撤回（作者自撤）：作者悬停自己的消息点「撤回」调这里 ──────────
  // POST /api/sessions/:id/events/:eventId/recall（cookie 鉴权，同 messages 路由）：
  // 仅作者本人（author_id = 当前用户）且 authorKind='human' 且未 voided 可撤；
  // 撤回 = eventLog.void(id, 当前用户id, 'author_recall')，留痕不删行。
  ctx.server.post('/api/sessions/:id/events/:eventId/recall', async (req) => {
    const { id: sessionId, eventId } = req.params
    let user: { id: string }
    try {
      user = await requireUser(ctx, req)
    } catch (e) {
      if (e instanceof IdentityError) {
        return Response.json({ error: 'unauthorized', detail: '请先登录' }, { status: 401 })
      }
      throw e
    }
    // 事件必须属于该会话且存在（跨会话/不存在一律 404，避免探测）。
    const ev = ctx.eventLog.listBySession(sessionId).find((e) => e.id === eventId)
    if (!ev) return Response.json({ error: 'not_found', detail: '消息不存在' }, { status: 404 })
    if (ev.voided) return Response.json({ error: 'already_voided', detail: '消息已撤回' }, { status: 403 })
    if (ev.authorId !== user.id || ev.authorKind !== 'human') {
      return Response.json({ error: 'forbidden', detail: '只能撤回自己的消息' }, { status: 403 })
    }
    try {
      ctx.eventLog.void(eventId, user.id, 'author_recall')
    } catch (e) {
      return Response.json({ error: 'recall_failed', detail: String((e as Error).message ?? e) }, { status: 400 })
    }
    return Response.json({ ok: true })
  })

  // ── 暂存区只读清单（写操作一律走 / 指令，承旧契约）──────────────────
  ctx.server.get('/api/sessions/:id/staging', async (req) => {
    return Response.json(ctx.staging.list(req.params.id))
  })
}
