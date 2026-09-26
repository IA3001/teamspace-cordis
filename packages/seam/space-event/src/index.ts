// seam/space-event —— 能力缝。
//
// 这一层**只有词汇**：Service 声明 + 类型 + 错误分类法。零实现、零 IO。
// 实现放 packages/impl/，策略放 packages/policy/；两处都只能依赖本包。
// 依赖方向由 scripts/lint-deps.sh 强制（依据 dev-cordis/MODULE-PLAN.md 第 3.7 节 / 断言 ①②）。
//
// 词汇（承旧 domain/event.go）：
//   事件模型（append-only）、会话内序号、事件类型注册表
//
// ⚠️ 服务名是 ctx.eventLog，**不是** ctx.events —— cordis 内核已占用 `events`
// （内核的 events 是事件总线，本缝是会话内 append-only 的事件存储，两回事）。
// 2026-09-27 P0 实测撞名（TS2717）后改名，见 MODULE-PLAN 修订记录。
//
// P0 阶段：只立 Service 声明，零业务。真能力在 P1。
import { Service } from 'cordis'
import type { Context } from 'cordis'

declare module 'cordis' {
  interface Context {
    eventLog: EventLogService
  }
}

export class EventLogService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'eventLog')
  }
}