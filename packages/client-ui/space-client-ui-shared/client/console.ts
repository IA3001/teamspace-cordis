// console.ts —— 5172 控制台三页（/admin /models /agents）共享的版式词汇。
//
// 铁律 1：同一视觉语义第二次出现必须抽进 shared —— 页头/状态胶囊/分区卡片/
// 字段标签/操作行在三页里反复出现，所以在这里只定义一次。
//
// 设计口径（2026-10-05「专业界面」改版）：
//   · 页头：大标题 + 一句职责描述 + 右侧页级动作（导航/登出）
//   · 状态胶囊：描边圆点（绿=可用 / 橙=未配置），替代成堆的 el-tag
//   · 分区卡片：浅描边 + 微阴影圆角卡，标题带主色竖条，右侧可挂状态
//   · 表单：双列栅格（.sp-grid），长字段 span2；标签是 12.5px 次要色
//   · 操作行：虚线分隔的卡片底部操作区，结果内联显示（不再用大 alert）
// 样式全在 im.css 的「控制台专业版式」段；这里只有 h() 结构。
import { defineComponent, h, markRaw } from 'vue'
import type { VNodeChild } from 'vue'

// ── 侧栏 SVG 图标（2026-10-06：外壳默认图标零辨识度，手搓品牌线条图标）──
/** 由 path 数据生成 24×24 线性图标组件（外壳导航 20px 渲染，currentColor）。 */
export function svgIcon(d: string | string[], name: string) {
  const paths = Array.isArray(d) ? d : [d]
  return markRaw(defineComponent({
    name,
    render() {
      return h('svg', {
        viewBox: '0 0 24 24', width: 20, height: 20,
        fill: 'none', stroke: 'currentColor', 'stroke-width': 1.8,
        'stroke-linecap': 'round', 'stroke-linejoin': 'round',
      }, paths.map((p) => h('path', { d: p })))
    },
  }))
}

/** 各页面侧栏图标（随页面注册传入 page({ icon })）。 */
export const ICONS = {
  // 团队空间：双气泡聊天
  teamspace: svgIcon([
    'M21 11.5a8.38 8.38 0 0 1-8.5 8.5 8.5 8.5 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 8.5-8.5c.5 0 1 0 1.4.1',
    'M17 11h6m-3-3v6',
  ], 'SpIconTeamspace'),
  // Agent 配置：机器人
  agents: svgIcon([
    'M12 2v3',
    'M5 5h14a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z',
    'M9 11h.01M15 11h.01M9 15h6',
  ], 'SpIconAgents'),
  // 模型与接入：芯片
  models: svgIcon([
    'M9 2v3m6-3v3M9 19v3m6-3v3M2 9h3m-3 6h3m14-6h3m-3 6h3',
    'M6 4h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z',
    'M10 10h4v4h-4z',
  ], 'SpIconModels'),
  // 账号管理：双人
  admin: svgIcon([
    'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2',
    'M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z',
    'M22 21v-2a4 4 0 0 0-3-3.87M15 3.13a4 4 0 0 1 0 7.75',
  ], 'SpIconAdmin'),
  // 知识库：书
  kb: svgIcon([
    'M4 19.5A2.5 2.5 0 0 1 6.5 17H20',
    'M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2Z',
  ], 'SpIconKb'),
  // 登录/注册：钥匙
  auth: svgIcon([
    'M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0 3 3L22 7l-3-3m-3.5 3.5L19 4',
  ], 'SpIconAuth'),
}

/** 页级状态项：level ok=绿点 / warn=橙点 / off=红点。 */
export interface StatusItem {
  text: string
  /** ok=绿（可用/完成） warn=橙（暂停/未配置） idle=灰（待命/否） off=红（异常） */
  level: 'ok' | 'warn' | 'idle' | 'off'
  title?: string
}

/** 页头：标题 + 描述 + （可选）状态胶囊组 + 页级动作按钮。 */
export function pageHead(
  title: string,
  sub: string,
  options: {
    statuses?: StatusItem[]
    actions?: Array<{ label: string; onClick: () => void; danger?: boolean }>
  } = {},
) {
  const { statuses = [], actions = [] } = options
  return h('div', { class: 'sp-page-head' }, [
    h('div', null, [
      h('h2', title),
      h('div', { class: 'sp-page-sub' }, sub),
      statuses.length
        ? h('div', { class: 'sp-status-group' },
            statuses.map((s) => status(s)))
        : null,
    ]),
    actions.length
      ? h('div', { class: 'sp-page-actions' }, actions.map((a) =>
          h('el-button', {
            key: a.label, text: true, size: 'small',
            type: a.danger ? 'danger' : undefined,
            onClick: a.onClick,
          }, { default: () => a.label })))
      : null,
  ])
}

/** 状态胶囊。 */
export function status(s: StatusItem) {
  return h('span', { class: `sp-status sp-status--${s.level}`, title: s.title }, [
    h('i'),
    s.text,
  ])
}

/** 分区卡片：标题（带主色竖条）+ 描述 + 内容；head 右侧可挂自定义节点。 */
export function section(
  title: string,
  desc: string,
  children: VNodeChild[],
  headExtra: VNodeChild = null,
) {
  return h('section', { class: 'sp-section' }, [
    h('div', { class: 'sp-section-head' }, [
      h('div', null, [
        h('h3', { class: 'sp-section-title' }, title),
        desc ? h('div', { class: 'sp-section-desc' }, desc) : null,
      ]),
      headExtra,
    ]),
    ...children,
  ])
}

/** 表单字段：小标签 + 控件 +（可选）提示。放进 .sp-grid 使用。 */
export function field(label: string, control: VNodeChild, hint?: string, span2 = false) {
  return h('div', { class: span2 ? 'sp-span2' : undefined }, [
    h('div', { class: 'sp-field-label' }, label),
    control,
    hint ? h('div', { class: 'sp-hint' }, hint) : null,
  ])
}

/** 卡片底部操作行：按钮 + 内联结果文本。 */
export function actionsRow(buttons: VNodeChild[], result?: { ok: boolean; text: string } | null) {
  return h('div', { class: 'sp-actions' }, [
    ...buttons,
    result && result.text
      ? h('span', {
          class: `sp-result ${result.ok ? 'sp-result--ok' : 'sp-result--err'}`,
        }, result.text)
      : null,
  ])
}

/** 全页结果条（替代笨重的 el-alert）。 */
export function note(msg: string, ok: boolean) {
  return h('div', { class: `sp-note ${ok ? 'sp-note--ok' : 'sp-note--err'}` }, msg)
}

/** 登录门（拒绝态）：品牌徽标 + 标题 + 说明 + 表单插槽，居中卡片。
 *  替代原先「空盒插画 + 满宽裸表单」的丑形态（2026-10-07）。 */
export function loginGate(
  opts: { brand: string; title: string; desc: string; children: VNodeChild[] },
) {
  return h('div', { class: 'sp-login-gate' }, [
    h('div', { class: 'sp-section sp-login-box' }, [
    h('div', { class: 'sp-admin-login-badge' }, opts.brand),
      h('h2', { class: 'sp-login-title' }, opts.title),
      h('div', { class: 'sp-login-sub' }, opts.desc),
      ...opts.children,
    ]),
  ])
}
