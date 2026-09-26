// seam/space-session —— 能力缝（capability seam）。
//
// 这一层**只有词汇**：Service 声明 + 类型 + 错误分类法。零实现、零 IO。
// 实现放 packages/impl/，策略放 packages/policy/；两处都只能依赖本包。
// 依赖方向由 scripts/lint-deps.sh 强制（依据 dev-cordis/MODULE-PLAN.md 第 3.7 节 / 断言 ①②）。
//
// 词汇（承旧 services/store/member.go、domain/principal.go、domain/dri_rotation.go）：
//   Session / Member / Role（含 coordinator —— 它不参与调用链）
//   + 角色冲突错误分类法
//
// P0 阶段：只立 Service 声明，零业务。真能力在 P1。
import { Service } from 'cordis'
import type { Context } from 'cordis'

declare module 'cordis' {
  interface Context {
    session: SessionService
  }
}

export class SessionService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'session')
  }
}