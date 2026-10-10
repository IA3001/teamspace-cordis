// 显示映射（铁律 1：页面只做组合；同一视觉语义第二次出现 → 抽进 shared）。
//
// 这里只有「值 → 人话」的纯函数，零组件、零样式、零令牌。

/** 成员的客户端视图（只要显示需要的列；duty = 分工展示名，缺省空）。 */
export interface MemberLite {
  principalId: string
  role: string
  duty?: string
}

/** 成员 → 「显示名（id）」：有分工展示名用分工，无则用角色。 */
export function memberLabel(m: MemberLite): string {
  return `${m.duty?.trim() ? m.duty : m.role}（${m.principalId}）`
}

/** authorId → 「显示名（id）」；null = 系统事件；成员表缺人时降级为裸 id。 */
export function authorLabel(authorId: string | null, members: readonly MemberLite[]): string {
  if (!authorId) return '系统'
  const m = members.find((x) => x.principalId === authorId)
  return m ? memberLabel(m) : authorId
}

/** ISO 时间戳 → HH:MM:SS（本地时区；解析不了就原样给）。 */
export function formatTime(ts: string): string {
  const d = new Date(ts)
  return Number.isNaN(d.getTime()) ? ts : d.toLocaleTimeString('zh-CN', { hour12: false })
}

/** 事件条目的客户端视图（时间线渲染需要的列）。 */
export interface EventLite {
  id: string
  seq: number
  ts: string
  authorId: string | null
  authorKind: string
  kind: string
  text: string
}
