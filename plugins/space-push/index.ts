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

interface ClientIdentity { token: string; userId: string }
interface RpcRequest { args?: unknown[] }

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
export const inject = ['webui', 'sessionWork', 'users', 'session']

export function apply(ctx: Context) {
  const identities = new Map<string, ClientIdentity>()
  const generations = new Map<string, number>()
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
            identities.set(this.id, { token, userId: user.id })
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

  ctx.on('space/event-appended', ({ event }) => {
    // Payloads carry only an opaque event pointer. The authenticated session RPC
    // returns content after checking active membership.
    void sendToSession(event.sessionId, 'space:event', {
      sessionId: event.sessionId, eventId: event.id, seq: event.seq,
    })
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
  ctx.on('space/agent-progress', (update) => {
    void sendToSession(update.sessionId, 'space:agent-progress', update)
  })
  ctx.on('space/typing', (update) => {
    void sendToSession(update.sessionId, 'space:typing', update)
  })
  console.log(`[${name}] 就绪：按会话成员鉴权推送事件、Agent 进度与输入状态`)
}
