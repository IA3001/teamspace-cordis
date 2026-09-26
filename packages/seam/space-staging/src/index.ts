// seam/space-staging —— 能力缝。
//
// 这一层**只有词汇**：Service 声明 + 类型 + 错误分类法。零实现、零 IO。
// 实现放 packages/impl/，策略放 packages/policy/；两处都只能依赖本包。
// 依赖方向由 scripts/lint-deps.sh 强制（依据 dev-cordis/MODULE-PLAN.md 第 3.7 节 / 断言 ①②）。
//
// 词汇（承旧前端 StagingPanel.vue + 指令族；旧 store/doc.go 已为它预留 0006_staging_entries）：
//   Entry{ID, SessionID, AuthorID, Seq, Text, CreatedAt}
//   硬约束：**只有作者能改 / 撤自己的条目**
//
// P0 阶段：只立 Service 声明，零业务。真能力在 P2。
import { Service } from 'cordis'
import type { Context } from 'cordis'

declare module 'cordis' {
  interface Context {
    staging: StagingService
  }
}

export class StagingService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'staging')
  }
}