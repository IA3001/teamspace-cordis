/// <reference types="vite/client" />

// 团队空间整页（客户端）—— IM 化改造（2026-09-30，用户拍板）。
//
// 布局（k-layout 外壳 chrome + 外壳共享布局类，零手写样式）：
//   k-layout（.page-content：薄顶栏 .layout-header + .main-content flex 行）
//   ├ #header 槽：折叠开关 + 会话标题 + 状态徽章
//   ├ #menu   槽：「协作面板」开关（宽屏常驻 / 窄屏默认折叠）
//   └ 默认槽 → .main-content（flex 行）：
//       ├ aside.page-sidebar（左：会话栏，由 space-client-ui-sessions 经槽位入驻）
//       ├ div.content-area（中：消息区 + composer）
//       └ aside.right-sidebar（右：协作面板常驻列）
//
// IM 化交互（本次改造）：
//   · 实时推送：ctx.client.socket 监听 'space:event'，新事件增量合并进时间线；
//     4s 轮询删除（断线重连后一次全量刷新兜底）。
//   · 滚动跟随：只有贴近底部（<80px）才自动跟随；偏离时显示「回到最新」悬浮按钮。
//   · 发送即上屏：乐观插入（本地临时事件 → 服务端确认后按 id 对齐/去重）；
//     发送中按钮 loading、Enter 直发被拦（防连发）。
//   · 身份：me() 从 token 解析真实登录用户（DRI 硬编码已删除）。
//   · 已结束会话：composer 禁用。
//   · 空输入 Enter 静默忽略；成功回执 3s 自动消隐（错误常显可手动关）。
//   · token 统一 localStorage 'space_token'（/login 页写入）；无效时跳 /login。
//
// 既有交互（原样保留）：斜杠指令联想（现注册：/todo /tell /summary /code 等，
//   暂存指令族已于 2026-10-02 注销）、
// @ 联想浮层与完整键盘导航（↑↓/Enter/Tab/Esc/Shift+Enter）、右面板数据口径、
// closable el-tag 暂存条目（仅非空时显示）。
import { computed, defineComponent, h, nextTick, onMounted, onUnmounted, ref, resolveComponent, watch } from 'vue'
import type { Component, VNodeChild } from 'vue'
import { useRpc, useContext, useRoute, useRouter } from '@cordisjs/client'
import EventItem from 'space-client-ui-shared/client/EventItem.ts'
import { ThemeStyle } from 'space-client-ui-shared/client/theme.ts'
import { ICONS } from 'space-client-ui-shared/client/console.ts'
import 'space-client-ui-shared/client/im.css'
import { renderMarkdown } from 'space-client-ui-shared/client/md.ts'
import IconBtn from 'space-client-ui-shared/client/IconBtn.ts'
import { authorLabel, formatTime, memberLabel } from 'space-client-ui-shared/client/labels.ts'
import type { EventLite, MemberLite } from 'space-client-ui-shared/client/labels.ts'
import { AgentManagementPage, AGENT_PAGE_ICON } from './agents.ts'
import { appendProgressDelta, progressPreviewLabel } from './progress.ts'

interface SessionLite { id: string; title: string; status: string; updatedAt?: string }
interface SessionWorkLite {
  activeSessionId: string | null
  owners: string[]
  queue: Array<{ sessionId: string; owner: string; position: number }>
}
interface StagingEntry { id: string; seq: number; text: string; authorId: string }
interface TurnLite {
  state: string
  decisionCalls: number
  delegatedTargets: string[]
  stopReason: string
  stopDetail: string
  autonomousActions?: number
  sessionWork?: SessionWorkLite
}
type SendResult = { reply?: string; event?: EventLite } | { error: string; detail: string }
/**
 * 本地事件视图：在 shared 的 EventLite 之上补撤回字段（shared 不动，避免跨包冲突；
 * sqlite eventLog 的 toEvent 已带 voided，服务端返回的对象天然多这个字段，加 (?) 即对齐）。
 */
type TEvent = EventLite & {
  sessionId?: string
  sourceEventId?: string | null
  replyTo?: string | null
  sourceEventIds?: string[]
  voided?: boolean
  toolCalls?: Array<{ name: string; args: string; result?: string; err?: string }>
}
type AgentProgressLite = {
  runId: string
  sessionId: string
  agentId: string
  title: string
  sourceEventId: string | null
  phase: 'started' | 'preparing' | 'processing' | 'tool-start' | 'tool-finish' | 'text-delta' | 'finalizing' | 'completed' | 'failed' | 'cancelled'
  toolId?: string
  ok?: boolean
  delta?: string
  at: string
  steps: Array<{ label: string; at: string }>
  streamText?: string
  streamCharacterCount?: number
  streamTruncated?: boolean
}

function downstreamAgentCounts(events: readonly TEvent[]): Map<string, number> {
  const ancestorsByEvent = new Map<string, Set<string>>()
  const counts = new Map<string, number>()
  for (const event of [...events].sort((a, b) => a.seq - b.seq)) {
    if (event.voided) continue
    const ancestors = new Set<string>()
    for (const sourceId of event.sourceEventIds ?? []) {
      ancestors.add(sourceId)
      for (const ancestor of ancestorsByEvent.get(sourceId) ?? []) ancestors.add(ancestor)
    }
    ancestorsByEvent.set(event.id, ancestors)
    if (event.authorKind === 'agent' && event.kind === 'message') {
      for (const sourceId of ancestors) counts.set(sourceId, (counts.get(sourceId) ?? 0) + 1)
    }
  }
  return counts
}
/** 表情回应汇总（本地镜像 seam space-event 的 ReactSummary，shared 不动照 voided 惯例）。 */
interface ReactSummaryLite { emoji: string; count: number; users: string[] }
type ReactResult = ReactSummaryLite[] | { error: string }
/** 回应面板固定五选（不用 popover：直接展开一排，避免传送门不确定性）。 */
const REACTION_EMOJIS = ['👍', '❤️', '😂', '🎯', '❓'] as const
interface MeLite { id: string; username: string; displayName: string }
interface CommandLite { name: string; usage: string; minArgs: number; maxArgs: number }
/** AI 成员工作状态（agents RPC 的客户端视图）。 */
interface AgentView { id: string; title: string; status: string; capabilities?: string[] }
/** 团队待办（todos RPC 的客户端视图；序号由渲染时按 createdAt 升序编，不持久化）。 */
interface TodoView { id: string; done: boolean; text: string; createdAt: string }
/** 联想菜单：null = 关闭；否则 slash（指令联想）或 mention（成员联想）。 */
type Menu = { kind: 'slash'; query: string } | { kind: 'mention'; query: string } | null

const STATE_LABEL: Record<string, string> = {
  chain: '进行中',
  static: '已暂停',
}
const STATE_TAG: Record<string, string> = { chain: 'warning', static: 'info' }
const STOP_LABEL: Record<string, string> = {
  await_human: '等待人类下一步指示',
  await_human_decision: '等待 DRI 决策',
  completed: '回合完成',
  budget_exhausted: '自治预算已用完，等待人类',
  invalid_target: '委托目标不在授权名单',
  coordinator_unconfigured: '协调者未配置',
  coordinator_error: '协调者调用失败',
  coordinator_empty: '协调者空输出',
  duplicate_target: '同轮重复委托',
}
const sessionStatus = (s: SessionLite) =>
  ({ label: s.status === 'closed' ? '已结束' : '进行中', tag: s.status === 'closed' ? 'info' : 'success' })

/** 可被 @ 的角色（目标 agent + 人类）——协调者不在清单。 */
const MENTION_ROLES = new Set(['会议记录官', '挑战者', '需求分析师', 'DRI', '成员', '群主', '管理员'])

/** 消息文本里的 @提及 切片：at=true 的段渲染成 el-tag。 */
export function splitMentions(text: string): Array<{ t: string; at: boolean }> {
  const out: Array<{ t: string; at: boolean }> = []
  const re = /@[^\s@]+/g
  let last = 0
  for (const m of text.matchAll(re)) {
    const i = m.index ?? 0
    if (i > last) out.push({ t: text.slice(last, i), at: false })
    out.push({ t: m[0], at: true })
    last = i + m[0].length
  }
  if (last < text.length) out.push({ t: text.slice(last), at: false })
  return out
}

/** 按查询词大小写不敏感切分文本：hit=true 的段 = 命中（搜索结果渲染成 warning tag）。
 *  空 query（trim 后）不切分，整段原样返回。 */
export function splitHighlight(text: string, query: string): Array<{ t: string; hit: boolean }> {
  const q = query.trim()
  if (!q) return [{ t: text, hit: false }]
  const out: Array<{ t: string; hit: boolean }> = []
  const lower = text.toLowerCase()
  const lq = q.toLowerCase()
  let last = 0
  for (let i = lower.indexOf(lq); i >= 0; i = lower.indexOf(lq, last)) {
    if (i > last) out.push({ t: text.slice(last, i), hit: false })
    out.push({ t: text.slice(i, i + q.length), hit: true })
    last = i + q.length
  }
  if (last < text.length) out.push({ t: text.slice(last), hit: false })
  return out
}

// ── 文件消息（最小可行版，2026-10-01）──────────────────────────────────
// 上传成功后前端把下载路径拼进消息文本（[文件] 开头），不进事件新列。
// 判断/拆分辅助与渲染共用（人类气泡 + 搜索结果都走 renderText）。
export function isFileMessage(text: string): boolean {
  return text.startsWith('[文件]')
}
/** [文件] 名 (大小KB)\n<url> → { title, url }；不是文件消息或格式不全 → null。 */
export function splitFileMessage(text: string): { title: string; url: string } | null {
  if (!isFileMessage(text)) return null
  const nl = text.indexOf('\n')
  if (nl < 0) return null
  const url = text.slice(nl + 1).trim()
  if (!url || url.includes('\n')) return null
  return { title: text.slice(0, nl).trim(), url }
}
/** 下载 url 的扩展名是不是图片（→ 用 el-image 展示而非 el-link）。 */
const IMAGE_RE = /\.(png|jpe?g|gif|webp)$/i

// ── 服务流程系统事件（flow-commands 落的三类 ⚙ 文本）────────────────────
// 启动：`⚙ 服务流程 [code] 启动：实现登录页（步骤：编码者 → 测试者 → 代码审查者）`
// 推进：`⚙ 流程推进（2/3）：交给「测试者」`
// 完成：`⚙ 服务流程 [code] 完成（编码者 → 测试者 → 代码审查者）`
/** 解析后的流程视图：current = el-steps 的 active（已完成步数）。 */
export interface FlowEventView {
  kind: 'start' | 'advance' | 'done'
  flowName: string
  task?: string
  steps: string[]
  current: number
}
/** 解析一条系统事件文本；非 ⚙ 开头或形状不符 → null（走原渲染）。
 *  推进行没有流程名/steps —— 用 ctx（时间线顺序遍历维护的最近一条启动/完成行）补齐。 */
export function parseFlowEvent(
  text: string,
  ctx?: { flowName?: string; steps?: string[] },
): FlowEventView | null {
  if (!text.startsWith('⚙')) return null
  const splitSteps = (s: string) => s.split(' → ').map((x) => x.trim()).filter(Boolean)
  // 启动行：current=0（第一步进行中，el-steps active 语义 = 已完成数）。
  let m = /⚙\s*服务流程\s*\[([^\]]+)\]\s*启动：(.+?)（步骤：(.+?)）/.exec(text)
  if (m) {
    const steps = splitSteps(m[3]!)
    if (!steps.length) return null
    return { kind: 'start', flowName: m[1]!, task: m[2]!.trim(), steps, current: 0 }
  }
  // 完成行：current = steps.length（全部完成）。
  m = /⚙\s*服务流程\s*\[([^\]]+)\]\s*完成（(.+?)）/.exec(text)
  if (m) {
    const steps = splitSteps(m[2]!)
    if (!steps.length) return null
    return { kind: 'done', flowName: m[1]!, steps, current: steps.length }
  }
  // 推进行：n/total → active = n-1（前 n-1 步完成、第 n 步进行中）；steps 取上文最近启动行。
  m = /⚙\s*流程推进（(\d+)\/(\d+)）：交给「(.+?)」/.exec(text)
  if (m) {
    if (!ctx?.flowName || !ctx.steps?.length) return null
    const n = Number(m[1])
    return {
      kind: 'advance', flowName: ctx.flowName, steps: ctx.steps, current: n - 1,
      task: `交给「${m[3]}」（第 ${m[1]}/${m[2]} 步）`,
    }
  }
  return null
}

/** 分隔线日期文案：今天显示「今天」，否则「MM月DD日」。 */
export function dayLabel(ts: string): string {
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return ''
  const now = new Date()
  const sameDay = d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() && d.getDate() === now.getDate()
  return sameDay ? '今天' : `${d.getMonth() + 1}月${d.getDate()}日`
}

/** 自治预算分母：与 bundle patch 的 autonomyBudget 对齐（turn 上没有时用这个常量）。 */
const AUTONOMY_BUDGET = 8
const CENTERED = 'k-content'
/** 登录 token 的 localStorage 键（/login 页与各 RPC 共用）。 */
const TOKEN_KEY = 'space_token'
/** 后端 HTTP 基址（撤回/上传走 HTTP，与页面宿主 5174 不同端口）：懒取一次。 */
let apiBase = ''
function getApiBase(): string {
  return apiBase || `${location.protocol}//${location.hostname}:8080`
}

const getToken = () => localStorage.getItem(TOKEN_KEY) ?? ''
const isUnauth = (r: unknown) => typeof r === 'object' && r !== null && (r as { error?: string }).error === 'unauthorized'

const TeamspacePage = defineComponent({
  name: 'SpaceTeamspace',
  setup() {
    const rpc = useRpc<{
      me(token: string): Promise<MeLite | null>
      sessions(token: string): Promise<SessionLite[]>
      commands(token: string): Promise<CommandLite[]>
      events(token: string, sessionId: string): Promise<EventLite[] | null>
      event(token: string, sessionId: string, eventId: string): Promise<TEvent | null>
      search(token: string, sessionId: string, query: string): Promise<EventLite[] | null>
      members(token: string, sessionId: string): Promise<MemberLite[] | null>
      staging(token: string, sessionId: string): Promise<StagingEntry[] | null>
      turn(token: string, sessionId: string): Promise<TurnLite | null>
      memories(token: string, sessionId: string): Promise<Array<{ text: string }> | null>
      todos(token: string, sessionId: string): Promise<TodoView[] | null>
      agents(token: string): Promise<AgentView[] | null>
      apiConfig(token: string): Promise<{ publicBaseUrl: string | null; port: number } | null>
      humans(token: string): Promise<Array<{ id: string; username: string; displayName: string }> | null>
      send(token: string, sessionId: string, text: string, mentions?: string[], replyTo?: string | null): Promise<SendResult>
      typing(token: string, sessionId: string, name: string): Promise<void>
      react(token: string, sessionId: string, eventId: string, emoji: string): Promise<ReactResult>
      unreact(token: string, sessionId: string, eventId: string, emoji: string): Promise<ReactResult>
      reactions(token: string, sessionId: string): Promise<Record<string, ReactSummaryLite[]> | { error: string } | null>
      inviteAgent(token: string, sessionId: string, agentId: string): Promise<
        { ok: true; joined: boolean; title: string; detail: string } | { error: string; detail: string } | null
      >
    }>()
    const appCtx = useContext()
    const router = useRouter()
    const route = useRoute()

    const sessions = ref([]) as { value: SessionLite[] }
    const members = ref([]) as { value: MemberLite[] }
    const events = ref([]) as { value: TEvent[] }
    const progressRuns = ref([]) as { value: AgentProgressLite[] }
    const staging = ref([]) as { value: StagingEntry[] }
    const turn = ref(null) as { value: TurnLite | null }
    const sessionWork = ref({ activeSessionId: null, owners: [], queue: [] }) as { value: SessionWorkLite }
    const activeId = ref('')
    const draft = ref('')
    const reply = ref('')
    const replyOk = ref(true)
    const sending = ref(false)
    const me = ref(null) as { value: MeLite | null }
    const menu = ref(null) as { value: Menu }
    const activeIdx = ref(0)
    const inputEl = ref(null) as { value: HTMLTextAreaElement | null }
    const commands = ref([]) as { value: CommandLite[] }
    /** AI 成员工作状态（agents RPC；随每次 load 刷新）。 */
    const agents = ref([]) as { value: AgentView[] }
    const inviteAgentId = ref('')
    const invitingAgent = ref(false)
    const humans = ref([]) as { value: Array<{ id: string; username: string; displayName: string }> }
    /** 本会话 AI 沉淀记忆（memories RPC；随每次 load 刷新）。 */
    const memories = ref([]) as { value: Array<{ text: string }> }
    /** 团队待办（todos RPC；随每次 load 刷新，只读展示 —— 写路径只有 /todo 指令）。 */
    const todos = ref([]) as { value: TodoView[] }
    /** 引用回复（悬停消息点「引用」设置；发送时在文本前拼引用行，服务端原样落库）。 */
    const replyTo = ref(null) as { value: { author: string; summary: string; seq: number; id: string } | null }
    // ── 表情回应（IM 化 2026-10-01）────────────────────────────────────
    /** 全会话事件回应汇总（eventId → 汇总；随 load 拉取，react/unreact 就地更新）。 */
    const reactions = ref({}) as { value: Record<string, ReactSummaryLite[]> }
    /** 回应面板展开的消息 id（点「回应」切换；点别处/切会话不强制收起，简单直给）。 */
    const reactPickerId = ref('')
    // ── 搜索状态（null = 时间线模式；数组 = 命中列表模式）────────────────
    const searchQuery = ref('')
    const searchResults = ref(null) as { value: TEvent[] | null }
    /** 空会话引导 chips：角色 → 引导文案（@名 用成员表里真实存在的第一个对应角色）。 */
    const CHIP_ROLES: Array<[string, string]> = [
      ['需求分析师', '分析一下当前需求'],
      ['挑战者', '挑刺这个方案'],
      ['会议记录官', '记一下要点'],
    ]
    const mobileViewport = window.matchMedia('(max-width: 760px)')
    const isMobileViewport = ref(mobileViewport.matches)
    const panelOpen = ref(!mobileViewport.matches)
    const panelTab = ref('info')
    const activityLimit = ref(100)
    const railOpen = ref(!mobileViewport.matches)
    /** 「回到最新」按钮：偏离底部（>80px）且有时间线内容时显示。 */
    const nearBottom = ref(true)
    const hasRail = computed(() => (appCtx.client.router.views['space-teamspace-sidebar']?.length ?? 0) > 0)
    const scrollbar = ref<{ setScrollTop: (v: number) => unknown } | null>(null)
    /** 非贴底阅读时，保留视口顶部附近的消息及其相对位置，供窗口缩放后恢复。 */
    let scrollAnchor: { id: string; offset: number } | null = null
    let resizeFrame = 0
    let replyTimer: ReturnType<typeof setTimeout> | undefined
    let socket: WebSocket | undefined
    let replySeq = 0 // 乐观事件本地 id 序号

    const activeSession = computed(() => sessions.value.find((s) => s.id === activeId.value))
    const closed = computed(() => activeSession.value?.status === 'closed')

    const mentionCandidates = () => members.value.filter((m) => MENTION_ROLES.has(m.role))
    const invitableAgents = () => {
      const invited = new Set(members.value.map((member) => member.principalId))
      return agents.value.filter((agent) => !invited.has(agent.id))
    }

    // ── @所有人：合成候选（不在成员表里，哨兵 id = __all__）─────────────
    // 当 @token 匹配 all/所有人/everyone 时菜单多出「@所有人」一项，选中插入 '@所有人 '；
    // 发送时 parseMentions 把它归一成 '__all__'，服务端展开为全体在册成员。
    const ALL_TOKENS = new Set(['all', '所有人', 'everyone'])
    const ALL_MEMBER: MemberLite & { isAll?: boolean } = { principalId: '__all__', role: '所有人', isAll: true }
    const mentionItems = (q: string) => {
      const base = mentionCandidates()
        .filter((m) => m.principalId.toLowerCase().includes(q) || m.role.toLowerCase().includes(q) ||
          (m.duty ?? '').toLowerCase().includes(q))
      // 「所有人」合成候选放在真实成员之前（显式召唤全体是高频动作）。
      return ALL_TOKENS.has(q) ? [ALL_MEMBER as MemberLite, ...base] : base
    }

    // ── 联想菜单（业界惯例：输入 / 或 @ 时按当前 token 实时过滤）─────────
    const slashRe = /(?:^|\n)\/([a-z]*)$/i
    const mentionRe = /@([\w\u4e00-\u9fa5-]*)$/
    function deriveMenu(text: string): Menu {
      const slash = slashRe.exec(text)
      if (slash) {
        const q = slash[1]!.toLowerCase()
        return slashItems(q).length ? { kind: 'slash', query: q } : null
      }
      const at = mentionRe.exec(text)
      if (at) {
        const q = at[1]!.toLowerCase()
        return mentionItems(q).length ? { kind: 'mention', query: q } : null
      }
      return null
    }
    const slashItems = (q: string) => commands.value.filter((c) => c.name.startsWith(q))

    // @token 解析（2026-10-05 放宽）：@id 之外也认**角色/分工显示名**
    //（「@需求分析师」「@编码者」）—— 用户不该需要背内部 id。命中别名归一
    // 成员 id；打不出菜单的场景（粘贴、输入法直上）也能触发 AI。
    const parseMentions = (): string[] => {
      const cands = mentionCandidates()
      const aliasMap = new Map<string, string>()
      for (const m of cands) {
        for (const alias of [m.principalId, m.role, m.duty ?? '']) {
          const a = alias.trim().toLowerCase()
          if (a) aliasMap.set(a, m.principalId)
        }
      }
      const stripPunc = (t: string) => t.replace(/[，。！？、；：）】」」'"'\.,!?;:\)]+$/u, '')
      const picked = [...new Set((draft.value.match(/@([^\s@]+)/g) ?? [])
        .map((t) => stripPunc(t.slice(1)).toLowerCase())
        .map((t) => aliasMap.get(t))
        .filter((t): t is string => Boolean(t)))]
      // @所有人 → 哨兵 '__all__'（服务端 handleInbound 展开为全体在册成员 id）。
      if (/@(所有人|all|everyone)(?=\s|$)/i.test(draft.value)) picked.push('__all__')
      return picked
    }

    function unauthed() {
      replyOk.value = false
      reply.value = '请先登录'
      void router.replace({ path: '/login' })
    }

    // ── 搜索（时间线 ⇄ 命中列表两种渲染模式）────────────────────────────
    async function doSearch() {
      if (!activeId.value || !searchQuery.value.trim()) return
      try {
        const res = await rpc.value.search(getToken(), activeId.value, searchQuery.value.trim())
        if (isUnauth(res)) return unauthed()
        searchResults.value = res ?? []
      } catch (e) {
        showReply(`搜索失败：${String((e as Error).message ?? e)}`, false)
      }
    }
    /** 清除搜索：恢复全量时间线。 */
    function clearSearch() {
      searchResults.value = null
      searchQuery.value = ''
    }

    // ── 消息撤回（作者自撤）：调服务端 recall 路由，成功后本地乐观置 voided ─
    async function recallEvent(ev: TEvent) {
      if (!activeId.value) return
      try {
        const res = await fetch(`${getApiBase()}/api/sessions/${activeId.value}/events/${ev.id}/recall`, {
          method: 'POST',
          credentials: 'same-origin', // cookie 鉴权（space_token）
          headers: { authorization: `Bearer ${getToken()}` }, // 跨端口 fetch：Bearer 与 cookie 双通道
        })
        if (res.status === 401) return unauthed()
        if (!res.ok) {
          const body = await res.json().catch(() => null as { error?: string; detail?: string } | null)
          showReply(`撤回失败（${body?.error ?? res.status}）：${body?.detail ?? ''}`, false)
          return
        }
        // 乐观更新：本地直接标记 voided（socket 推送 / 全量刷新带回的 voided 字段与之自然一致）。
        events.value = events.value.map((e) => (e.id === ev.id ? { ...e, voided: true } : e))
        showReply('已撤回', true)
      } catch (e) {
        showReply(`撤回失败：${String((e as Error).message ?? e)}`, false)
      }
    }

    // ── 导出 Markdown（纯前端本地，无 RPC）：当前时间线 events → .md 下载 ──
    function exportMarkdown() {
      if (!events.value.length) return
      const title = activeSession.value?.title ?? '团队空间'
      const lines: string[] = [`## 会话 ${title}`, '']
      for (const ev of events.value) {
        const time = (ev.ts ?? '').slice(11, 19) // ISO 的 HH:MM:SS 段
        const author = authorLabel(ev.authorId, members.value)
        if (ev.kind === 'message') lines.push(`- [${time}] **${author}** ${ev.text}`)
        else lines.push(`- [${time}] *${ev.text}*`) // system 事件斜体
      }
      try {
        const blob = new Blob([lines.join('\n')], { type: 'text/markdown;charset=utf-8' })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = `${title}.md`
        a.click()
        URL.revokeObjectURL(url)
      } catch { /* 导出失败静默忽略 */ }
    }

    /** 纪要导出（A6，2026-10-06）：按回合折叠（人类发言开回合，其后的
     *  AI/系统内容归属该回合），产出 Word 可直接打开的 .doc（HTML 载体，
     *  无需后端）。脱离原文的占位/系统噪声行只保留服务流程的关键行。 */
    function exportMinutes() {
      if (!events.value.length) return
      const title = activeSession.value?.title ?? '团队空间'
      const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      type Turn = { q: { author: string; time: string; text: string } | null; rows: Array<{ author: string; time: string; text: string; kind: string; mine: boolean }> }
      const turns: Turn[] = []
      for (const ev of events.value) {
        if (ev.voided) continue
        const time = (ev.ts ?? '').slice(0, 16).replace('T', ' ')
        const author = authorLabel(ev.authorId, members.value)
        if (ev.kind === 'message' && (ev.authorKind === 'human')) {
          if (ev.authorId === me.value?.id) continue // 自己的发言是操作记录，不进纪要正文
          turns.push({ q: { author, time, text: ev.text }, rows: [] })
          continue
        }
        const rows = turns.length ? turns[turns.length - 1]!.rows : []
        if (ev.kind === 'message') rows.push({ author, time, text: ev.text, kind: ev.kind, mine: ev.authorKind === 'agent' })
        else if (/服务流程|已完成|开始/.test(ev.text)) rows.push({ author: '系统', time, text: ev.text, kind: 'system', mine: false })
      }
      // 自己的发言被跳过后可能产生空首回合 —— 清掉没有问答内容的回合。
      const usable = turns.filter((t) => t.q || t.rows.length)
      const body = usable.map((t, i) => {
        const head = t.q
          ? `<section><h2>议题 ${i + 1} · ${esc(t.q.author)} · ${esc(t.q.time)}</h2><p><strong>${esc(t.q.text)}</strong></p>`
          : '<section><h2>开场</h2>'
        const answers = t.rows.map((r) =>
          r.kind === 'system'
            ? `<p><em>系统：${esc(r.text)}</em></p>`
            : `<p><strong>${esc(r.author)}：</strong>${esc(r.text).replace(/\n/g, '<br/>')}</p>`,
        ).join('')
        return `${head}${answers}</section>`
      }).join('')
      const html = `<!doctype html><html><head><meta charset="utf-8"></head><body>
        <h1>会议纪要 —— ${esc(title)}</h1>
        <p>导出时间：${new Date().toLocaleString('zh-CN')}　·　共 ${usable.length} 个议题</p>
        ${body}
      </body></html>`
      try {
        const blob = new Blob(['\ufeff', html], { type: 'application/msword;charset=utf-8' })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = `纪要-${title}-${new Date().toISOString().slice(0, 10)}.doc`
        a.click()
        URL.revokeObjectURL(url)
      } catch { /* 导出失败静默忽略 */ }
    }

    // ── 草稿持久化（按会话隔离，localStorage）───────────────────────────
    watch(draft, (v) => {
      if (!activeId.value) return
      if (v) localStorage.setItem(`space_draft_${activeId.value}`, v)
      else localStorage.removeItem(`space_draft_${activeId.value}`)
    })
    /** 切换会话 / 首次挂载后恢复该会话草稿。 */
    function restoreDraft() {
      draft.value = localStorage.getItem(`space_draft_${activeId.value}`) ?? ''
    }

    // ── 桌面通知：页签不可见 + 非本人消息时弹系统通知 ────────────────────
    function notifyIfHidden(event: EventLite) {
      try {
        if (event.authorId === me.value?.id) return
        if (!document.hidden) return
        if (event.kind !== 'message' || !event.text) return
        // 免打扰联动：当前会话在 space_muted_sessions 名单（sessionId 字符串数组，
        // 会话栏开关 UI 写入，本处只做读取侧）内则不通知。
        const muted = JSON.parse(localStorage.getItem('space_muted_sessions') ?? '[]')
        if (Array.isArray(muted) && muted.includes(activeId.value)) return
        if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return
        new Notification(activeSession.value?.title ?? '团队空间', { body: event.text.slice(0, 60) })
      } catch { /* 通知失败静默忽略 */ }
    }

    // ── 「AI 正在输入」：仅 turn 进行中（chain）时每 5s 轮询 agents ──────
    let typingTimer: ReturnType<typeof setInterval> | undefined
    function stopTypingPoll() {
      if (typingTimer) { clearInterval(typingTimer); typingTimer = undefined }
    }
    function syncTypingPoll() {
      if (turn.value?.state === 'chain') {
        if (typingTimer) return
        typingTimer = setInterval(() => {
          void rpc.value.agents(getToken()).then((ag) => {
            if (ag && !isUnauth(ag)) agents.value = ag
          }).catch(() => { /* 轮询失败静默 */ })
        }, 5000)
      } else {
        stopTypingPoll()
      }
    }
    watch(turn, syncTypingPoll)
    const workingAgents = () => agents.value.filter((a) => a.status === 'working')

    // ── 人类「正在输入」指示（socket 'space:typing'）────────────────────
    // 与上面「AI 正在工作中」（turn chain + agents 轮询）两套机制独立共存：
    // AI 一行（typingLine）、人类一行（humanTypingLine），渲染上 AI 行在下。
    const humanTyping = ref({ name: '', ts: 0 }) as { value: { name: string; ts: number } }
    let humanTypingTimer: ReturnType<typeof setTimeout> | undefined
    let lastTypingSent = 0 // 本端节流戳（≥2s 才向服务端广播一次）
    /** 收到他人 typing 帧：记录并 3s 无更新自动消失（自己的帧直接忽略）。 */
    function onHumanTyping(sessionId: string, name: string) {
      if (sessionId !== activeId.value) return
      if (!name || name === me.value?.displayName) return
      humanTyping.value = { name, ts: Date.now() }
      clearTimeout(humanTypingTimer)
      humanTypingTimer = setTimeout(() => { humanTyping.value = { name: '', ts: 0 } }, 3000)
    }
    /** 草稿变化时节流上报（≥2s 一次且 draft 非空；清空不上报）。 */
    function maybeSendTyping() {
      const now = Date.now()
      if (!draft.value.trim() || now - lastTypingSent < 2000) return
      lastTypingSent = now
      void rpc.value.typing(getToken(), activeId.value, me.value?.displayName ?? '')
        .catch(() => { /* typing 失败静默 —— 瞬时信号不值得打扰用户 */ })
    }

    async function load() {
      const token = getToken()
      try {
        sessions.value = (await rpc.value.sessions(token)) ?? []
        if (commands.value.length === 0) commands.value = (await rpc.value.commands(token)) ?? []
        if (!activeId.value && sessions.value.length > 0) {
          const initial = sessions.value.find((s) => s.id === route.query.session) ?? sessions.value[0]!
          activeId.value = initial.id
          if (route.query.session !== initial.id) void router.replace({ query: { session: initial.id } })
        }
        if (!activeId.value) return
        const [ev, mb, st, tn, ag, mm, rc, td] = await Promise.all([
          rpc.value.events(token, activeId.value),
          rpc.value.members(token, activeId.value),
          rpc.value.staging(token, activeId.value),
          rpc.value.turn(token, activeId.value),
          rpc.value.agents(token),
          rpc.value.memories(token, activeId.value),
          rpc.value.reactions(token, activeId.value),
          rpc.value.todos(token, activeId.value),
        ])
        if (isUnauth(ev) || isUnauth(mb)) return unauthed()
        if (ev) events.value = ev
        if (mb) members.value = mb
        if (st) staging.value = st
        turn.value = tn
        if (tn?.sessionWork) sessionWork.value = tn.sessionWork
        if (ag) agents.value = ag
        rpc.value.humans(token).then((h) => { if (h) humans.value = h }).catch(() => {})
        if (mm && !isUnauth(mm)) memories.value = mm
        if (td && !isUnauth(td)) todos.value = td
        // 回应汇总：服务端错误结构（{error}）不覆盖本地已有（保留上次数据渲染）。
        if (rc && !('error' in rc)) reactions.value = rc
        if (reply.value.startsWith('加载失败')) reply.value = ''
      } catch (e) {
        replyOk.value = false
        reply.value = `加载失败：${String((e as Error).message ?? e)}`
      }
    }

    // ── 表情回应：点同 emoji 再点一次 = 撤；响应就地更新汇总 ─────────────
    async function toggleReaction(ev: TEvent, emoji: string) {
      if (!activeId.value) return
      const already = (reactions.value[ev.id] ?? []).some(
        (s) => s.emoji === emoji && s.users.includes(me.value?.id ?? ''))
      const rpc_ = already ? rpc.value.unreact : rpc.value.react
      try {
        const res = await rpc_(getToken(), activeId.value, ev.id, emoji)
        if (isUnauth(res)) return unauthed()
        if ('error' in res) { showReply(`回应失败（${res.error}）`, false); return }
        // 就地替换该事件的汇总（无回应后数组为空 → 删键，避免残留渲染）。
        if (res.length) reactions.value = { ...reactions.value, [ev.id]: res }
        else {
          const { [ev.id]: _drop, ...rest } = reactions.value
          reactions.value = rest
        }
      } catch (e) {
        showReply(`回应失败：${String((e as Error).message ?? e)}`, false)
      }
    }

    // ── 实时推送（IM 化）：socket 上的 'space:event' 增量合并 ─────────────
    function onSocketMessage(ev: MessageEvent) {
      try {
        const msg = JSON.parse(String(ev.data))
        // 人类「正在输入」帧（typing RPC 广播）：瞬时信号，不进时间线。
        if (msg?.type === 'space:typing') {
          onHumanTyping(String(msg.body?.sessionId ?? ''), String(msg.body?.name ?? ''))
          return
        }
        if (msg?.type === 'space:session-work') {
          if (msg.body && typeof msg.body === 'object') sessionWork.value = msg.body as SessionWorkLite
          return
        }
        if (msg?.type === 'space:agent-progress') {
          const update = msg.body as Omit<AgentProgressLite, 'steps'> | undefined
          if (!update || !update.sessionId || !update.runId || !update.agentId) return
          const label = update.phase === 'started' ? '开始处理任务'
            : update.phase === 'preparing' ? '准备专属工作区'
              : update.phase === 'processing' ? '处理任务与上下文'
                : update.phase === 'tool-start' ? `调用工具：${update.toolId ?? '未知工具'}`
                  : update.phase === 'tool-finish' ? `${update.toolId ?? '工具'}${update.ok ? '完成' : '失败'}`
                    : update.phase === 'text-delta' ? '正在生成回复'
                    : update.phase === 'finalizing' ? '整理最终答复'
                      : update.phase === 'completed' ? '已完成'
                        : update.phase === 'cancelled' ? '已取消' : '执行失败'
          const previous = progressRuns.value.find((run) => run.runId === update.runId)
          const steps = previous?.steps ?? []
          const delta = update.phase === 'text-delta' && typeof update.delta === 'string' ? update.delta : ''
          const preview = delta
            ? appendProgressDelta({
              text: previous?.streamText ?? '',
              totalCharacters: previous?.streamCharacterCount ?? 0,
              truncated: previous?.streamTruncated ?? false,
            }, delta)
            : {
              text: previous?.streamText ?? '',
              totalCharacters: previous?.streamCharacterCount ?? 0,
              truncated: previous?.streamTruncated ?? false,
            }
          if (steps.at(-1)?.label !== label) steps.push({ label, at: update.at })
          progressRuns.value = [
            ...progressRuns.value.filter((run) => run.runId !== update.runId),
            {
              ...previous, ...update, steps: steps.slice(-30),
              streamText: preview.text,
              streamCharacterCount: preview.totalCharacters,
              streamTruncated: preview.truncated,
            },
          ].slice(-40)
          return
        }
        if (msg?.type !== 'space:event') return
        const sessionId = String(msg.body?.sessionId ?? '')
        const eventId = String(msg.body?.eventId ?? '')
        // Push frames carry only a pointer; the authenticated session RPC checks
        // membership again before event content reaches this browser.
        if (!eventId || sessionId !== activeId.value) return
        void rpc.value.event(getToken(), sessionId, eventId).then((event) => {
          if (!event || sessionId !== activeId.value) return
          mergeEvent(event)
          notifyIfHidden(event)
        })
      } catch {
        // 非法帧忽略（socket 上还有 rpc:response 等其它类型）。
      }
    }
    /** 按 id 去重、seq 升序合并一条事件（socket 推送与乐观回执共用）。 */
    function mergeEvent(event: TEvent) {
      if (events.value.some((e) => e.id === event.id)) return
      events.value = [...events.value, event].sort((a, b) => a.seq - b.seq)
      // 当前打开的会话 = 已读：同步本地已读时刻，会话栏红点即灭（跨 entry 共享 localStorage）。
      // ⚠ 只对本页正打开的会话写已读 —— 原实现对任意 session 的推送都写，
      // 会把其它会话的未读一键清零（2026-10-06 B1 实测踩坑）。
      if (event.sessionId && event.sessionId === activeId.value) {
        localStorage.setItem(`space_seen_${event.sessionId}`, String(Date.now()))
      }
    }
    function onSocketOpen() {
      // 断线重连后全量刷新一次（推送缺口补偿）。
      void load()
    }

    // 会话栏改选 = 改 URL；本页只认 URL，唯一的选中真相源。
    watch(() => route.query.session, (v) => {
      if (v && v !== activeId.value) {
        activeId.value = v
        if (isMobileViewport.value) railOpen.value = false
        events.value = []
        reactions.value = {} // 切会话清掉回应汇总（随 load 重拉）
        reactPickerId.value = ''
        replyTo.value = null // 切会话清掉引用条（引用属于旧会话的消息）
        humanTyping.value = { name: '', ts: 0 } // 切会话清掉「正在输入」指示
        clearTimeout(humanTypingTimer)
        clearSearch()
        restoreDraft()
        pendingUnreadScroll = true // 进新会话：首次加载完成后做未读定位
        void load()
      }
    })

    function onDraft(v: string) {
      draft.value = v
      menu.value = deriveMenu(v)
      activeIdx.value = -1
      maybeSendTyping() // 人类「正在输入」：节流后广播（≥2s 一次）
    }

    // ── 键盘状态机（既有契约原样保留）────────────────────────────────────
    function menuCount(): number {
      const m = menu.value
      if (!m) return 0
      return m.kind === 'slash' ? slashItems(m.query).length : mentionItems(m.query).length
    }
    function pickActive(): void {
      const m = menu.value
      if (!m) return
      if (m.kind === 'slash') {
        const items = slashItems(m.query)
        const c = items[activeIdx.value] ?? items[0]
        if (c) pickCommand(c.name)
      } else {
        const items = mentionItems(m.query)
        const mm = items[activeIdx.value] ?? items[0]
        if (mm) insertMention(mm.principalId)
      }
    }
    function insertNewline(): void {
      const ta = inputEl.value
      const text = draft.value
      const start = ta?.selectionStart ?? text.length
      const end = ta?.selectionEnd ?? text.length
      const next = text.slice(0, start) + '\n' + text.slice(end)
      onDraft(next)
      if (ta) {
        ta.value = next
        ta.selectionStart = ta.selectionEnd = start + 1
      }
    }
    function onKeydown(e: KeyboardEvent): void {
      if (e.key === 'Enter' && e.shiftKey) { e.preventDefault(); insertNewline(); return }
      const n = menuCount()
      if (n > 0) {
        if (e.key === 'ArrowDown') { activeIdx.value = activeIdx.value < 0 ? 0 : (activeIdx.value + 1) % n; e.preventDefault(); return }
        if (e.key === 'ArrowUp') { activeIdx.value = activeIdx.value < 0 ? n - 1 : (activeIdx.value - 1 + n) % n; e.preventDefault(); return }
        if (e.key === 'Enter' || e.key === 'Tab') { pickActive(); e.preventDefault(); return }
        if (e.key === 'Escape') { menu.value = null; e.preventDefault(); return }
        return
      }
      if (e.key === 'Enter' && !sending.value) { void sendText(draft.value); e.preventDefault() }
    }
    function onBlur(): void {
      setTimeout(() => { menu.value = null }, 200)
    }

    function pickCommand(name: string) {
      draft.value = draft.value.replace(slashRe, `/${name} `)
      menu.value = null
    }
    function insertMention(id: string) {
      // '@所有人' 是合成候选：哨兵 id 不进草稿，插的是可读的 '@所有人 '。
      draft.value = draft.value.replace(mentionRe, id === '__all__' ? '@所有人 ' : `@${id} `)
      menu.value = null
    }

    async function inviteSelectedAgent() {
      if (!activeId.value || !inviteAgentId.value || invitingAgent.value) return
      invitingAgent.value = true
      try {
        const result = await rpc.value.inviteAgent(getToken(), activeId.value, inviteAgentId.value)
        if (!result) { window.location.assign('/login'); return }
        if ('error' in result) { showReply(`邀请失败：${result.detail || result.error}`, false); return }
        showReply(result.detail, true)
        inviteAgentId.value = ''
        await load()
      } catch (error) {
        showReply(`邀请失败：${String((error as Error).message ?? error)}`, false)
      } finally {
        invitingAgent.value = false
      }
    }

    /** 成功回执 3s 自动消隐（错误常显，可手动关）。 */
    function showReply(text: string, ok: boolean) {
      reply.value = text
      replyOk.value = ok
      clearTimeout(replyTimer)
      if (ok) {
        replyTimer = setTimeout(() => { reply.value = '' }, 3000)
      }
    }

    // ── 文件消息：选文件 → POST /api/upload → 成功后组装文本走 sendText ──
    // 上传中 fileUploading：composer「文件」按钮禁用 + 文案「上传中…」。
    const fileUploading = ref(false)
    /** 点「文件」：动态建 input[type=file] 触发系统选择框（浏览器 API，非样式）。 */
    function pickFile() {
      const input = document.createElement('input')
      input.type = 'file'
      input.onchange = () => {
        const file = input.files?.[0]
        if (file) void uploadFile(file)
      }
      input.click()
    }
    async function uploadFile(file: File) {
      if (fileUploading.value || closed.value) return
      if (!activeId.value) { showReply('请先选择一个会话，再上传附件', false); return }
      fileUploading.value = true
      try {
        const res = await fetch(`${getApiBase()}/api/upload?sessionId=${encodeURIComponent(activeId.value)}&name=${encodeURIComponent(file.name)}`, {
          method: 'POST', body: file, credentials: 'same-origin',
          headers: { authorization: `Bearer ${getToken()}` },
        })
        if (res.status === 401) { unauthed(); return }
        if (res.status === 413) { showReply('文件过大（上限 20MB）', false); return }
        if (!res.ok) { showReply(`上传失败（HTTP ${res.status}）`, false); return }
        const data = await res.json() as { url: string; name: string; size: number }
        const kb = Math.max(1, Math.round(data.size / 1024))
        // 复用消息全链路（乐观上屏 / socket 推送）：url 藏在文本里。
        await sendText(`[文件] ${data.name} (${kb} KB)\n${data.url}`)
      } catch (e) {
        showReply(`上传失败：${String((e as Error).message ?? e)}`, false)
      } finally {
        fileUploading.value = false
      }
    }

    async function importAttachment(file: { title: string; url: string }) {
      if (!activeId.value || closed.value) return
      const url = new URL(file.url, getApiBase())
      const name = url.pathname.split('/').at(-1)
      if (!name) return
      try {
        const res = await fetch(`${getApiBase()}/api/uploads/${encodeURIComponent(name)}/import?sessionId=${encodeURIComponent(activeId.value)}`, {
          method: 'POST', credentials: 'same-origin',
          headers: { authorization: `Bearer ${getToken()}` },
        })
        if (res.status === 401) { unauthed(); return }
        const result = await res.json().catch(() => null as { error?: string; detail?: string; title?: string } | null)
        if (!res.ok) { showReply(result?.detail ?? `导入失败（${result?.error ?? res.status}）`, false); return }
        showReply('附件已导入团队知识库，团队成员和 Agent 均可检索', true)
      } catch (error) {
        showReply(`导入失败：${String((error as Error).message ?? error)}`, false)
      }
    }

    async function sendText(text: string) {
      if (!activeId.value) { showReply('请先选择或新建一个会议', false); return }
      // IM 化：空输入静默忽略（不再弹错误回执）。
      if (!text.trim()) return
      if (sending.value || closed.value) return
      sending.value = true
      // 引用系统化（2026-10-02）：引用关系走 replyTo 结构化字段，消息正文不再拼前缀。
      const fullText = text
      const localId = `__local_${++replySeq}`
      // 乐观插入：本地临时事件先上屏（人类消息右对齐），服务端确认后按 id 对齐。
      const optimistic: EventLite = {
        id: localId,
        seq: Number.MAX_SAFE_INTEGER,
        ts: new Date().toISOString(),
        authorId: me.value?.id ?? '',
        authorKind: 'human',
        kind: 'message',
        text: fullText,
      } as EventLite
      events.value = [...events.value, optimistic]
      try {
        const result: SendResult = await rpc.value.send(getToken(), activeId.value, fullText, parseMentions(), replyTo.value?.id ?? null)
        if (isUnauth(result)) { unauthed(); return }
        if ('error' in result) {
          // 回滚乐观插入，显示错误。
          events.value = events.value.filter((e) => e.id !== localId)
          showReply(`出错了（${result.error}）：${result.detail}`, false)
          return
        }
        // 确认成功：去掉临时事件；真事件由响应或 socket 推送补上（两者按 id 去重）。
        events.value = events.value.filter((e) => e.id !== localId)
        if (result.event) mergeEvent(result.event)
        draft.value = ''
        replyTo.value = null
        replyTo.value = null // 引用已随消息发出，清掉引用条
        localStorage.removeItem(`space_draft_${activeId.value}`)
        menu.value = null
        if (result.reply) showReply(result.reply, true)
        void load()
      } catch (e) {
        events.value = events.value.filter((e) => e.id !== localId)
        showReply(`发送失败：${String((e as Error).message ?? e)}`, false)
      } finally {
        sending.value = false
      }
    }

    function chooseQuickReply(text: string) {
      const target = events.value.slice().reverse().find((event) =>
        event.kind === 'message' && !event.voided)
      if (!target || target.authorKind !== 'agent' || closed.value) return
      replyTo.value = {
        author: authorLabel(target.authorId, members.value),
        summary: target.text.slice(0, 50),
        seq: target.seq,
        id: target.id,
      }
      onDraft(text)
      void nextTick(() => inputEl.value?.focus())
    }

    // 滚动跟随（修复 UX 评审第 1 条）：贴底才自动跟随；偏离给「回到最新」。
    function onScroll() {
      const wrap = document.querySelector('.content-body .el-scrollbar__wrap') as HTMLElement | null
      if (!wrap) return
      const gap = wrap.scrollHeight - wrap.scrollTop - wrap.clientHeight
      nearBottom.value = gap < 80
      if (!nearBottom.value) {
        const wrapTop = wrap.getBoundingClientRect().top
        const row = [...wrap.querySelectorAll<HTMLElement>('[data-ev-id]')]
          .find((item) => item.getBoundingClientRect().bottom > wrapTop)
        if (row?.dataset.evId) {
          scrollAnchor = { id: row.dataset.evId, offset: row.getBoundingClientRect().top - wrapTop }
        }
      }
    }
    function scrollToBottom() {
      void scrollbar.value?.setScrollTop(999999)
      nearBottom.value = true
    }

    // ── 未读定位（IM 化）：进会话首次加载完成后，滚到最后已读时刻之后 ────
    // 的第一条非本人消息附近；没有未读才滚到底。已读时刻的写入时机不变。
    let pendingUnreadScroll = false // 进会话前置位，events 首次变化时消费一次
    function scrollToUnread() {
      const seen = Number(localStorage.getItem(`space_seen_${activeId.value}`) ?? '0')
      // 未读起点 = 已读时刻之后的第一条「非本人、未撤回」消息。
      const idx = events.value.findIndex((e) =>
        e.kind === 'message' && e.authorId !== me.value?.id && !e.voided &&
        (Date.parse(e.ts) || 0) > seen)
      if (idx < 0) { scrollToBottom(); return }
      const wrap = document.querySelector('.content-body .el-scrollbar__wrap') as HTMLElement | null
      if (!wrap) { scrollToBottom(); return }
      const targetEvent = events.value[idx]!
      const targetRow = [...wrap.querySelectorAll<HTMLElement>('[data-ev-id]')]
        .find((row) => row.dataset.evId === targetEvent.id)
      if (!targetRow) { scrollToBottom(); return }
      // Use the rendered row's real position. Message heights vary with text,
      // citations and attachments, so index/total can land in the wrong place.
      const wrapTop = wrap.getBoundingClientRect().top
      const rowTop = targetRow.getBoundingClientRect().top
      const maxScroll = Math.max(0, wrap.scrollHeight - wrap.clientHeight)
      const target = Math.min(maxScroll, Math.max(0,
        wrap.scrollTop + rowTop - wrapTop - wrap.clientHeight / 3))
      void scrollbar.value?.setScrollTop(target)
      const gap = wrap.scrollHeight - target - wrap.clientHeight
      nearBottom.value = gap < 80
    }
    watch(() => events.value.length, async () => {
      await nextTick()
      // 首次加载的未读定位优先于「贴底跟随」；之后照常贴底跟随。
      if (pendingUnreadScroll) {
        pendingUnreadScroll = false
        scrollToUnread()
        return
      }
      if (nearBottom.value) scrollToBottom()
    })
    watch(activeId, () => { activityLimit.value = 100 })

    // ── 可见即已读兜底：页面从后台回到可见时，把当前会话写一次已读时刻 ──
    // 防止「看过但红点还在」的边缘态（切走瞬间推来的消息未落 seen）。
    function onVisibilityChange() {
      if (!document.hidden && activeId.value) {
        localStorage.setItem(`space_seen_${activeId.value}`, String(Date.now()))
      }
    }

    function onViewportChange(event: MediaQueryListEvent) {
      isMobileViewport.value = event.matches
      // 两侧面板在手机上是抽屉；进入窄屏时先收起，离开窄屏恢复桌面双栏。
      railOpen.value = !event.matches
      panelOpen.value = !event.matches
    }

    function onWindowResize() {
      const stickToBottom = nearBottom.value
      const anchor = scrollAnchor
      cancelAnimationFrame(resizeFrame)
      // 等浏览器完成新宽度下的换行与布局，再按消息行恢复阅读位置。
      resizeFrame = requestAnimationFrame(() => {
        resizeFrame = requestAnimationFrame(() => {
          if (stickToBottom) { scrollToBottom(); return }
          if (!anchor) return
          const wrap = document.querySelector('.content-body .el-scrollbar__wrap') as HTMLElement | null
          const row = [...(wrap?.querySelectorAll<HTMLElement>('[data-ev-id]') ?? [])]
            .find((item) => item.dataset.evId === anchor.id)
          if (!wrap || !row) return
          const wrapTop = wrap.getBoundingClientRect().top
          const offset = row.getBoundingClientRect().top - wrapTop
          wrap.scrollTop += offset - anchor.offset
        })
      })
    }

    onMounted(async () => {
      document.addEventListener('visibilitychange', onVisibilityChange)
      mobileViewport.addEventListener('change', onViewportChange)
      window.addEventListener('resize', onWindowResize)
      document.querySelector('.content-body .el-scrollbar__wrap')
        ?.addEventListener('scroll', onScroll, { passive: true })
      const meRes = await rpc.value.me(getToken())
      if (!meRes || isUnauth(meRes)) { unauthed(); return }
      me.value = meRes
      pendingUnreadScroll = true // 首次进入：加载完成后做未读定位（无未读则滚到底）
      await load()
      restoreDraft()
      syncTypingPoll()
      // 页签不可见时申请一次桌面通知权限（用户拒绝/失败均静默）。
      if (document.hidden && typeof Notification !== 'undefined') {
        try { void Notification.requestPermission().catch(() => {}) } catch { /* 静默 */ }
      }
      // 后端 HTTP 基址（撤回/上传用）：优先使用 HTTPS 反代公网 origin。
      try {
        const config = await rpc.value.apiConfig(getToken())
        if (config?.publicBaseUrl) apiBase = config.publicBaseUrl
        else if (config?.port) apiBase = `${location.protocol}//${location.hostname}:${config.port}`
      } catch { /* 保持 :8080 兜底 */ }
      // client.socket 是 Vue ref（可能为 null）—— 取 .value 并守卫。
      const clientWithSocket = appCtx.client as typeof appCtx.client & { socket?: { value?: WebSocket } }
      const rawSocket = clientWithSocket.socket?.value
      socket = rawSocket && typeof rawSocket.addEventListener === 'function' ? rawSocket : undefined
      if (!socket) console.warn('[space] client.socket 不可监听（外壳版本差异），实时推送降级为手动刷新')
      socket?.addEventListener('message', onSocketMessage)
      socket?.addEventListener('open', onSocketOpen)
    })
    onUnmounted(() => {
      document.removeEventListener('visibilitychange', onVisibilityChange)
      mobileViewport.removeEventListener('change', onViewportChange)
      window.removeEventListener('resize', onWindowResize)
      document.querySelector('.content-body .el-scrollbar__wrap')
        ?.removeEventListener('scroll', onScroll)
      cancelAnimationFrame(resizeFrame)
      socket?.removeEventListener('message', onSocketMessage)
      socket?.removeEventListener('open', onSocketOpen)
      clearTimeout(replyTimer)
      clearTimeout(humanTypingTimer)
      stopTypingPoll()
    })

    return () => {
      const ElButton = resolveComponent('el-button') as unknown as string
      const ElCard = resolveComponent('el-card') as unknown as string
      const ElRow = resolveComponent('el-row') as unknown as string
      const ElInput = resolveComponent('el-input') as unknown as string
      const ElSelect = resolveComponent('el-select') as unknown as string
      const ElOption = resolveComponent('el-option') as unknown as string
      const ElTag = resolveComponent('el-tag') as unknown as string
      const ElEmpty = resolveComponent('el-empty') as unknown as string
      const ElScrollbar = resolveComponent('el-scrollbar') as unknown as string
      const ElDropdown = resolveComponent('el-dropdown') as unknown as string
      const ElDropdownItem = resolveComponent('el-dropdown-item') as unknown as string
      const ElPopover = resolveComponent('el-popover') as unknown as string
      const DropdownItem = resolveComponent('el-dropdown-item') as unknown as string
      const Dropdown = resolveComponent('el-dropdown') as unknown as string
      const KCard = resolveComponent('k-card') as unknown as string
      const ElDivider = resolveComponent('el-divider') as unknown as string
      const ElText = resolveComponent('el-text') as unknown as string
      const ElSpace = resolveComponent('el-space') as unknown as string
      const ElProgress = resolveComponent('el-progress') as unknown as string
      const ElTimeline = resolveComponent('el-timeline') as unknown as string
      const ElAvatar = resolveComponent('el-avatar') as unknown as string
      const ElTimelineItem = resolveComponent('el-timeline-item') as unknown as string
      const ElDescriptions = resolveComponent('el-descriptions') as unknown as string
      const ElDescriptionsItem = resolveComponent('el-descriptions-item') as unknown as string
      const progressPreview = (run: AgentProgressLite, key: string) => run.streamText
        ? h(ElText, { key }, {
          default: () => `${progressPreviewLabel(run.phase, {
            text: run.streamText!,
            totalCharacters: run.streamCharacterCount ?? Array.from(run.streamText!).length,
            truncated: run.streamTruncated ?? false,
          })}\n${run.streamText}`,
        })
        : null
      const KLayout = resolveComponent('k-layout') as unknown as string
      const KIcon = resolveComponent('k-icon') as unknown as string
      const KSlot = resolveComponent('k-slot') as unknown as string
      const ElLink = resolveComponent('el-link') as unknown as string
      const ElImage = resolveComponent('el-image') as unknown as string
      const ElSteps = resolveComponent('el-steps') as unknown as string
      const ElStep = resolveComponent('el-step') as unknown as string
      const ElTabs = resolveComponent('el-tabs') as unknown as string
      const ElTabPane = resolveComponent('el-tab-pane') as unknown as string
      const ElCollapse = resolveComponent('el-collapse') as unknown as string
      const ElCollapseItem = resolveComponent('el-collapse-item') as unknown as string

      const work = sessionWork.value
      const busySession = work?.activeSessionId
      const busyTitle = sessions.value.find((session) => session.id === busySession)?.title ?? busySession
      const waitingHere = work?.queue.some((item) => item.sessionId === activeSession.value?.id) ?? false
      const activeStatus = !activeSession.value ? null
        : busySession === activeSession.value.id
          ? { label: '聊天中…', tag: 'warning' }
          : busySession && waitingHere
            ? { label: `排队中 · ${busyTitle} 正在处理`, tag: 'info' }
            : sessionStatus(activeSession.value)
      const topbarLeft = () => [
        hasRail.value
          ? h(ElButton, {
              key: 'rail-toggle', text: true, onClick: () => {
                railOpen.value = !railOpen.value
                if (isMobileViewport.value && railOpen.value) panelOpen.value = false
              },
            }, { default: () => h(KIcon, { name: railOpen.value ? 'chevron-left' : 'chevron-right' }) })
          : null,
        h('span', {
          class: 'layout-header-title sp-session-title', key: 'title',
          title: activeSession.value?.title ?? '未选择会议',
        }, activeSession.value?.title ?? '未选择会议'),
        activeStatus
          ? h(ElTag, { key: 'status', size: 'small', type: activeStatus.tag },
              { default: () => activeStatus.label })
          : null,
      ]
      const topbarRight = () => [
        h(ElButton, {
          key: 'agents-catalog', text: true, size: 'small', class: 'sp-mobile-secondary',
          onClick: () => window.location.assign('/teamspace/agents'),
        }, { default: () => '团队 Agent' }),
        turn.value?.state === 'static'
          ? h(ElTag, { key: 'paused', size: 'small', type: 'warning', class: 'sp-mobile-secondary' }, { default: () => '已暂停' })
          : null,
        h(ElButton, {
          key: 'panel', text: true, type: panelOpen.value ? 'primary' : 'info',
          class: 'sp-collab-toggle', title: '打开或关闭协作面板',
          onClick: () => {
            panelOpen.value = !panelOpen.value
            if (isMobileViewport.value && panelOpen.value) railOpen.value = false
          },
        }, { default: () => isMobileViewport.value ? '面板' : '协作面板' }),
      ]

      // 文本渲染：@提及 → 小号 primary el-tag，其余原样（人类气泡 + 搜索结果共用）。
      // 文件消息（[文件] 开头）：图片扩展名 → el-image；否则 el-link 新窗打开下载。
      const renderText = (text: string): VNodeChild => {
        // 引用深度融合（2026-10-02）：消息头部的「> 引用 #seq 作者：摘要」行
        // 渲染为引用块（竖线 + 灰底小字），其余为正文 —— 发送格式不变
        //（服务端零改动），展示层升级。
        const quoteRe = /^> 引用 #(\d+) (.+?)：([\s\S]*?)\n([\s\S]*)$/
        const qm = quoteRe.exec(text)
        if (qm) {
          // 旧版文本引用的作者字段可能是裸 id —— 能对上成员表就换显示名
          //（2026-10-05：时间线不该给用户看内部 id）。
          const rawAuthor = qm[2]!
          const pretty = members.value.some((m) => m.principalId === rawAuthor)
            ? authorLabel(rawAuthor, members.value)
            : rawAuthor
          return [
            h('div', { class: 'sp-quote', title: qm[3] }, `↳ 回复 #${qm[1]} ${pretty}：${qm[3]}`),
            h('div', null, [renderText(qm[4] ?? '')]),
          ]
        }
        const file = splitFileMessage(text)
        if (file) {
          // 标题形如「[文件] 名 (123 KB)」；链接文本取纯文件名。
          const label = file.title.replace(/^\[文件\]\s*/, '').replace(/\s*\([^)]*\)$/, '') || file.title
          const url = new URL(file.url, getApiBase())
          // Existing timeline items predate session-bound file URLs. Resolve
          // their session from the currently open conversation for compatibility.
          if (!url.searchParams.has('sessionId') && activeId.value) url.searchParams.set('sessionId', activeId.value)
          const isImage = IMAGE_RE.test(url.pathname)
          return [
            h('div', { key: 'file-title' }, file.title),
            isImage
              ? h(ElImage, { key: 'file-image', src: url.href, fit: 'scale-down', lazy: true })
              : h(ElLink, { key: 'file-link', type: 'primary', href: url.href, target: '_blank' },
                  { default: () => label }),
            h(ElButton, {
              key: 'file-import', text: true, type: 'primary', size: 'small',
              title: '点击后文件内容会对全体团队成员和 Agent 可检索',
              onClick: () => void importAttachment(file),
            }, { default: () => '导入团队知识库（全队可见）' }),
          ]
        }
        return splitMentions(text).map((seg, i) => seg.at
          ? h(ElTag, { key: i, size: 'small', type: 'primary' }, { default: () => seg.t })
          : seg.t)
      }

      /** 搜索结果正文渲染：命中 query 的段 → warning 小 tag（只用于搜索列表，
       *  时间线正文仍走 renderText 不高亮）；文件消息维持 renderText 原渲染。 */
      const renderSearchText = (text: string) => {
        if (isFileMessage(text)) return renderText(text)
        return splitHighlight(text, searchQuery.value).map((seg, i) => seg.hit
          ? h(ElTag, { key: `hl-${i}`, size: 'small', type: 'warning' }, { default: () => seg.t })
          : seg.t)
      }

      // ── 消息行（悬停行内揭示「作者 · 时间」）────────────────────────────
      // flowView 非空 = 系统事件里的服务流程行 → 渲染成进度卡片（renderTimeline 传入）。
      /** 结构化引用块：由 replyTo 解析原事件（撤回 → 灰字；缺失 → 兜底），
       *  点击定位原消息并短暂高亮（im.css 的 .sp-flash）。 */
      const quoteBlock = (replyToId: string) => {
        const orig = events.value.find((e) => e.id === replyToId)
        const head = orig
          ? `回复 #${orig.seq} ${authorLabel(orig.authorId, members.value)}`
          : '回复原消息'
        const body = !orig
          ? '原消息不在当前视图'
          : orig.voided ? '原消息已撤回' : orig.text.slice(0, 80)
        return h('div', {
          class: 'sp-quote',
          title: body,
          onClick: () => {
            const el = document.querySelector(`[data-ev-id="${replyToId}"]`)
            el?.scrollIntoView({ behavior: 'smooth', block: 'center' })
            el?.classList.add('sp-flash')
            setTimeout(() => el?.classList.remove('sp-flash'), 1400)
          },
        }, `↳ ${head}：${body}`)
      }

      const messageRow = (ev: TEvent, flowView?: FlowEventView | null, causalCounts: ReadonlyMap<string, number> = new Map()) => {
        const isFlow = ev.authorKind === 'system' && !ev.voided && !!flowView
        // 服务流程进度卡片：el-card 内 el-text 说明行 + el-steps（active = 已完成步数）。
        const flowCard = flowView
          ? h('div', { key: `flow-${ev.id}`, class: 'sp-flow' }, [
                h(ElText, { key: 'flow-head', size: 'small', type: 'info' }, {
                  default: () => `服务流程 [${flowView.flowName}]` +
                    (flowView.kind === 'done' ? '：已完成 ✓' : flowView.task ? `：${flowView.task}` : ''),
                }),
                h(ElSteps, { key: 'flow-steps', active: flowView.current, alignCenter: true }, {
                  default: () => flowView.steps.map((s, i) => h(ElStep, { key: i, title: s })),
                }),
              ])
          : null
        // 聊天骨架（2026-10-02 视觉重做）：头像 + 气泡 + 元信息，替代圆点轴。
        const self = ev.authorKind === 'human' && ev.authorId === me.value?.id
        // 撤回入口：仅自己的（authorKind='human'）未撤回消息悬停时出现，在「引用」旁。
        const canRecall = !ev.voided && ev.kind === 'message' &&
          ev.authorKind === 'human' && ev.authorId === me.value?.id
        const canDecide = ev.kind === 'message' && ev.authorKind === 'agent' &&
          members.value.some((member) => member.principalId === me.value?.id && member.role === 'DRI')
        const downstreamCount = canDecide ? (causalCounts.get(ev.id) ?? 0) : 0
        const decisionActions = canDecide && ev.voided ? [
          { action: 'redo', label: '重新执行此历史影响项' },
          { action: 'modify', label: '修改要求并重新执行' },
        ] : canDecide ? [
          { action: 'pass', label: '通过（先复核）' },
          { action: 'reject', label: `否决（下游 ${downstreamCount} 条）` },
          { action: 'modify', label: `修改（下游 ${downstreamCount} 条）` },
          { action: 'defer', label: '暂缓并发起复核' },
          { action: 'recall', label: `撤回（下游 ${downstreamCount} 条）` },
          { action: 'redo', label: `要求重做（下游 ${downstreamCount} 条）` },
        ] : []
        // 回应汇总标签：count>0 才渲染；users 含我 → primary 高亮。
        const myId = me.value?.id ?? ''
        const summaryTags = (reactions.value[ev.id] ?? []).map((s) => h(ElTag, {
          key: `react-${ev.id}-${s.emoji}`, size: 'small',
          type: s.users.includes(myId) ? 'primary' : 'info',
          // 点汇总标签 = 快速切换自己的这个回应（与面板语义一致）。
          style: { cursor: 'pointer' },
          onClick: () => void toggleReaction(ev, s.emoji),
        }, { default: () => `${s.emoji} ${s.count}` }))
        // 回应面板：固定 5 emoji 的行内按钮组（不用 popover，避免传送门不确定性）。
        const reactionPanel = reactPickerId.value === ev.id && !ev.voided
          ? h(ElSpace, { size: 4 }, {
              default: () => REACTION_EMOJIS.map((em) => {
                const mine = (reactions.value[ev.id] ?? []).some(
                  (s) => s.emoji === em && s.users.includes(myId))
                return h(ElButton, {
                  key: `pick-${ev.id}-${em}`, text: true, size: 'small',
                  ...(mine ? { type: 'primary' as const } : {}),
                  onClick: () => void toggleReaction(ev, em),
                }, { default: () => em })
              }),
            })
          : null
        if (ev.authorKind === 'system' && !isFlow) {
          return h('div', { class: 'sp-sys', key: ev.id },
            h(ElText, { size: 'small', type: 'info' }, { default: () => ev.text }))
        }
        const membersView = [...members.value,
      ...humans.value.map((u) => ({ principalId: u.id, role: u.displayName, duty: u.displayName })),
      ...agents.value.map((a) => ({ principalId: a.id, role: a.title, duty: a.title }))]
    // 聊天名字只显示显示名（id 收进悬停 title，不占版面）。
    const m0 = membersView.find((x) => x.principalId === ev.authorId)
    const name = m0 ? (m0.duty?.trim() ? m0.duty : m0.role) : (ev.authorId ?? '系统')
        const bubble: VNodeChild = ev.voided
          ? h(ElText, { size: 'small', type: 'info' }, { default: () => '消息已撤回' })
          : isFlow
            ? flowCard
            : ev.authorKind === 'human'
              ? renderText(ev.text)
              : renderMarkdown(ev.text, h, { ElText })
        const metaRow = !ev.voided || canDecide
          ? h('div', { class: 'sp-msg-meta' }, [
              h('span', formatTime(ev.ts)),
                    ev.kind === 'message' && (!ev.voided || canDecide)
                ? h(ElDropdown, { trigger: 'click', onCommand: (cmd: string) => {
                    if (cmd === 'quote') {
                      replyTo.value = {
                        author: name,
                        summary: ev.text.slice(0, 50),
                        seq: ev.seq,
                        id: ev.id,
                      }
                      inputEl.value?.focus()
                      return
                    }
                    if (cmd === 'react') {
                      reactPickerId.value = reactPickerId.value === ev.id ? '' : ev.id
                      return
                    }
                    if (cmd === 'recall') return void recallEvent(ev)
                  if (cmd.startsWith('decision:')) {
                    const action = cmd.slice('decision:'.length)
                    const needsReason = action !== 'pass'
                    draft.value = `/decision ${action} ${ev.id}${needsReason ? ' 请填写原因或新要求' : ''}`
                    inputEl.value?.focus()
                    return
                  }
                  } }, {
                    default: () => h(ElButton, { text: true, size: 'small' }, { default: () => '⋯' }),
                    dropdown: () => [
                      !ev.voided ? h(ElDropdownItem, { command: 'quote' }, { default: () => '引用' }) : null,
                      !ev.voided ? h(ElDropdownItem, { command: 'react' }, { default: () => '回应' }) : null,
                      canRecall
                        ? h(ElDropdownItem, { command: 'recall', divided: true }, { default: () => '撤回' })
                        : null,
                      ...decisionActions.map(({ action, label }) => h(ElDropdownItem, {
                        key: `decision-${ev.id}-${action}`,
                        command: `decision:${action}`,
                        divided: action === 'pass',
                      }, { default: () => label })),
                    ],
                  })
                : null,
            ])
          : null
        const reactionsRow = summaryTags.length
          ? h('div', { class: 'sp-reactions' }, summaryTags)
          : null
        const sourceIds = new Set([ev.sourceEventId, ...(ev.sourceEventIds ?? [])].filter(Boolean))
        const matchingRuns = ev.authorKind === 'agent'
          ? progressRuns.value.filter((run) => run.sessionId === ev.sessionId && run.agentId === ev.authorId &&
              Boolean(run.sourceEventId && sourceIds.has(run.sourceEventId)))
          : []
        const progressCards = matchingRuns.map((run) => h(ElCollapse, { key: `run-${run.runId}` }, {
          default: () => h(ElCollapseItem, { name: run.runId }, {
            title: () => `工作记录 · ${run.steps.length} 步`,
            default: () => h(ElSpace, { direction: 'vertical', fill: true, size: 4 }, {
              default: () => [
                ...run.steps.map((step, index) => h(ElText, {
                  key: `${run.runId}-${index}`, size: 'small', type: 'info',
                }, { default: () => `${formatTime(step.at)} · ${step.label}` })),
                progressPreview(run, `${run.runId}-stream`),
              ],
            }),
          }),
        }))
        return h('div', { key: ev.id, 'data-ev-id': ev.id, class: `sp-msg${self ? ' self' : ''}` }, [
          h(ElAvatar, { size: 32 }, { default: () => name.charAt(0) }),
          h('div', { class: 'sp-msg-body' }, [
            h('div', { class: 'sp-msg-name' }, name),
            ev.replyTo ? quoteBlock(ev.replyTo) : null,
            h('div', {
              class: `sp-bubble${ev.authorKind === 'agent' && !ev.voided && !isFlow ? ' agent' : ''}`,
            }, [bubble]),
            ...progressCards,
            metaRow,
            reactionsRow,
            reactionPanel,
          ]),
        ])
      }

      // ── 时间分隔线（groupByDay 渲染辅助）：相邻消息日期变化处插 el-divider ──
      const renderTimeline = () => {
        const nodes: VNodeChild[] = []
        const causalCounts = downstreamAgentCounts(events.value)
        let lastDay = ''
        // 服务流程上下文（零状态）：顺序遍历时维护最近一条「启动/完成」行的
        // 流程名与 steps，推进行没有 steps 就地取用；重放事件流天然恢复上下文。
        let lastFlowName = ''
        let lastFlowSteps: string[] = []
        for (const ev of events.value) {
          const day = (ev.ts ?? '').slice(0, 10)
          if (day && day !== lastDay) {
            lastDay = day
            nodes.push(h(ElDivider, { key: `day-${day}`, contentPosition: 'center' },
              { default: () => dayLabel(ev.ts) }))
          }
          // 服务流程系统事件：先按当前上下文解析，再回写上下文（启动/完成行自带 steps）。
          const fv = ev.authorKind === 'system' && !ev.voided
            ? parseFlowEvent(ev.text, { flowName: lastFlowName, steps: lastFlowSteps })
            : null
          if (fv && (fv.kind === 'start' || fv.kind === 'done')) {
            lastFlowName = fv.flowName
            lastFlowSteps = fv.steps
          }
          nodes.push(messageRow(ev, fv, causalCounts))
        }
        return nodes
      }

      // ── 搜索行（时间线区域顶部）：回车即搜，「清除」恢复全量 ─────────────
      const searchBar = h(ElRow, { justify: 'center', class: 'sp-chat-search' }, {
        default: () => h(ElSpace, {}, {
          default: () => [
            h(ElInput, {
              class: 'sp-search-input',
              modelValue: searchQuery.value,
              'onUpdate:modelValue': (v: string) => { searchQuery.value = v },
              onKeydown: (e: KeyboardEvent) => { if (e.key === 'Enter') void doSearch() },
              clearable: true,
              placeholder: '搜索本会话消息…',
            }),
            h(ElButton, { type: 'primary', size: 'small', onClick: () => void doSearch() },
              { default: () => '搜索' }),
            h(ElButton, { size: 'small', onClick: clearSearch }, { default: () => '清除' }),
            // 导出 Markdown：当前时间线 events 落成 .md 文件下载（纯前端）。
            h(ElButton, { class: 'sp-search-secondary', text: true, size: 'small', disabled: events.value.length === 0, onClick: exportMarkdown },
              { default: () => '导出' }),
            h(ElButton, {
              class: 'sp-search-secondary', text: true, size: 'small', disabled: events.value.length === 0,
              title: '按回合折叠生成会议纪要（Word 可打开）',
              onClick: exportMinutes,
            }, { default: () => '纪要' }),
          ],
        }),
      })

      // ── 搜索命中列表（只读，替代时间线渲染）────────────────────────────
      const searchArea = () => h('div', { class: CENTERED }, [
        h(ElRow, { justify: 'space-between' }, {
          default: () => [
            h(ElText, { key: 'cnt', size: 'small', type: 'info' },
              { default: () => `搜索结果（${searchResults.value?.length ?? 0} 条）` }),
            h(ElButton, { key: 'close', text: true, size: 'small', onClick: clearSearch },
              { default: () => '关闭' }),
          ],
        }),
        (searchResults.value ?? []).map((ev) => h(ElCard, { key: ev.id, shadow: 'never' }, {
          default: () => [
            h(ElText, { size: 'small', type: 'info' },
              { default: () => `${authorLabel(ev.authorId, members.value)} · ${formatTime(ev.ts)}` }),
            h('div', null, [renderSearchText(ev.text)]),
          ],
        })),
      ])
      // ── 空会话引导 chips：@名 取成员表里真实存在的第一个对应角色 ─────────
      const emptyChips = () => CHIP_ROLES
        .map(([role, prompt]) => {
          const m = members.value.find((mm) => mm.role === role)
          return m ? `@${m.principalId} ${prompt}` : ''
        })
        .filter((t) => t !== '')

      // ── 「AI 正在输入」指示行（时间线底部）──────────────────────────────
      const typingLine = turn.value?.state === 'chain' && workingAgents().length
        ? h(ElRow, { justify: 'center' }, {
            default: () => h(ElSpace, {}, {
              default: () => [
                h(ElText, { size: 'small', type: 'info' },
                  { default: () => `${workingAgents()[0]!.title} 正在工作中` }),
                h(ElText, { size: 'small', type: 'info' }, { default: () => '…' }),
              ],
            }),
          })
        : null
      const liveProgressRows = progressRuns.value
        .filter((run) => run.sessionId === activeId.value &&
          !events.value.some((ev) => ev.authorKind === 'agent' && ev.authorId === run.agentId &&
            new Set([ev.sourceEventId, ...(ev.sourceEventIds ?? [])].filter(Boolean)).has(run.sourceEventId)))
        .map((run) => h('div', { key: `live-run-${run.runId}`, class: 'sp-msg' }, [
          h(ElAvatar, { size: 32 }, { default: () => run.title.charAt(0) }),
          h('div', { class: 'sp-msg-body' }, [
            h('div', { class: 'sp-msg-name' }, `${run.title} · ${run.phase === 'completed' ? '已完成' : run.phase === 'failed' ? '执行失败' : run.phase === 'cancelled' ? '已取消' : '正在工作'}`),
            h(ElCollapse, {}, {
              default: () => h(ElCollapseItem, { name: run.runId }, {
                title: () => `工作记录 · ${run.steps.length} 步`,
                default: () => h(ElSpace, { direction: 'vertical', fill: true, size: 4 }, {
                  default: () => [
                    ...run.steps.map((step, index) => h(ElText, {
                      key: `${run.runId}-live-${index}`, size: 'small', type: 'info',
                    }, { default: () => `${formatTime(step.at)} · ${step.label}` })),
                    progressPreview(run, `${run.runId}-live-stream`),
                  ],
                }),
              }),
            }),
          ]),
        ]))
      // 人类「正在输入」行（AI 行之上）：3s 内有 typing 帧才显示。
      const humanTypingLine = humanTyping.value.name
        ? h(ElRow, { justify: 'center', key: 'human-typing' }, {
            default: () => h(ElText, { size: 'small', type: 'info' },
              { default: () => `${humanTyping.value.name} 正在输入…` }),
          })
        : null

      const messageArea = h('div', { class: CENTERED }, [
        searchResults.value !== null
          ? searchArea()
          : !activeId.value
            ? h(ElEmpty, { description: '还没有会议 —— 点左侧「新会议」开始协作' })
            : events.value.length === 0
              ? h('div', [
                  h(ElEmpty, { description: '还没有消息 —— 在下方输入区发言；@某位成员可召唤 AI' }),
                  emptyChips().length
                    ? h(ElRow, { justify: 'center' }, {
                        default: () => h(ElSpace, { wrap: true }, {
                          default: () => emptyChips().map((chip) => h(ElButton, {
                            key: chip, round: true, size: 'small',
                            // 仅填入草稿，不发送。
                            onClick: () => { onDraft(chip); inputEl.value?.focus() },
                          }, { default: () => chip })),
                        }),
                      })
                    : null,
                ])
              : h('div', { class: 'sp-list' }, [...renderTimeline(), ...liveProgressRows, humanTypingLine, typingLine]),
      ])

      // ── 协作面板 v2（2026-10-02 用户拍板「实事求是」）──────────────────
      // 砍掉引擎诊断信息（协调者调用次数/自治动作/预算进度/暂停原因表格）——
      // 那是开发者调试面，不是用户功能。只保留三样真实有用的东西：
      //   ① 暂停提示：仅在回合暂停时显示一行原因（顶栏「已暂停」的展开）；
      //   ② 成员（含 AI 状态）：能 @ 谁，AI 忙闲一目了然；
      //   ③ 团队待办：/todo 的只读清单。
      const t = turn.value
      const queueSessions = [...new Map(sessionWork.value.queue.map((item) => [item.sessionId, item])).values()]
      const sessionInfo = () => h(ElCard, { shadow: 'hover' }, {
        default: () => [
          h(ElRow, { justify: 'space-between', align: 'middle' }, {
            default: () => [
              h(ElText, { tag: 'strong', truncated: true, title: activeSession.value?.title ?? '' }, {
                default: () => activeSession.value?.title ?? '未选择会话',
              }),
              activeStatus
                ? h(ElTag, { size: 'small', type: activeStatus.tag }, { default: () => activeStatus.label })
                : null,
            ],
          }),
          h(ElText, { size: 'small', type: 'info', class: 'sp-panel-block' }, {
            default: () => `${members.value.length} 位成员 · ${events.value.filter((event) => event.kind === 'message').length} 条消息`,
          }),
          h(ElSpace, { wrap: true, class: 'sp-panel-block' }, {
            default: () => [
              h(ElButton, { size: 'small', onClick: scrollToBottom }, { default: () => '回到最新' }),
              h(ElButton, { size: 'small', disabled: !events.value.some((event) => !event.voided), onClick: exportMinutes }, {
                default: () => '导出纪要',
              }),
            ],
          }),
          sessionWork.value.activeSessionId || queueSessions.length
            ? h('div', { class: 'sp-panel-block' }, [
                h('div', { class: 'sp-panel-title' }, 'Agent 处理队列'),
                sessionWork.value.activeSessionId
                  ? h(ElText, { size: 'small', type: 'success', class: 'sp-panel-block' }, {
                      default: () => `正在处理：${sessions.value.find((item) => item.id === sessionWork.value.activeSessionId)?.title ?? sessionWork.value.activeSessionId}`,
                    })
                  : null,
                ...queueSessions.map((item) => h(ElButton, {
                  key: `queue-${item.sessionId}`, text: true, size: 'small',
                  onClick: () => { void router.replace({ query: { session: item.sessionId } }) },
                }, {
                  default: () => `第 ${item.position} 位 · ${sessions.value.find((session) => session.id === item.sessionId)?.title ?? item.sessionId}`,
                })),
              ])
            : null,
          // ⓪ 协作进行时（B2，2026-10-06）：回合链路上 = AI 在干活，人话
          // 呈现「谁手头有活」；完成/暂停各自有对应的一行状态。
          t?.state === 'chain'
            ? h(ElText, { size: 'small', type: 'success', class: 'sp-panel-block' },
                { default: () => `AI 协作中${t.delegatedTargets.length ? ` —— ${t.delegatedTargets.join('、')} 手头有任务，完成后自动回报` : '，等待 AI 回应…'}` })
            : null,
          // ① 暂停提示（仅暂停时出现，一行小字，不再做表格）。
          t?.state === 'static' && t.stopReason
            ? h(ElText, { size: 'small', type: 'warning', class: 'sp-panel-block' },
                { default: () => `回合已暂停：${STOP_LABEL[t.stopReason] ?? t.stopReason}` })
            : null,
          // ② 成员（人类 + AI 合并，AI 带忙闲状态）。
          h('div', { class: 'sp-panel-title' }, '会话成员（点击名字可 @）'),
          mentionCandidates().length
            ? h('div', { class: 'sp-member-list' }, [
                ...mentionCandidates().map((m) => {
                  const ag = agents.value.find((a) => a.id === m.principalId)
                  const status = ag ? ` · ${ag.status === 'working' ? '工作中' : ag.status === 'done' ? '刚完成' : '空闲'}` : ''
                  // chip 只放短名（分工/角色 + 忙闲），完整「名（id）」进悬浮
                  // title —— 2026-10-05：长 id 曾把面板右缘顶裁切。
                  const short = `${m.duty?.trim() || m.role}${status}`
                  return h(ElButton, {
                    key: m.principalId, size: 'small', text: true,
                    type: m.role === 'DRI' || m.role === '群主' ? 'success' : 'primary',
                    title: `${memberLabel(m)}${status ? ` —— AI 状态：${status.replace(' · ', '')}` : ''}`,
                    onClick: () => { insertMention(m.principalId); inputEl.value?.focus() },
                  }, { default: () => short })
                }),
              ])
            : h(ElText, { size: 'small', type: 'info' }, { default: () => '暂无可 @ 的会话成员' }),
          h('div', { class: 'sp-panel-title' }, '邀请 Agent（加入后可读取完整会话历史）'),
          invitableAgents().length
            ? h(ElSpace, { fill: true }, {
                default: () => [
                  h(ElSelect, {
                    modelValue: inviteAgentId.value,
                    'onUpdate:modelValue': (value: string) => { inviteAgentId.value = value },
                    placeholder: '选择团队 Agent',
                    disabled: !activeId.value || closed.value || invitingAgent.value,
                    clearable: true,
                  }, {
                    default: () => invitableAgents().map((agent) => h(ElOption, {
                      key: agent.id, label: agent.title, value: agent.id,
                    })),
                  }),
                  h(ElButton, {
                    type: 'primary', size: 'small',
                    disabled: !activeId.value || closed.value || !inviteAgentId.value,
                    loading: invitingAgent.value,
                    onClick: () => void inviteSelectedAgent(),
                  }, { default: () => '邀请加入' }),
                ],
              })
            : h(ElText, { size: 'small', type: 'info' }, { default: () => '所有团队 Agent 已加入本会话' }),
          // ③ 团队待办（/todo 只读清单，写路径走指令）。
          h('div', { class: 'sp-panel-title' }, '团队待办'),
          todos.value.length
            ? todos.value
              .slice()
              .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
              .map((td, i) => h(ElText, {
                key: `todo-${td.id}`, size: 'small',
                type: td.done ? 'info' : undefined,
                class: 'sp-panel-block',
              }, { default: () => `${td.done ? '[x]' : '[ ]'} ${td.done ? '' : (i + 1) + '. '}${td.text}` }))
            : h(ElText, { size: 'small', type: 'info', class: 'sp-panel-block' },
              { default: () => '暂无待办 —— 用 /todo <文本> 记一条' }),
        ],
      })
      // 活动日志消费会话事件与 runtime 写入的脱敏 toolCalls；事件经同一 socket
      // 实时送达。Agent 上下文层会过滤这些人类专属过程事件。
      const activityLog = () => {
        const activityEvents = events.value.slice().reverse()
        const visibleEvents = activityEvents.slice(0, activityLimit.value)
        const liveRuns = progressRuns.value.filter((run) =>
          run.sessionId === activeId.value &&
          !['completed', 'failed', 'cancelled'].includes(run.phase) &&
          !events.value.some((ev) => ev.authorKind === 'agent' && ev.authorId === run.agentId &&
            new Set([ev.sourceEventId, ...(ev.sourceEventIds ?? [])].filter(Boolean)).has(run.sourceEventId)))
        return events.value.length || liveRuns.length
          ? h(ElSpace, { direction: 'vertical', fill: true, size: 8, class: 'sp-activity-feed' }, {
            default: () => [
              ...liveRuns.map((run) => h(ElCard, {
                key: `activity-run-${run.runId}`, shadow: 'never', class: 'sp-activity-card',
              }, {
                default: () => [
                  h(ElRow, { justify: 'space-between', align: 'middle' }, {
                    default: () => [
                      h(ElText, { tag: 'strong' }, { default: () => run.title }),
                      h(ElTag, { size: 'small', type: 'warning' }, { default: () => '正在处理' }),
                    ],
                  }),
                  h(ElText, { size: 'small', type: 'info', class: 'sp-panel-block' }, {
                    default: () => run.steps.at(-1)?.label ?? '正在准备',
                  }),
                ],
              })),
              activityEvents.length > visibleEvents.length
                ? h(ElButton, {
                    text: true,
                    type: 'primary',
                    onClick: () => { activityLimit.value += 100 },
                  }, { default: () => `加载更早活动（还有 ${activityEvents.length - visibleEvents.length} 条）` })
                : null,
              ...visibleEvents.map((ev) => {
                const jumpToEvent = () => {
                  panelTab.value = 'info'
                  if (isMobileViewport.value) panelOpen.value = false
                  nextTick(() => {
                    const el = document.querySelector(`[data-ev-id="${ev.id}"]`)
                    el?.scrollIntoView({ behavior: 'smooth', block: 'center' })
                    el?.classList.add('sp-flash')
                    setTimeout(() => el?.classList.remove('sp-flash'), 1400)
                  })
                }
                const calls = ev.toolCalls ?? []
                const summary = ev.voided ? '消息已撤回' : ev.text
                const preview = summary.length > 140 ? `${summary.slice(0, 140)}…` : summary
                return h(ElCard, { key: `activity-${ev.id}`, shadow: 'never', class: 'sp-activity-card' }, {
                  default: () => [
                    h(ElButton, { text: true, type: 'primary', size: 'small', class: 'sp-activity-meta', onClick: jumpToEvent }, {
                      default: () => `#${ev.seq} ${authorLabel(ev.authorId, members.value)} · ${formatTime(ev.ts)}`,
                    }),
                    h(ElText, { size: 'small', truncated: true, title: summary }, {
                      default: () => `${ev.kind === 'message' ? '发言' : ev.kind}：${preview}`,
                    }),
                    ...calls.map((call, i) => {
                      const outcome = call.err ? `失败：${call.err}` : call.result ? `结果：${call.result}` : '已调用'
                      const shortOutcome = outcome.length > 140 ? `${outcome.slice(0, 140)}…` : outcome
                      return h('div', { key: `${ev.id}-tool-${i}` }, [
                        h(ElTag, { size: 'small', type: call.err ? 'danger' : 'info' }, {
                          default: () => `调用工具：${call.name}`,
                        }),
                        h(ElText, { size: 'small', truncated: true, title: outcome }, { default: () => shortOutcome }),
                      ])
                    }),
                  ],
                })
              }),
            ],
          })
          : h(ElEmpty, { description: '本会话还没有活动记录' })
      }
      const panelCard = h(ElTabs, {
        modelValue: panelTab.value,
        'onUpdate:modelValue': (value: string) => { panelTab.value = value },
      }, {
        default: () => [
          h(ElTabPane, { label: '会话信息', name: 'info' }, { default: sessionInfo }),
          h(ElTabPane, { label: `活动 (${events.value.length})`, name: 'activity' }, { default: activityLog }),
        ],
      })
      const collabPanel = () => panelOpen.value
        ? h('aside', { class: 'right-sidebar' }, [
            h('div', { class: 'page-sidebar-content' }, [panelCard]),
          ])
        : null

      // ── 联想浮层（el-popover 虚拟锚定输入框，placement top-start）──────
      const menuRow = (i: number, label: string, hint: string, onClick: () => void) =>
        h('div', { key: `${i}-${label}` }, h(ElButton, {
          text: true, ...(i === activeIdx.value ? { type: 'primary' } : {}), onClick,
        }, { default: () => [h('b', label), `　${hint}`] }))
      const menuContent = () => {
        const m = menu.value
        if (!m) return null
        if (m.kind === 'slash') {
          const items = slashItems(m.query)
          return items.length === 0
            ? [h('div', '（没有匹配的指令）')]
            : items.map((c, i) => menuRow(i, `/${c.name}`, c.usage, () => pickCommand(c.name)))
        }
        const items = mentionItems(m.query)
        return items.length === 0
          ? [h('div', '（没有匹配的成员）')]
          : items.map((mm, i) => menuRow(
              i,
              // 「@所有人」合成候选：特殊 hint（其余成员照常「插入提及」）。
              mm.principalId === '__all__' ? '@所有人' : memberLabel(mm),
              // hint 展示该成员的角色/分工（2026-10-05：每行都写「插入提及」
              // 是重复噪音 —— 动作本身不言自明）。
              mm.principalId === '__all__' ? '召唤全体成员' : (mm.duty?.trim() || mm.role),
              () => insertMention(mm.principalId),
            ))
      }
      const suggestionPopover = () => h(ElPopover, {
        visible: menu.value !== null,
        'virtual-triggering': true,
        'virtual-ref': inputEl.value,
        placement: 'top-start',
        width: 560,
      }, { default: menuContent })

      // × 用显式按钮（shared IconBtn）。只有作者本人能看到。
      const stagingLine = (e: StagingEntry) => h('span', { key: e.id }, [
        h(ElTag, { size: 'large', type: 'info' },
          { default: () => `#${e.seq} ${authorLabel(e.authorId, members.value)}：${e.text}` }),
        e.authorId === me.value?.id
          ? h(IconBtn, {
              icon: 'times-full',
              label: `删除暂存条目 #${e.seq}（等价于 /del ${e.seq}）`,
              onPress: () => void sendText(`/del ${e.seq}`),
            })
          : null,
      ])

      // ── composer 悬浮卡片（贴底居中；已结束会话禁用）────────────────────
      const replySnapshot = replyTo.value
      const composer = h('div', [
        h('div', {
          class: CENTERED,
        }, [
        suggestionPopover(),
        h(KCard, { class: 'sp-composer' }, {
          default: () => [
            // 快捷回复针对最后一条 Agent 消息，先填草稿并建立引用关系，用户仍可编辑后发送。
            (() => {
              const latestMessage = events.value.slice().reverse().find((event) =>
                event.kind === 'message' && !event.voided)
              if (draft.value.trim() || latestMessage?.authorKind !== 'agent' || closed.value) return null
              const replies = ['收到，我来跟进。', '同意，按这个方案继续。', '请补充依据和具体步骤。']
              return h(ElSpace, { key: 'quick-replies', wrap: true }, {
                default: () => replies.map((text) => h(ElButton, {
                  key: text, round: true, size: 'small', disabled: sending.value,
                  title: '填入草稿并引用最近的 Agent 回复，可编辑后发送',
                  onClick: () => chooseQuickReply(text),
                }, { default: () => text })),
              })
            })(),
            // 引用条：composer 输入框上方（仅 replyTo 存在时显示；× 清除）。
            replySnapshot
              ? h('span', { key: 'reply-bar' }, [
                  h(ElTag, {
                    size: 'small', type: 'info', closable: true,
                    onClose: () => { replyTo.value = null },
                  }, { default: () => `引用 #${replySnapshot.seq} ${replySnapshot.author}：${replySnapshot.summary}` }),
                ])
              : null,
            h(ElInput, {
              modelValue: draft.value,
              'onUpdate:modelValue': onDraft,
              onKeydown,
              onBlur,
              disabled: closed.value,
              autosize: { minRows: 1, maxRows: 8 },
              ref: (inst) => { inputEl.value = (inst as { textarea?: HTMLTextAreaElement } | null)?.textarea ?? null },
              type: 'textarea',
              placeholder: closed.value
                ? '会话已结束，不能继续发言'
                : '输入消息，Enter 发送…',
            }),
            h(ElRow, { justify: 'space-between', align: 'middle' }, {
              default: () => [
                // 文件消息入口：选文件 → 上传（20MB 上限）→ 成功后自动发文件消息。
                h(ElButton, {
                  key: 'file-btn', text: true, size: 'small', class: 'sp-attach',
                  disabled: closed.value || fileUploading.value,
                  title: '上传文件（20MB 上限）',
                  onClick: pickFile,
                }, { default: () => [
                    // 回形针图标 + 文字（2026-10-05：孤零零两个字像未完成的占位）。
                    h('svg', {
                      viewBox: '0 0 24 24', width: 14, height: 14,
                      fill: 'none', stroke: 'currentColor', 'stroke-width': 2,
                      'stroke-linecap': 'round', 'stroke-linejoin': 'round',
                      style: 'vertical-align: -2px; margin-right: 4px',
                    }, [h('path', { d: 'M21.44 11.05 12.25 20.24a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48' })]),
                    fileUploading.value ? '上传中…' : '文件',
                  ] }),
                h(ElButton, {
                  key: 'send-btn', class: 'sp-send-icon',
                  type: 'primary', loading: sending.value, disabled: closed.value,
                  title: '发送（Enter）',
                  onClick: () => void sendText(draft.value),
                }, { default: () => h('svg', {
                      viewBox: '0 0 24 24', width: 17, height: 17,
                      fill: 'none', stroke: 'currentColor', 'stroke-width': 2.4,
                      'stroke-linecap': 'round', 'stroke-linejoin': 'round',
                    }, [
                      h('path', { d: 'M12 19V6' }),
                      h('path', { d: 'M5.5 12.5 12 5.5l6.5 7' }),
                    ]) }),
              ],
            }),
            reply.value ? h('span', [
              h(ElTag, { size: 'small', type: replyOk.value ? 'success' : 'error' },
                { default: () => (replyOk.value ? '回执' : '出错') }),
              h('span', ` ${reply.value}`),
              h(IconBtn, { icon: 'times-full', label: '关闭回执', onPress: () => { reply.value = '' } }),
            ]) : null,
            // 暂存条目只在非空时显示（IM 化：主路径直达时间线，暂存是可选路径）。
            staging.value.length ? staging.value.map(stagingLine) : null,
          ],
        }),
        ]),
      ])

      return h(KLayout, { main: 'page-teamspace', class: 'sp-team-layout' }, {
        header: topbarLeft,
        menu: topbarRight,
        default: () => [
          h(ThemeStyle),
          isMobileViewport.value && (railOpen.value || panelOpen.value)
            ? h('button', {
                class: 'sp-drawer-backdrop', type: 'button',
                'aria-label': '关闭侧栏', onClick: () => { railOpen.value = false; panelOpen.value = false },
              })
            : null,
          railOpen.value && hasRail.value
            ? h('aside', { class: 'page-sidebar' }, [
                h(KSlot, { name: 'space-teamspace-sidebar', single: true }),
              ])
            : null,
          h('div', { class: 'content-area' }, [
            activeId.value ? searchBar : null,
            h('div', { class: 'content-body' }, [
              h(ElScrollbar, { ref: scrollbar }, { default: () => messageArea }),
              // 「回到最新」悬浮按钮：偏离底部时出现。
              !nearBottom.value && events.value.length
                ? h(ElButton, {
                    type: 'primary', size: 'small', onClick: scrollToBottom,
                    style: { position: 'absolute', bottom: '120px', left: '50%' },
                  }, { default: () => '回到最新' })
                : null,
            ]),
            composer,
          ]),
          collabPanel(),
        ],
      })
    }
  },
})

// ── 页面注册（官方约定）─────────────────────────────────────────────────
interface PageCtx {
  client: {
    router: {
      page(options: { path: string; name: string; icon?: Component | string; order?: number; component: unknown }): void
    }
  }
}

export default function main(ctx: PageCtx) {
  ctx.client.router.page({
    path: '/teamspace',
    name: '团队空间',
    icon: ICONS.teamspace,
    order: 900,
    component: TeamspacePage,
  })
  ctx.client.router.page({
    path: '/teamspace/agents',
    name: '团队 Agent',
    icon: AGENT_PAGE_ICON,
    order: 901,
    component: AgentManagementPage,
  })
}
