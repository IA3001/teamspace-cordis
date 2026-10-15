// space-push —— 实时推送（IM 化改造 2026-09-30）。
//
// 订阅内核事件 'space/event-appended'（store 落库时恰好一次 emit），把新事件
// 通过 teamspace isolate 的 webui websocket 广播给所有在线客户端 —— 替代前端
// 4s/5s 轮询。按已认证 socket 用户与会话成员表过滤后，通过 WebUI client
// 单播；本插件必须与 teamspace-webui 同 isolate（composed 配置里
// isolate: { webui: teamspace }），这样 ctx.webui 才是 5174 那个实例，
// 5172 调试控制台不受影响。
//
// 消息形状：{ type: 'space:event', body: { event } } —— 客户端在
// ctx.client.socket 上按 type 分发（见 space-client-ui-teamspace client）。
import type { Context } from 'cordis'
import type {} from '@cordisjs/plugin-webui'
import type {} from 'space-message'
import type { AgentProgressUpdate } from 'space-agent-runtime'

interface ClientIdentity { token: string; userId: string }
interface RpcRequest { args?: unknown[] }
interface AgentWantsToSpeakUpdate {
  sessionId: string
  agentId: string
  title: string
  sourceEventId: string
  wantsToSpeak: boolean
  at: string
}

async function activeIdentity(ctx: Context, identities: Map<string, ClientIdentity>, clientId: string) {
  const identity = identities.get(clientId)
  if (!identity) return null
  try {
    const user = await ctx.users.verifyToken(identity.token)
    if (user.kind !== 'human' || user.id !== identity.userId) {
      identities.delete(clientId)
      return null
    }
    return user
  } catch {
    identities.delete(clientId)
    return null
  }
}

function isMember(ctx: Context, sessionId: string, userId: string): boolean {
  try { return ctx.session.listMembers(sessionId, true).some((member) => member.principalId === userId) }
  catch { return false }
}

export const name = 'space-push'
export const inject = ['webui', 'sessionWork', 'users', 'session', 'agentRuntime']

export function apply(ctx: Context) {
  const identities = new Map<string, ClientIdentity>()
  const generations = new Map<string, number>()
  const pendingText = new Map<string, AgentProgressUpdate>()
  const textTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const progressRetentionTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const progressQueues = new Map<string, Promise<void>>()
  const rpcHandler = ctx.webui.listeners['rpc:request']
  if (rpcHandler) {
    const wrapped = async function (this: { id: string }, body: RpcRequest) {
      const token = body?.args?.[0]
      if (typeof token === 'string' && token) {
        const generation = (generations.get(this.id) ?? 0) + 1
        generations.set(this.id, generation)
        try {
          const user = await ctx.users.verifyToken(token)
          if (generations.get(this.id) === generation && user.kind === 'human') {
            const prior = identities.get(this.id)
            const needsProgressSnapshot = !prior || prior.userId !== user.id || prior.token !== token
            identities.set(this.id, { token, userId: user.id })
            if (needsProgressSnapshot) {
              const client = ctx.webui.clients[this.id]
              for (const snapshot of ctx.agentRuntime.listActiveProgress()) {
                if (isMember(ctx, snapshot.sessionId, user.id)) {
                  try { client?.send({ type: 'space:agent-progress-snapshot', body: snapshot }) }
                  catch { /* Reconnect hydration is best-effort; the next authenticated RPC retries it. */ }
                }
              }
            }
          } else if (generations.get(this.id) === generation) identities.delete(this.id)
        } catch {
          if (generations.get(this.id) === generation) identities.delete(this.id)
        }
      }
      return rpcHandler.call(this as never, body)
    }
    ctx.webui.listeners['rpc:request'] = wrapped
    ctx.effect(() => () => {
      if (ctx.webui.listeners['rpc:request'] === wrapped) ctx.webui.listeners['rpc:request'] = rpcHandler
      identities.clear()
      generations.clear()
    })
  }
  ctx.on('webui/connection', (client) => {
    client.socket.addEventListener('close', () => {
      identities.delete(client.id)
      generations.delete(client.id)
    })
  })

  async function sendToSession(sessionId: string, type: string, body: unknown) {
    await Promise.all(Object.entries(ctx.webui.clients).map(async ([clientId, client]) => {
      const user = await activeIdentity(ctx, identities, clientId)
      if (!user || !isMember(ctx, sessionId, user.id)) return
      try { client.send({ type, body }) } catch { /* disconnected sockets are best-effort */ }
    }))
  }

  function queueProgress(update: AgentProgressUpdate) {
    const previous = progressQueues.get(update.runId) ?? Promise.resolve()
    const next = previous.then(() => sendToSession(update.sessionId, 'space:agent-progress', update))
    progressQueues.set(update.runId, next.catch(() => {}))
  }

  function flushTextProgress(runId: string) {
    const timer = textTimers.get(runId)
    if (timer) clearTimeout(timer)
    textTimers.delete(runId)
    const update = pendingText.get(runId)
    pendingText.delete(runId)
    if (update) queueProgress(update)
  }

  ctx.on('space/event-appended', ({ event }) => {
    // Payloads carry only an opaque event pointer. The authenticated session RPC
    // returns content after checking active membership.
    void sendToSession(event.sessionId, 'space:event', {
      sessionId: event.sessionId, eventId: event.id, seq: event.seq,
    })
  })
  ctx.on('space/session-renamed', (update) => {
    void sendToSession(update.sessionId, 'space:session-renamed', update)
  })
  ctx.on('session-work/changed', async (state) => {
    await Promise.all(Object.entries(ctx.webui.clients).map(async ([clientId, client]) => {
      const user = await activeIdentity(ctx, identities, clientId)
      if (!user) return
      const visibleIds = new Set(ctx.session.listSessions()
        .filter((session) => isMember(ctx, session.id, user.id)).map((session) => session.id))
      const activeVisible = Boolean(state.activeSessionId && visibleIds.has(state.activeSessionId))
      const filtered = {
        activeSessionId: activeVisible ? state.activeSessionId : null,
        owners: activeVisible ? state.owners : [],
        queue: state.queue.filter((item) => visibleIds.has(item.sessionId)),
      }
      try { client.send({ type: 'space:session-work', body: filtered }) } catch { /* best-effort */ }
    }))
  })
  ctx.on('space/agent-progress', (update: AgentProgressUpdate) => {
    if (update.phase !== 'text-delta') {
      flushTextProgress(update.runId)
      queueProgress(update)
      if (['completed', 'failed', 'cancelled'].includes(update.phase)) {
        const timer = setTimeout(() => {
          progressQueues.delete(update.runId)
          progressRetentionTimers.delete(update.runId)
        }, 60_000)
        timer.unref?.()
        progressRetentionTimers.set(update.runId, timer)
      }
      return
    }
    const pending = pendingText.get(update.runId)
    pendingText.set(update.runId, {
      ...update,
      delta: `${pending?.delta ?? ''}${update.delta ?? ''}`,
    })
    if (!textTimers.has(update.runId)) {
      textTimers.set(update.runId, setTimeout(() => flushTextProgress(update.runId), 100))
    }
  })
  ctx.on('space/plan', (signal) => {
    if (!signal.mentions.length) return
    for (const agentId of signal.mentions) {
      void sendToSession(signal.sessionId, 'space:agent-wants-to-speak', {
        sessionId: signal.sessionId, agentId, wantsToSpeak: false,
      })
    }
    void sendToSession(signal.sessionId, 'space:reply-pending', {
      sessionId: signal.sessionId,
      sourceEventId: signal.event.id,
      authorId: signal.authorId,
      mentions: signal.mentions,
      at: new Date().toISOString(),
    })
  })
  ctx.on('space/agent-wants-to-speak', (update: AgentWantsToSpeakUpdate) => {
    void sendToSession(update.sessionId, 'space:agent-wants-to-speak', update)
  })
  ctx.on('space/typing', (update) => {
    void sendToSession(update.sessionId, 'space:typing', update)
  })
  ctx.effect(() => () => {
    for (const timer of textTimers.values()) clearTimeout(timer)
    for (const timer of progressRetentionTimers.values()) clearTimeout(timer)
    textTimers.clear()
    progressRetentionTimers.clear()
    pendingText.clear()
    progressQueues.clear()
  })
  console.log(`[${name}] 就绪：按会话成员鉴权推送事件、Agent 进度与输入状态`)
}
