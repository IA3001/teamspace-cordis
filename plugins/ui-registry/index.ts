// ui-registry —— ctx.ui 服务实例的**唯一**提供者（P4）。
//
// 谁提供谁创建：与 command-bus 同款 —— UiRegistry（seam/space-ui 的内存
// 注册表）只能有一个提供者，各 client-ui 区埿包都往这一个实例登记 Panel，
// 各自 new 会互相覆盖 ctx.ui。本插件零业务：只负责「让 ctx.ui 存在」。
import type { Context } from 'cordis'
import { PANEL_SLOTS, UIError, UIService } from 'space-ui'
import type { Panel, PanelSlot } from 'space-ui'

export class UiRegistry extends UIService {
  // TS private（编译期私有，代理安全）—— 不用 # 私有字段（cordis 服务代理
  // 重绑 this 后品牌校验必炸，2026-09-27 实测）。
  private readonly panels = new Map<string, Panel>()

  registerPanel(panel: Panel): void {
    if (!panel.key || !panel.key.trim()) {
      throw new UIError('not_found', 'Panel key 不能为空')
    }
    if (!(PANEL_SLOTS as readonly string[]).includes(panel.slot)) {
      throw new UIError('invalid_slot', `slot "${panel.slot}" 非法（只允许 ${PANEL_SLOTS.join(' / ')}）`)
    }
    if (this.panels.has(panel.key)) {
      throw new UIError('duplicate_panel', `Panel key "${panel.key}" 已注册（重名是编程错误，注册期就炸）`)
    }
    this.panels.set(panel.key, { ...panel })
  }

  listPanels(slot?: PanelSlot): Panel[] {
    return [...this.panels.values()]
      .filter((p) => !slot || p.slot === slot)
      .sort((a, b) => (a.slot === b.slot ? 0 : a.slot.localeCompare(b.slot)) ||
        (a.order ?? 0) - (b.order ?? 0) || a.key.localeCompare(b.key))
  }
}

export function apply(ctx: Context) {
  // Service 基类的注册动作：构造即 provide（见 space-command 同款用法）。
  new UiRegistry(ctx)
}
