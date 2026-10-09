// seam/space-bus —— 输出层（L10）外发通道词汇缝。
//
// 这一层**只有词汇**：Service 声明 + 类型 + 错误分类法。零实现、零 IO。
// 现实现是 plugins/space-push 对 webui.broadcast 的封装位（本阶段仍是空壳
// 声明，先立契约）；出口只有这一个 —— 输出侧另开第二个广播口即违章程
// （ARCHITECTURE 反模式 ④）。
//
// channel 约定：
//   'session:<id>' —— 某会话的私域频道；'global' —— 全局频道。
// 词汇（承旧 services/sse/）：
//   推送信封 —— 谁订阅、重放策略
//
// P0 阶段：只立 Service 声明，零业务。真能力在后续阶段（impl/space-bus-sse）。
import { Service } from 'cordis'
import type { Context } from 'cordis'

declare module 'cordis' {
  interface Context {
    bus: BusService
  }
}

// ── 错误分类法（实现与策略不得自造错误串）────────────────────────────────
export type BusErrorCode = 'unknown_channel' | 'channel_closed'

export class BusError extends Error {
  constructor(
    public readonly code: BusErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'BusError'
  }
}

// ── 服务缝 ────────────────────────────────────────────────────────────────
// 实现层必须保证的语义：
//   · publish：未声明的 channel → unknown_channel；已关闭的 channel
//     → channel_closed。payload 是不透明载荷，本缝不解释其内容。
//   · channels：返回当前已声明的频道名列表（稳定排序）。
export abstract class BusService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'bus')
  }

  /** 向一个频道外发一条载荷（不透明，外发语义由实现层定）。 */
  abstract publish(channel: string, payload: unknown): Promise<void>

  /** 当前已声明的频道列表。 */
  abstract channels(): string[]
}
