// space-push —— 实时推送（IM 化改造 2026-09-30）。
//
// 订阅内核事件 'space/event-appended'（store 落库时恰好一次 emit），把新事件
// 通过 teamspace isolate 的 webui websocket 广播给所有在线客户端 —— 替代前端
// 4s/5s 轮询。广播原语 ctx.webui.broadcast(type, body) 由 @cordisjs/plugin-webui
// 提供；本插件必须与 teamspace-webui 同 isolate（composed 配置里
// isolate: { webui: teamspace }），这样 ctx.webui 才是 5174 那个实例，
// 5172 调试控制台不受影响。
//
// 消息形状：{ type: 'space:event', body: { event } } —— 客户端在
// ctx.client.socket 上按 type 分发（见 space-client-ui-teamspace client）。
import type { Context } from 'cordis'

export const name = 'space-push'
export const inject = ['webui']

export function apply(ctx: Context) {
  ctx.on('space/event-appended', ({ event }) => {
    ctx.webui.broadcast('space:event', { event })
  })
  console.log(`[${name}] 就绪：space/event-appended → webui.broadcast('space:event')`)
}
