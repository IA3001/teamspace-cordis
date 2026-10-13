// staging-commands —— 入站聊天消息与遗留暂存 REST 路由。
// 所有聊天文本（包括以 / 开头的文本）均作为普通消息处理；操作由专用 UI 控件发起。
//
// 入站路由（承旧 POST /messages + GET /staging 契约）：
//   POST /api/sessions/:id/messages —— 入站唯一写入口：
//     身份改由 space-auth 的 HttpOnly cookie（space_token）注入，忽略
//     body.authorId（未登录 → 401）。
//     直接落人类发言事件（eventLog.append）并 emit 'space/plan' 触发 AI；
//     @提及某成员会触发 AI，
//     见 orchestrator 的 'space/plan' 订阅）。
//   GET/DELETE /api/sessions/:id/staging —— 遗留暂存条目的读取与作者删除。
import { randomUUID } from 'node:crypto'
import type { Context } from 'cordis'
import { IdentityError } from 'space-identity'
import { StagingError } from 'space-staging'
import { collectAgentDescendants } from 'space-event'
import type { SessionEvent } from 'space-event'

/**
 * 从 space-auth 签发的 cookie 里取 token。space-auth 是插件不是包
 * （plugins/ 下没有 package.json，裸名解析不到），故在本文件内自实现
 * 同口径的解析，规则与 plugins/space-auth/index.ts 的 readToken 一致：
 * 只认 space_token=。
 */
type HeaderRequest = { headers: { get(name: string): string | null } }
function readToken(req: HeaderRequest): string {
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
async function requireUser(ctx: Context, req: HeaderRequest) {
  return ctx.users.verifyToken(readToken(req))
}

function isSessionMember(ctx: Context, sessionId: string, userId: string): boolean {
  try { return ctx.session.listMembers(sessionId, true).some((member) => member.principalId === userId) }
  catch { return false }
}

export const name = 'staging-commands'
export const inject = ['server', 'staging', 'session', 'eventLog', 'users', 'agents', 'agentInbox', 'agentRuntime', 'orchestrator', 'memory']

export interface Config {}

/** Invalidate the complete causal chain of one human recall and rebuild surviving mixed memories. */
export async function invalidateRecallConsequences(ctx: Context, sessionId: string, event: SessionEvent, userId: string) {
  const consequences = new Map<string, SessionEvent>()
  let stable = false
  for (let round = 0; round < 32; round++) {
    const history = ctx.eventLog.listBySession(sessionId)
    for (const item of [event, ...collectAgentDescendants(history, event.id)]) consequences.set(item.id, item)
    for (const item of consequences.values()) {
      ctx.orchestrator.cancelDelegationsBySource(sessionId, item.id)
      await ctx.agentRuntime.cancelBySource(item.id)
    }
    const throughSeq = Math.max(...[...consequences.values()].map((item) => item.seq))
    await Promise.all(ctx.session.listMembers(sessionId, true).flatMap((member) => {
      try { ctx.agents.get(member.principalId); return [ctx.agentInbox.waitThrough(member.principalId, sessionId, throughSeq)] }
      catch { return [] }
    }))
    const latest = [event, ...collectAgentDescendants(ctx.eventLog.listBySession(sessionId), event.id)]
    const added = latest.filter((item) => !consequences.has(item.id))
    for (const item of added) consequences.set(item.id, item)
    if (!added.length) { stable = true; break }
  }
  if (!stable) throw new Error('撤回影响链在等待期间持续变化，请稍后重试')

  const snapshots = new Map<string, Awaited<ReturnType<Context['memory']['invalidateBySource']>>[number]>()
  let voided = 0
  for (const item of [...consequences.values()].sort((a, b) => a.seq - b.seq)) {
    const changed = ctx.eventLog.void(item.id, userId, 'author_recall')
    if (!changed) continue
    voided += changed
    for (const memory of await ctx.memory.invalidateBySource(item.id)) snapshots.set(memory.id, memory)
  }
  if (!voided) throw new Error('消息已撤回或其状态已变化')

  let rebuilt = 0
  const valid = ctx.eventLog.listBySession(sessionId).filter((item) => !item.voided)
  for (const memory of snapshots.values()) {
    if (!memory.scope.startsWith('agent:') || memory.sourceEventIds.length < 2) continue
    const surviving = memory.sourceEventIds.flatMap((id) => {
      const source = valid.find((item) => item.id === id)
      return source ? [source] : []
    })
    if (!surviving.length) continue
    try { rebuilt += await ctx.agentInbox.rebuildInvalidatedMemory(memory, surviving) }
    catch (error) {
      ctx.logger.warn('[space-message] 混合来源记忆重建失败（memory=%s）：%s', memory.id, (error as Error).message)
    }
  }
  return { voided, invalidated: snapshots.size, rebuilt }
}

/**
 * 入站消息的语义处理体（HTTP 路由与 P4 composer 页共用同一条路径 ——
 * 所有文本均按普通聊天消息处理；操作通过专用 UI 控件完成。
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

  // 直达时间线 ——
  // 直接落一条人类发言事件（eventLog.append，用法对齐 staging.commit），
  // 并 emit 'space/plan' 让 AI 侧（orchestrator 订阅）开始处理。
  // @提及某成员会触发 AI
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
    throw e
  }
}

export function apply(ctx: Context) {
  // ── 入站唯一写入口 ────────────────────────────────────────────────────
  ctx.server.post('/api/sessions/:id/messages', async (req) => {
    const sessionId = req.params.id
    // IM 化：身份由 cookie 注入（space-auth 签发的 space_token），
    // 忽略 body.authorId —— 客户端不能自称别人。
    let user: { id: string; kind?: string }
    try {
      user = await requireUser(ctx, req)
    } catch (e) {
      if (e instanceof IdentityError) {
        return Response.json({ error: 'unauthorized', detail: '请先登录' }, { status: 401 })
      }
      throw e
    }
    if (user.kind !== 'human') return Response.json({ error: 'unauthorized' }, { status: 401 })
    if (!ctx.session.getSession(sessionId) || !isSessionMember(ctx, sessionId, user.id)) {
      return Response.json({ error: 'not_found', detail: '会话不存在或你不是在册成员' }, { status: 404 })
    }
    const body = await req.json().catch(() => null as Record<string, unknown> | null)
    const text = typeof body?.text === 'string' ? body.text : ''
    const mentions = Array.isArray(body?.mentions) ? body.mentions.map(String) : []
    const replyTo = typeof body?.replyTo === 'string' ? body.replyTo : null

    const result = await handleInbound(ctx, sessionId, user.id, text, mentions, replyTo).catch((e) => {
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
    let user: { id: string; kind?: string }
    try {
      user = await requireUser(ctx, req)
    } catch (e) {
      if (e instanceof IdentityError) {
        return Response.json({ error: 'unauthorized', detail: '请先登录' }, { status: 401 })
      }
      throw e
    }
    if (user.kind !== 'human') return Response.json({ error: 'unauthorized' }, { status: 401 })
    if (!ctx.session.getSession(sessionId) || !isSessionMember(ctx, sessionId, user.id)) {
      return Response.json({ error: 'not_found', detail: '会话不存在或你不是在册成员' }, { status: 404 })
    }
    // 事件必须属于该会话且存在（跨会话/不存在一律 404，避免探测）。
    const ev = ctx.eventLog.listBySession(sessionId).find((e) => e.id === eventId)
    if (!ev) return Response.json({ error: 'not_found', detail: '消息不存在' }, { status: 404 })
    if (ev.voided) return Response.json({ error: 'already_voided', detail: '消息已撤回' }, { status: 403 })
    if (ev.authorId !== user.id || ev.authorKind !== 'human') {
      return Response.json({ error: 'forbidden', detail: '只能撤回自己的消息' }, { status: 403 })
    }
    try {
      const { voided, invalidated, rebuilt } = await invalidateRecallConsequences(ctx, sessionId, ev, user.id)
      ctx.logger.info('[space-message] 作者撤回使 %d 条 Agent 事件、%d 条来源记忆失效并重建 %d 条（event=%s）',
        voided, invalidated, rebuilt, eventId)
      return Response.json({ ok: true, voided, invalidated, rebuilt })
    } catch (e) {
      if (/已撤回或其状态已变化/.test(String((e as Error).message))) {
        return Response.json({ error: 'already_voided', detail: (e as Error).message }, { status: 409 })
      }
      return Response.json({ error: 'recall_failed', detail: String((e as Error).message ?? e) }, { status: 400 })
    }
    return Response.json({ ok: true })
  })

  // ── 暂存区遗留条目读取及作者删除 ────────────────────────────────────
  ctx.server.get('/api/sessions/:id/staging', async (req) => {
    let user: { id: string; kind?: string }
    try { user = await requireUser(ctx, req) }
    catch (e) {
      if (e instanceof IdentityError) return Response.json({ error: 'unauthorized' }, { status: 401 })
      throw e
    }
    if (user.kind !== 'human' || !ctx.session.getSession(req.params.id) || !isSessionMember(ctx, req.params.id, user.id)) {
      return Response.json({ error: 'not_found' }, { status: 404 })
    }
    return Response.json(ctx.staging.list(req.params.id))
  })

  ctx.server.delete('/api/sessions/:id/staging/:seq', async (req) => {
    let user: { id: string; kind?: string }
    try { user = await requireUser(ctx, req) }
    catch (e) {
      if (e instanceof IdentityError) return Response.json({ error: 'unauthorized' }, { status: 401 })
      throw e
    }
    const sessionId = req.params.id
    if (user.kind !== 'human') return Response.json({ error: 'unauthorized' }, { status: 401 })
    if (!ctx.session.getSession(sessionId) || !isSessionMember(ctx, sessionId, user.id)) {
      return Response.json({ error: 'not_found' }, { status: 404 })
    }
    const seq = Number(req.params.seq)
    if (!Number.isSafeInteger(seq) || seq < 1) return Response.json({ error: 'invalid_seq' }, { status: 400 })
    try {
      ctx.staging.remove(sessionId, seq, user.id)
      return Response.json({ ok: true })
    } catch (e) {
      if (e instanceof StagingError) {
        const status = e.code === 'not_found' ? 404 : e.code === 'not_author' ? 403 : 400
        return Response.json({ error: e.code, detail: e.message }, { status })
      }
      throw e
    }
  })
}
