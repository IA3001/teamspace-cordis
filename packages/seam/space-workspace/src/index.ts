// seam/space-workspace —— 能力缝。
//
// 这一层**只有词汇**：Service 声明 + 类型 + 错误分类法。零实现、零 IO。
// 实现放 packages/impl/，策略放 packages/policy/；两处都只能依赖本包。
// 依赖方向由 scripts/lint-deps.sh 强制（依据 dev-cordis/MODULE-PLAN.md 第 3.7 节 / 断言 ①②）。
//
// 词汇（承旧 domain/{gantt,story,kickoff,template,disposition,evaluation,summarizer}）：
//   工作台视图模型 —— **先合一个包，不预拆**（MODULE-PLAN 第 7 节待定 4）
//
// 硬判据（防止它变成杂物袋）：
//   桶里任何成员一旦「**需要换实现**」（summarizer 换模型 / evaluation 换评分器 …），
//   该成员**必须立刻独立成 seam**，不得赖在这里。
//
// P0 阶段：只立 Service 声明，零业务。真能力在后续阶段。
import { Service } from 'cordis'
import type { Context } from 'cordis'

declare module 'cordis' {
  interface Context {
    workspace: WorkspaceService
  }
}

export class WorkspaceService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'workspace')
  }
}