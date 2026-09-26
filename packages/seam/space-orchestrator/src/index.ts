// seam/space-orchestrator —— 能力缝。
//
// 这一层**只有词汇**：Service 声明 + 类型 + 错误分类法。零实现、零 IO。
// 实现放 packages/impl/，策略放 packages/policy/；两处都只能依赖本包。
// 依赖方向由 scripts/lint-deps.sh 强制（依据 dev-cordis/MODULE-PLAN.md 第 3.7 节 / 断言 ①②）。
//
// 词汇（承旧 domain/coordinator.go、domain/loop_detect.go）：
//   委托决策、授权名单（词汇，不是判定）、**暂停点 await_human**、三级兜底结果形状
//
// 职责分家（MODULE-PLAN 第 4 节）：
//   本缝 = 「委托 / 暂停」的词汇与状态机
//   policy/space-authz = 「谁被授权、NLP 怎么判、兜底怎么写」
//
// P0 阶段：只立 Service 声明，零业务。真能力在 P3。
import { Service } from 'cordis'
import type { Context } from 'cordis'

declare module 'cordis' {
  interface Context {
    orchestrator: OrchestratorService
  }
}

export class OrchestratorService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'orchestrator')
  }
}