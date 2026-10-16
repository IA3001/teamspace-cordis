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
// 既有交互：@ 联想浮层与完整键盘导航（↑↓/Enter/Tab/Esc/Shift+Enter）、
// 右面板数据口径、
// closable el-tag 暂存条目（仅非空时显示）。
import { computed, defineComponent, h, nextTick, onMounted, onUnmounted, onUpdated, ref, resolveComponent, watch } from 'vue'
import type { Component, VNodeChild } from 'vue'
import { useRpc, useContext, useRoute, useRouter } from '@cordisjs/client'
import { ThemeStyle } from 'space-client-ui-shared/client/theme.ts'
import { ICONS } from 'space-client-ui-shared/client/console.ts'
import { DEFAULT_AGENT_ICON, SvgIcon } from 'space-client-ui-shared/client/icon-library.ts'
import 'space-client-ui-shared/client/im.css'
import { eventCitations, extractAgentWorklog, renderCitationModule, renderMarkdown, visibleAgentReply } from 'space-client-ui-shared/client/md.ts'
import IconBtn from 'space-client-ui-shared/client/IconBtn.ts'
import { authorLabel, formatTime, memberLabel } from 'space-client-ui-shared/client/labels.ts'
import { userFacingFailure, userFacingPause } from 'space-client-ui-shared/client/errors.ts'
import { appendFailureNotice, dismissFailureNotice } from 'space-client-ui-shared/client/feedback.ts'
import type { FailureNotice } from 'space-client-ui-shared/client/feedback.ts'
import { resolveLoadView } from 'space-client-ui-shared/client/load-state.ts'
import type { EventLite, MemberLite } from 'space-client-ui-shared/client/labels.ts'
import { AgentManagementPage, AGENT_PAGE_ICON } from './agents.ts'
import { AgentMemoryPage, AgentWorkspacePage, MEMORY_PAGE_ICON, WORKSPACE_PAGE_ICON } from './agent-operations.ts'
import {
  appendProgressDelta, isSessionReplyActive, progressPreviewLabel, progressRunHasTimelineAnchor,
  progressRunHasOutcome, progressRunsForTimelineEvent, settlesPendingReply, shouldWarnAboutSocketSilence,
} from './progress.ts'
import { groupActivityEvents } from './activity-groups.ts'
import { decisionAccessGuidance, decisionPresentation } from './decision-presentation.ts'

interface SessionLite { id: string; title: string; status: string; updatedAt?: string }
interface SessionWorkLite {
  activeSessionId: string | null
  owners: string[]
  queue: Array<{ sessionId: string; owner: string; position: number }>
}
interface PendingReplyLite {
  key: string
  sessionId: string
  authorId: string
  sourceEventId: string | null
  mentions: string[]
  createdAt: string
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
  citations?: import('space-event').EventCitation[]
}
type AgentProgressStep = { label: string; at: string; kind?: 'phase' | 'tool'; status?: 'running' | 'success' | 'failed'; detail?: string; toolId?: string; inputSummary?: string; resultSummary?: string; durationMs?: number }
type AgentProgressLite = {
  runId: string
  sessionId: string
  agentId: string
  title: string
  sourceEventId: string | null
  phase: 'started' | 'preparing' | 'assembling-context' | 'waiting-model' | 'processing' | 'tool-start' | 'tool-finish' | 'text-delta' | 'finalizing' | 'completed' | 'failed' | 'cancelled'
  toolId?: string
  toolTitle?: string
  ok?: boolean
  delta?: string
  at: string
  steps: AgentProgressStep[]
  step?: AgentProgressStep
  streamText?: string
  streamCharacterCount?: number
  streamTruncated?: boolean
}
type InboxTraceView = {
  agentId: string
  agentTitle: string
  status: 'success' | 'failed'
  sourceSeq?: number
  startedAt: string
  completedAt: string
  steps: Array<{ label: string; detail?: string; at: string; status: 'success' | 'failed' }>
}

function inboxTraceFromEvent(event: TEvent): InboxTraceView | null {
  const args = event.toolCalls?.find((call) => call.name === 'agent.inbox.trace')?.args
  if (!args) return null
  try {
    const value = JSON.parse(args) as Record<string, unknown>
    if (typeof value.agentId !== 'string' || !value.agentId) return null
    const steps = Array.isArray(value.steps) ? value.steps.flatMap((step) => {
      if (!step || typeof step !== 'object') return []
      const row = step as Record<string, unknown>
      return [{
        label: typeof row.label === 'string' ? row.label : '处理阶段',
        detail: typeof row.detail === 'string' ? row.detail : undefined,
        at: typeof row.at === 'string' ? row.at : '',
        status: row.status === 'failed' ? 'failed' as const : 'success' as const,
      }]
    }) : []
    return {
      agentId: value.agentId,
      agentTitle: typeof value.agentTitle === 'string' && value.agentTitle ? value.agentTitle : value.agentId,
      status: value.status === 'failed' ? 'failed' : 'success',
      sourceSeq: typeof value.sourceSeq === 'number' ? value.sourceSeq : undefined,
      startedAt: typeof value.startedAt === 'string' ? value.startedAt : event.ts,
      completedAt: typeof value.completedAt === 'string' ? value.completedAt : event.ts,
      steps,
    }
  } catch { return null }
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
/** AI 成员工作状态（agents RPC 的客户端视图）。 */
interface AgentView { id: string; title: string; status: string; iconId?: string; capabilities?: string[] }
/** 团队待办（todos RPC 的客户端视图；序号由渲染时按 createdAt 升序编，不持久化）。 */
interface TodoView { id: string; done: boolean; text: string; createdAt: string }
/** 联想菜单只用于 @成员；操作从消息卡片和协作面板发起。 */
type Menu = { kind: 'mention'; query: string } | null
type DecisionAction = 'pass' | 'reject' | 'modify' | 'defer' | 'recall' | 'redo'
interface DecisionDraft { eventId: string; action: DecisionAction; label: string }

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

const CENTERED = 'sp-chat-inner'
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
      events(token: string, sessionId: string): Promise<EventLite[] | null>
      event(token: string, sessionId: string, eventId: string): Promise<TEvent | null>
      search(token: string, sessionId: string, query: string): Promise<EventLite[] | null>
      members(token: string, sessionId: string): Promise<MemberLite[] | null>
      staging(token: string, sessionId: string): Promise<StagingEntry[] | null>
      turn(token: string, sessionId: string): Promise<TurnLite | null>
      memories(token: string, sessionId: string): Promise<Array<{ text: string }> | null>
      todos(token: string, sessionId: string): Promise<TodoView[] | null>
      addTodo(token: string, sessionId: string, text: string): Promise<{ ok?: boolean; error?: string; detail?: string } | null>
      setTodoDone(token: string, sessionId: string, id: string, done: boolean): Promise<{ ok?: boolean; error?: string; detail?: string } | null>
      deleteTodo(token: string, sessionId: string, id: string): Promise<{ ok?: boolean; error?: string; detail?: string } | null>
      decide(token: string, sessionId: string, action: DecisionAction, eventId: string, reason?: string): Promise<{ ok?: boolean; text?: string; error?: string; detail?: string } | null>
      generateSummary(token: string, sessionId: string): Promise<{ ok?: boolean; text?: string; error?: string; detail?: string } | null>
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
    const sessionsLoaded = ref(false)
    const sessionsLoading = ref(true)
    const sessionsLoadFailed = ref(false)
    const members = ref([]) as { value: MemberLite[] }
    const events = ref([]) as { value: TEvent[] }
    const timelineReadySessionId = ref('')
    const timelineLoadingSessionId = ref('')
    const timelineFailedSessionId = ref('')
    const progressRuns = ref([]) as { value: AgentProgressLite[] }
    let progressStorageKey = ''
    const persistProgressRuns = () => {
      if (!progressStorageKey) return
      try { localStorage.setItem(progressStorageKey, JSON.stringify(progressRuns.value.slice(-40))) }
      catch { /* Storage quota/private browsing must not interrupt chat. */ }
    }
    const restoreProgressRuns = (userId: string) => {
      progressStorageKey = `space_agent_progress_v1_${userId}`
      let saved: AgentProgressLite[] = []
      try {
        const parsed: unknown = JSON.parse(localStorage.getItem(progressStorageKey) ?? '[]')
        if (Array.isArray(parsed)) {
          const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000
          saved = parsed.filter((run): run is AgentProgressLite => Boolean(run &&
            typeof run.runId === 'string' && typeof run.sessionId === 'string' &&
            typeof run.agentId === 'string' && typeof run.title === 'string' &&
            typeof run.phase === 'string' && typeof run.at === 'string' && Date.parse(run.at) >= cutoff))
        }
      } catch { /* Corrupt or unavailable local state is treated as empty. */ }
      const merged = new Map(saved.map((run) => [run.runId, run]))
      for (const run of progressRuns.value) merged.set(run.runId, run)
      progressRuns.value = [...merged.values()].slice(-40)
      persistProgressRuns()
    }
    const expandedInboxTraces = ref(new Set<string>())
    const progressClock = ref(Date.now())
    const socketState = ref<'connecting' | 'online' | 'resyncing' | 'degraded' | 'disconnected'>('connecting')
    const pendingReplies = ref([]) as { value: PendingReplyLite[] }
    const startedSources = new Set<string>()
    const staging = ref([]) as { value: StagingEntry[] }
    const turn = ref(null) as { value: TurnLite | null }
    const sessionWork = ref({ activeSessionId: null, owners: [], queue: [] }) as { value: SessionWorkLite }
    const activeId = ref('')
    const draft = ref('')
    const quickRepliesHaveMore = ref(false)
    const quickRepliesCanGoBack = ref(false)
    const syncQuickRepliesOverflow = () => {
      const viewport = document.querySelector<HTMLElement>('.sp-quick-replies-viewport')
      const hasMore = Boolean(viewport && viewport.scrollLeft + viewport.clientWidth < viewport.scrollWidth - 2)
      const canGoBack = Boolean(viewport && viewport.scrollLeft > 2)
      if (quickRepliesHaveMore.value !== hasMore) quickRepliesHaveMore.value = hasMore
      if (quickRepliesCanGoBack.value !== canGoBack) quickRepliesCanGoBack.value = canGoBack
    }
    const successReply = ref('')
    const failureNotices = ref([]) as { value: FailureNotice[] }
    const sending = ref(false)
    const me = ref(null) as { value: MeLite | null }
    const menu = ref(null) as { value: Menu }
    const activeIdx = ref(0)
    const inputEl = ref(null) as { value: HTMLTextAreaElement | null }
    /** AI 成员工作状态（agents RPC；随每次 load 刷新）。 */
    const agents = ref([]) as { value: AgentView[] }
    const inviteAgentId = ref('')
    const inviteOpen = ref(false)
    const invitingAgent = ref(false)
    const humans = ref([]) as { value: Array<{ id: string; username: string; displayName: string }> }
    /** 本会话 AI 沉淀记忆（memories RPC；随每次 load 刷新）。 */
    const memories = ref([]) as { value: Array<{ text: string }> }
    /** 团队待办与面板输入草稿。 */
    const todos = ref([]) as { value: TodoView[] }
    const todoDraft = ref('')
    const decisionDraft = ref(null) as { value: DecisionDraft | null }
    const decisionReason = ref('')
    const decisionSubmitting = ref(false)
    const summaryGenerating = ref(false)
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
    const mobileViewport = window.matchMedia('(max-width: 960px)')
    const isMobileViewport = ref(mobileViewport.matches)
    const readDesktopSidebarState = () => {
      try {
        const saved = JSON.parse(localStorage.getItem('space_team_sidebar_state_v1') ?? 'null')
        if (saved && typeof saved === 'object') return { rail: saved.rail !== false, panel: saved.panel !== false }
      } catch { /* use the default expanded layout */ }
      return { rail: true, panel: true }
    }
    const desktopSidebarState = ref(readDesktopSidebarState())
    const persistDesktopSidebarState = () => {
      try { localStorage.setItem('space_team_sidebar_state_v1', JSON.stringify(desktopSidebarState.value)) }
      catch { /* layout preference is optional */ }
    }
    const panelOpen = ref(mobileViewport.matches ? false : desktopSidebarState.value.panel)
    const panelTab = ref('info')
    const activityLimit = ref(100)
    const railOpen = ref(mobileViewport.matches ? false : desktopSidebarState.value.rail)
    /** 「回到最新」按钮：偏离底部（>80px）且有时间线内容时显示。 */
    const nearBottom = ref(true)
    const hasRail = computed(() => (appCtx.client.router.views['space-teamspace-sidebar']?.length ?? 0) > 0)
    const scrollbar = ref<{ setScrollTop: (v: number) => unknown } | null>(null)
    /** 非贴底阅读时，保留视口顶部附近的消息及其相对位置，供窗口缩放后恢复。 */
    let scrollAnchor: { id: string; offset: number } | null = null
    let timelineResizeObserver: ResizeObserver | null = null
    let followScrollFrame = 0
    let resizeFrame = 0
    let replyTimer: ReturnType<typeof setTimeout> | undefined
    let progressClockTimer: ReturnType<typeof setInterval> | undefined
    let socketHealthTimer: ReturnType<typeof setInterval> | undefined
    let feedbackSeq = 0
    let socket: WebSocket | undefined
    let socketLastActivityAt = Date.now()
    let replySeq = 0 // 乐观事件本地 id 序号

    const activeSession = computed(() => sessions.value.find((s) => s.id === activeId.value))
    const closed = computed(() => activeSession.value?.status === 'closed')
    const elapsedLabel = (since: string) => {
      const elapsed = Math.max(0, Math.floor((progressClock.value - Date.parse(since)) / 1000))
      return elapsed < 60 ? `${elapsed} 秒` : `${Math.floor(elapsed / 60)} 分 ${elapsed % 60} 秒`
    }
    watch(() => progressRuns.value.some((run) => !['completed', 'failed', 'cancelled'].includes(run.phase)) ||
      pendingReplies.value.some((item) => item.sessionId === activeId.value), (active) => {
      if (active && !progressClockTimer) {
        progressClockTimer = setInterval(() => { progressClock.value = Date.now() }, 1000)
      } else if (!active && progressClockTimer) {
        clearInterval(progressClockTimer)
        progressClockTimer = undefined
      }
    })
    const progressStageSummary = (run: AgentProgressLite) => {
      const step = run.steps.at(-1)
      if (!step) return '正在启动'
      const startedAt = run.steps[0]?.at ?? step.at
      return `当前：${step.label} · 本阶段 ${elapsedLabel(step.at)} · 本轮 ${elapsedLabel(startedAt)} · ${run.steps.length} 步`
    }
    const activityAuthorLabel = (authorId: string | null) => {
      if (!authorId) return '系统'
      const human = humans.value.find((item) => item.id === authorId)
      if (human) return human.displayName || human.username
      const agent = agents.value.find((item) => item.id === authorId)
      if (agent) return agent.title
      const member = members.value.find((item) => item.principalId === authorId)
      return member ? (member.duty?.trim() || member.role) : authorId
    }
    const activityKindLabel = (kind: string) => ({
      message: '发言', decision: '决策', approval: '审批', system: '系统',
    }[kind] ?? '活动')

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

    // ── 联想菜单仅用于 @成员；斜杠文本始终作为普通消息发送。─────────────
    const mentionRe = /@([\w\u4e00-\u9fa5-]*)$/
    function deriveMenu(text: string): Menu {
      const at = mentionRe.exec(text)
      if (at) {
        const q = at[1]!.toLowerCase()
        return mentionItems(q).length ? { kind: 'mention', query: q } : null
      }
      return null
    }

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
      showReply('请先登录', false)
      void router.replace({ path: '/login' })
    }

    // ── 搜索（时间线 ⇄ 命中列表两种渲染模式）────────────────────────────
    async function doSearch() {
      if (!activeId.value || !searchQuery.value.trim()) return
      try {
        const res = await rpc.value.search(getToken(), activeId.value, searchQuery.value.trim())
        if (isUnauth(res)) return unauthed()
        searchResults.value = res ?? []
      } catch {
        showReply(userFacingFailure('搜索'), false)
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
      } catch {
        showReply(userFacingFailure('撤回'), false)
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
      const initialSessionsLoad = !sessionsLoaded.value
      let requestedSessionId = ''
      if (initialSessionsLoad) sessionsLoading.value = true
      try {
        sessions.value = (await rpc.value.sessions(token)) ?? []
        sessionsLoaded.value = true
        sessionsLoadFailed.value = false
        if (!activeId.value && sessions.value.length > 0) {
          // Session storage is ordered oldest-first. When opening Teamspace
          // without an explicit session in the URL, land in the newest open
          // meeting instead of trapping users in the oldest closed one.
          const initial = sessions.value.find((s) => s.id === route.query.session) ??
            [...sessions.value].reverse().find((s) => s.status === 'open') ??
            sessions.value.at(-1)!
          activeId.value = initial.id
          if (route.query.session !== initial.id) void router.replace({ query: { session: initial.id } })
        }
        if (!activeId.value) return
        requestedSessionId = activeId.value
        if (timelineReadySessionId.value !== requestedSessionId || timelineFailedSessionId.value === requestedSessionId) {
          timelineLoadingSessionId.value = requestedSessionId
          timelineFailedSessionId.value = ''
        }
        const [ev, mb, st, tn, ag, mm, rc, td] = await Promise.all([
          rpc.value.events(token, requestedSessionId),
          rpc.value.members(token, requestedSessionId),
          rpc.value.staging(token, requestedSessionId),
          rpc.value.turn(token, requestedSessionId),
          rpc.value.agents(token),
          rpc.value.memories(token, requestedSessionId),
          rpc.value.reactions(token, requestedSessionId),
          rpc.value.todos(token, requestedSessionId),
        ])
        if (activeId.value !== requestedSessionId) return
        if (isUnauth(ev) || isUnauth(mb)) return unauthed()
        if (ev) {
          events.value = ev
          // A final event owns the durable worklog. Drop its temporary browser
          // snapshot so refresh never shows a stale live card beside the receipt.
          progressRuns.value = progressRuns.value.filter((run) =>
            run.sessionId !== requestedSessionId || !progressRunHasOutcome(run, ev))
          persistProgressRuns()
          const settledSources = new Set((ev as TEvent[]).filter(settlesPendingReply)
            .map((event) => event.sourceEventId)
            .filter((sourceId): sourceId is string => typeof sourceId === 'string' && sourceId.length > 0))
          if (settledSources.size) {
            pendingReplies.value = pendingReplies.value.filter((item) =>
              item.sessionId !== requestedSessionId || !item.sourceEventId || !settledSources.has(item.sourceEventId))
          }
          timelineReadySessionId.value = requestedSessionId
          timelineFailedSessionId.value = ''
        }
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
      } catch {
        if (!sessionsLoaded.value) sessionsLoadFailed.value = true
        if (requestedSessionId && activeId.value === requestedSessionId && timelineReadySessionId.value !== requestedSessionId) {
          timelineFailedSessionId.value = requestedSessionId
        }
        if (requestedSessionId === activeId.value || !requestedSessionId) {
          showReply(userFacingFailure('加载会话'), false)
        }
      } finally {
        if (initialSessionsLoad) sessionsLoading.value = false
        if (requestedSessionId && timelineLoadingSessionId.value === requestedSessionId) {
          timelineLoadingSessionId.value = ''
        }
      }
    }

    async function saveTodo() {
      if (!activeId.value || !todoDraft.value.trim()) return
      const text = todoDraft.value.trim()
      try {
        const result = await rpc.value.addTodo(getToken(), activeId.value, text)
        if (!result) return unauthed()
        if (result.error) { showReply(result.detail || '添加待办失败', false); return }
        todoDraft.value = ''
        await load()
      } catch { showReply(userFacingFailure('添加待办'), false) }
    }

    async function updateTodo(todo: TodoView, done: boolean) {
      if (!activeId.value) return
      try {
        const result = await rpc.value.setTodoDone(getToken(), activeId.value, todo.id, done)
        if (!result) return unauthed()
        if (result.error) { showReply(result.detail || '更新待办失败', false); return }
        await load()
      } catch { showReply(userFacingFailure('更新待办'), false) }
    }

    async function removeTodo(todo: TodoView) {
      if (!activeId.value) return
      try {
        const result = await rpc.value.deleteTodo(getToken(), activeId.value, todo.id)
        if (!result) return unauthed()
        if (result.error) { showReply(result.detail || '删除待办失败', false); return }
        await load()
      } catch { showReply(userFacingFailure('删除待办'), false) }
    }

    async function submitDecision() {
      const pending = decisionDraft.value
      if (!pending || !activeId.value || decisionSubmitting.value) return
      const reason = decisionReason.value.trim()
      if (pending.action !== 'pass' && !reason) {
        showReply('请填写原因或新的处理要求', false)
        return
      }
      decisionSubmitting.value = true
      try {
        const result = await rpc.value.decide(getToken(), activeId.value, pending.action, pending.eventId, reason)
        if (!result) return unauthed()
        if (result.error) { showReply(result.detail || '决策未完成', false); return }
        decisionDraft.value = null
        decisionReason.value = ''
        showReply(result.text || '决策已提交', true)
        await load()
      } catch { showReply(userFacingFailure('提交决策'), false) }
      finally { decisionSubmitting.value = false }
    }

    function openDecision(eventId: string, action: DecisionAction, label: string) {
      decisionReason.value = ''
      decisionDraft.value = { eventId, action, label }
    }

    async function generateSummary() {
      if (!activeId.value || summaryGenerating.value || closed.value) return
      summaryGenerating.value = true
      try {
        const result = await rpc.value.generateSummary(getToken(), activeId.value)
        if (!result) return unauthed()
        if (result.error) { showReply(result.detail || '生成纪要失败', false); return }
        showReply(result.text || '已请求会议记录官生成纪要', true)
        await load()
      } catch { showReply(userFacingFailure('生成纪要'), false) }
      finally { summaryGenerating.value = false }
    }

    function runAgentAction(targetId: string, task: string, sourceAgentId: string) {
      const target = String(targetId ?? '').trim()
      const instruction = String(task ?? '').trim()
      const isSessionAgent = agents.value.some((agent) => agent.id === target) &&
        members.value.some((member) => member.principalId === target)
      if (!isSessionAgent || target === sourceAgentId) {
        showReply('此操作目标不是当前会话中可调用的 Agent', false)
        return
      }
      if (!instruction || instruction.length > 500) {
        showReply('Agent 操作内容为空或超过 500 个字符', false)
        return
      }
      if (closed.value || sending.value) return
      const message = `@${target} ${instruction}`
      draft.value = message
      void sendText(message)
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
      } catch {
        showReply(userFacingFailure('回应'), false)
      }
    }

    // ── 实时推送（IM 化）：socket 上的 'space:event' 增量合并 ─────────────
    function onSocketMessage(ev: MessageEvent) {
      try {
        const msg = JSON.parse(String(ev.data))
        // Cordis 的 pong 只证明 WebSocket 心跳仍通，不能代表 Agent 阶段推送正常。
        // 用应用帧刷新活动时间，避免网络层心跳掩盖持续卡住的工作进度。
        if (msg?.type !== 'pong') {
          socketLastActivityAt = Date.now()
          if (socketState.value === 'degraded') socketState.value = 'online'
        }
        // 人类「正在输入」帧（typing RPC 广播）：瞬时信号，不进时间线。
        if (msg?.type === 'space:typing') {
          onHumanTyping(String(msg.body?.sessionId ?? ''), String(msg.body?.name ?? ''))
          return
        }
        if (msg?.type === 'space:session-work') {
          if (msg.body && typeof msg.body === 'object') sessionWork.value = msg.body as SessionWorkLite
          return
        }
        if (msg?.type === 'space:reply-pending') {
          const update = msg.body as { sessionId?: string; sourceEventId?: string; authorId?: string; mentions?: string[]; at?: string } | undefined
          if (!update?.sessionId || !update.sourceEventId || !Array.isArray(update.mentions)) return
          const local = [...pendingReplies.value].reverse().find((item) =>
            item.sessionId === update.sessionId && item.authorId === update.authorId && !item.sourceEventId)
          if (startedSources.has(update.sourceEventId)) {
            if (local) pendingReplies.value = pendingReplies.value.filter((item) => item.key !== local.key)
          } else if (local) {
            local.sourceEventId = update.sourceEventId
            local.mentions = update.mentions
          } else if (!pendingReplies.value.some((item) =>
            item.sessionId === update.sessionId && item.sourceEventId === update.sourceEventId)) {
            pendingReplies.value = [...pendingReplies.value, {
              key: `pending-${update.sourceEventId}`,
              sessionId: update.sessionId,
              authorId: update.authorId ?? '',
              sourceEventId: update.sourceEventId,
              mentions: update.mentions,
              createdAt: update.at ?? new Date().toISOString(),
            }]
          }
          return
        }
        if (msg?.type === 'space:session-renamed') {
          const update = msg.body as { sessionId?: string; title?: string; updatedAt?: string } | undefined
          if (!update?.sessionId || typeof update.title !== 'string') return
          sessions.value = sessions.value.map((session) => session.id === update.sessionId
            ? { ...session, title: update.title!, updatedAt: update.updatedAt ?? session.updatedAt }
            : session)
          return
        }
        if (msg?.type === 'space:agent-progress') {
          const update = msg.body as Omit<AgentProgressLite, 'steps'> | undefined
          if (!update || !update.sessionId || !update.runId || !update.agentId) return
          const label = update.phase === 'started' ? '开始处理任务'
            : update.phase === 'preparing' ? '准备专属工作区'
              : update.phase === 'assembling-context' ? '整理会话、记忆与知识库上下文'
                : update.phase === 'waiting-model' ? '正在请求模型，等待首个响应'
              : update.phase === 'processing' ? '处理任务与上下文'
                : update.phase === 'tool-start' ? `调用工具：${update.toolTitle ?? update.toolId ?? '未知工具'}`
                  : update.phase === 'tool-finish' ? `${update.toolTitle ?? update.toolId ?? '工具'}${update.ok ? '完成' : '失败'}`
                    : update.phase === 'text-delta' ? '正在生成回复'
                    : update.phase === 'finalizing' ? '整理最终答复'
                      : update.phase === 'completed' ? '已完成'
                        : update.phase === 'cancelled' ? '已取消' : '执行失败'
          const previous = progressRuns.value.find((run) => run.runId === update.runId)
          if (update.phase === 'started' && update.sourceEventId) startedSources.add(update.sourceEventId)
          if (update.sourceEventId && ['started', 'completed', 'failed', 'cancelled'].includes(update.phase)) {
            pendingReplies.value = pendingReplies.value.filter((item) =>
              item.sessionId !== update.sessionId || item.sourceEventId !== update.sourceEventId)
          }
          const steps = [...(previous?.steps ?? [])]
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
          if (update.step) {
            const previousTool = update.step.toolId
              ? [...steps].reverse().find((step) => step.kind === 'tool' && step.toolId === update.step!.toolId)
              : undefined
            if (previousTool) steps[steps.indexOf(previousTool)] = update.step
            else if (steps.at(-1)?.label === update.step.label) steps[steps.length - 1] = update.step
            else steps.push(update.step)
          } else if (steps.at(-1)?.label !== label) steps.push({ label, at: update.at, kind: 'phase' })
          const updatedRun = {
              ...previous, ...update, steps: steps.slice(-30),
              streamText: preview.text,
              streamCharacterCount: preview.totalCharacters,
              streamTruncated: preview.truncated,
          }
          // Updating a run must not reorder concurrent streamed reply rows.
          progressRuns.value = previous
            ? progressRuns.value.map((run) => run.runId === update.runId ? updatedRun : run)
            : [...progressRuns.value, updatedRun].slice(-40)
          persistProgressRuns()
          return
        }
        if (msg?.type === 'space:agent-progress-snapshot') {
          const snapshot = msg.body as AgentProgressLite | undefined
          // Server snapshots are already filtered to sessions the authenticated
          // user belongs to. Keep other-session runs too: the queue panel must
          // explain what the globally active Agent is doing while this session waits.
          if (!snapshot?.sessionId || !snapshot.runId || !snapshot.agentId) return
          const hydratedRun = { ...snapshot, steps: (snapshot.steps ?? []).slice(-30) }
          progressRuns.value = progressRuns.value.some((run) => run.runId === snapshot.runId)
            ? progressRuns.value.map((run) => run.runId === snapshot.runId ? hydratedRun : run)
            : [...progressRuns.value, hydratedRun].slice(-40)
          persistProgressRuns()
          socketState.value = 'online'
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
          if (settlesPendingReply(event)) {
            pendingReplies.value = pendingReplies.value.filter((item) =>
              item.sessionId !== sessionId || item.sourceEventId !== event.sourceEventId)
          }
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
      socketLastActivityAt = Date.now()
      socketState.value = 'resyncing'
      void load().finally(() => { socketState.value = 'online' })
    }
    function onSocketClose() {
      socketState.value = 'disconnected'
    }

    // 会话栏改选 = 改 URL；本页只认 URL，唯一的选中真相源。
    watch(() => route.query.session, (v) => {
      if (v && v !== activeId.value) {
        activeId.value = v
        timelineLoadingSessionId.value = v
        timelineFailedSessionId.value = ''
        if (isMobileViewport.value) railOpen.value = false
        events.value = []
        reactions.value = {} // 切会话清掉回应汇总（随 load 重拉）
        reactPickerId.value = ''
        replyTo.value = null // 切会话清掉引用条（引用属于旧会话的消息）
        humanTyping.value = { name: '', ts: 0 } // 切会话清掉「正在输入」指示
        clearTimeout(humanTypingTimer)
        clearSearch()
        restoreDraft()
        nearBottom.value = true
        scrollAnchor = null
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
      return mentionItems(m.query).length
    }
    function pickActive(): void {
      const m = menu.value
      if (!m) return
      const items = mentionItems(m.query)
      const mm = items[activeIdx.value] ?? items[0]
      if (mm) insertMention(mm.principalId)
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
      } catch {
        showReply(userFacingFailure('邀请 Agent'), false)
      } finally {
        invitingAgent.value = false
      }
    }

    /** 成功回执短暂显示；失败按独立通知保留，直到用户逐条关闭。 */
    function showReply(text: string, ok: boolean) {
      clearTimeout(replyTimer)
      if (ok) {
        successReply.value = text
        const sequence = ++feedbackSeq
        replyTimer = setTimeout(() => {
          if (sequence === feedbackSeq) successReply.value = ''
        }, 3000)
      } else {
        successReply.value = ''
        failureNotices.value = appendFailureNotice(failureNotices.value, {
          id: ++feedbackSeq,
          message: text,
        })
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
      } catch {
        showReply(userFacingFailure('上传文件'), false)
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
      } catch {
        showReply(userFacingFailure('导入知识库'), false)
      }
    }

    async function sendText(text: string) {
      if (!activeId.value) { showReply('请先选择或新建一个会议', false); return }
      // IM 化：空输入静默忽略（不再弹错误回执）。
      if (!text.trim()) return
      if (sending.value || closed.value) return
      sending.value = true
      const mentions = parseMentions()
      // 引用系统化（2026-10-02）：引用关系走 replyTo 结构化字段，消息正文不再拼前缀。
      const fullText = text
      const localId = `__local_${++replySeq}`
      const pendingReply = mentions.length
        ? {
            key: localId, sessionId: activeId.value, authorId: me.value?.id ?? '', sourceEventId: null as string | null,
            mentions, createdAt: new Date().toISOString(),
          }
        : null
      if (pendingReply) pendingReplies.value = [...pendingReplies.value, pendingReply]
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
        const result: SendResult = await rpc.value.send(getToken(), activeId.value, fullText, mentions, replyTo.value?.id ?? null)
        if (isUnauth(result)) { unauthed(); return }
        if ('error' in result) {
          // 回滚乐观插入，显示错误。
          events.value = events.value.filter((e) => e.id !== localId)
          if (pendingReply) pendingReplies.value = pendingReplies.value.filter((item) => item.key !== localId)
          showReply(`出错了（${result.error}）：${result.detail}`, false)
          return
        }
        // 确认成功：去掉临时事件；真事件由响应或 socket 推送补上（两者按 id 去重）。
        events.value = events.value.filter((e) => e.id !== localId)
        if (result.event) {
          mergeEvent(result.event)
          if (pendingReply) {
            const pushed = pendingReplies.value.find((item) => item.sessionId === activeId.value &&
              item.sourceEventId === result.event!.id)
            if (pushed && pushed.key !== localId) pendingReplies.value = pendingReplies.value.filter((item) => item.key !== localId)
            else if (!startedSources.has(result.event.id)) pendingReply.sourceEventId = result.event.id
            else pendingReplies.value = pendingReplies.value.filter((item) => item.key !== localId)
          }
        }
        draft.value = ''
        replyTo.value = null
        replyTo.value = null // 引用已随消息发出，清掉引用条
        localStorage.removeItem(`space_draft_${activeId.value}`)
        menu.value = null
        if (result.reply) showReply(result.reply, true)
        void load()
      } catch {
        events.value = events.value.filter((e) => e.id !== localId)
        if (pendingReply) pendingReplies.value = pendingReplies.value.filter((item) => item.key !== localId)
        showReply(userFacingFailure('发送消息'), false)
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

    watch(() => events.value.length, async () => {
      await nextTick()
      // 新会话从最新消息开始；之后只有贴底阅读时才跟随新消息。
      if (nearBottom.value) scrollToBottom()
    })
    watch(activeId, () => { activityLimit.value = 100 })

    // ── 可见即已读兜底：页面从后台回到可见时，把当前会话写一次已读时刻 ──
    // 防止「看过但红点还在」的边缘态（切走瞬间推来的消息未落 seen）。
    function onVisibilityChange() {
      if (!document.hidden && activeId.value) {
        localStorage.setItem(`space_seen_${activeId.value}`, String(Date.now()))
        if (socketState.value === 'degraded' && socket?.readyState === WebSocket.OPEN) {
          socketLastActivityAt = Date.now()
          socketState.value = 'resyncing'
          void load().finally(() => { socketState.value = 'online' })
        }
      }
    }

    function onViewportChange(event: MediaQueryListEvent) {
      isMobileViewport.value = event.matches
      // 两侧面板在窄屏上是抽屉；进入窄屏时先收起，回到桌面宽度恢复双栏。
      if (event.matches) {
        desktopSidebarState.value = { rail: railOpen.value, panel: panelOpen.value }
        railOpen.value = false
        panelOpen.value = false
      } else {
        railOpen.value = desktopSidebarState.value.rail
        panelOpen.value = desktopSidebarState.value.panel
      }
    }

    function onDrawerKeydown(event: KeyboardEvent) {
      if (event.key !== 'Escape' || event.defaultPrevented || !isMobileViewport.value) return
      if (!railOpen.value && !panelOpen.value) return
      const restoreRailFocus = railOpen.value
      // Let dialogs and the session quick-switch consume Escape first. Window
      // listeners run synchronously in registration order; defer until all of
      // them have had a chance to mark the event handled.
      queueMicrotask(() => {
        if (event.defaultPrevented || !isMobileViewport.value) return
        if (!railOpen.value && !panelOpen.value) return
        railOpen.value = false
        panelOpen.value = false
        void nextTick(() => {
          const selector = restoreRailFocus ? '.sp-sidebar-toggle--left' : '.sp-sidebar-toggle--right'
          document.querySelector<HTMLElement>(selector)?.focus({ preventScroll: true })
        })
      })
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
      window.addEventListener('resize', syncQuickRepliesOverflow, { passive: true })
      window.addEventListener('keydown', onDrawerKeydown)
      document.querySelector('.content-body .el-scrollbar__wrap')
        ?.addEventListener('scroll', onScroll, { passive: true })
      // Subscribe before the initial RPC fan-out: a reply can enter memory
      // catch-up while the page is loading, and its pending bubble must not be
      // lost during that first render.
      const clientWithSocket = appCtx.client as typeof appCtx.client & { socket?: { value?: WebSocket } }
      const rawSocket = clientWithSocket.socket?.value
      socket = rawSocket && typeof rawSocket.addEventListener === 'function' ? rawSocket : undefined
      socketState.value = socket?.readyState === WebSocket.OPEN ? 'online' : 'connecting'
      if (!socket) console.warn('[space] client.socket 不可监听（外壳版本差异），实时推送降级为手动刷新')
      socket?.addEventListener('message', onSocketMessage)
      socket?.addEventListener('open', onSocketOpen)
      socket?.addEventListener('close', onSocketClose)
      socketLastActivityAt = Date.now()
      socketHealthTimer = setInterval(() => {
        const hasAgentWork = pendingReplies.value.some((item) => item.sessionId === activeId.value) ||
          progressRuns.value.some((run) => run.sessionId === activeId.value &&
            !['completed', 'failed', 'cancelled'].includes(run.phase))
        if (shouldWarnAboutSocketSilence({
          now: Date.now(),
          lastActivityAt: socketLastActivityAt,
          hasAgentWork,
          pageVisible: !document.hidden,
          socketOpen: socket?.readyState === WebSocket.OPEN,
          state: socketState.value,
        })) socketState.value = 'degraded'
      }, 5_000)
      const meRes = await rpc.value.me(getToken())
      if (!meRes || isUnauth(meRes)) { unauthed(); return }
      me.value = meRes
      restoreProgressRuns(meRes.id)
      nearBottom.value = true
      await load()
      await nextTick()
      const timelineView = document.querySelector('.content-body .el-scrollbar__view')
      if (timelineView) {
        timelineResizeObserver = new ResizeObserver(() => {
          if (!nearBottom.value) return
          cancelAnimationFrame(followScrollFrame)
          followScrollFrame = requestAnimationFrame(() => {
            if (nearBottom.value) scrollToBottom()
          })
        })
        timelineResizeObserver.observe(timelineView)
      }
      if (socket?.readyState === WebSocket.OPEN) socketState.value = 'online'
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
    })
    onUnmounted(() => {
      document.removeEventListener('visibilitychange', onVisibilityChange)
      mobileViewport.removeEventListener('change', onViewportChange)
      window.removeEventListener('resize', onWindowResize)
      window.removeEventListener('resize', syncQuickRepliesOverflow)
      window.removeEventListener('keydown', onDrawerKeydown)
      document.querySelector('.content-body .el-scrollbar__wrap')
        ?.removeEventListener('scroll', onScroll)
      cancelAnimationFrame(resizeFrame)
      cancelAnimationFrame(followScrollFrame)
      timelineResizeObserver?.disconnect()
      socket?.removeEventListener('message', onSocketMessage)
      socket?.removeEventListener('open', onSocketOpen)
      socket?.removeEventListener('close', onSocketClose)
      if (progressClockTimer) clearInterval(progressClockTimer)
      if (socketHealthTimer) clearInterval(socketHealthTimer)
      clearTimeout(replyTimer)
      clearTimeout(humanTypingTimer)
      stopTypingPoll()
    })
    onUpdated(syncQuickRepliesOverflow)

    return () => {
      const ElButton = resolveComponent('el-button') as unknown as string
      const ElCard = resolveComponent('el-card') as unknown as string
      const ElRow = resolveComponent('el-row') as unknown as string
      const ElInput = resolveComponent('el-input') as unknown as string
      const ElCheckbox = resolveComponent('el-checkbox') as unknown as string
      const ElDialog = resolveComponent('el-dialog') as unknown as string
      const ElSelect = resolveComponent('el-select') as unknown as string
      const ElOption = resolveComponent('el-option') as unknown as string
      const ElTag = resolveComponent('el-tag') as unknown as string
      const ElEmpty = resolveComponent('el-empty') as unknown as string
      const ElScrollbar = resolveComponent('el-scrollbar') as unknown as string
      const ElDropdown = resolveComponent('el-dropdown') as unknown as string
      const ElDropdownItem = resolveComponent('el-dropdown-item') as unknown as string
      const ElPopover = resolveComponent('el-popover') as unknown as string
      const KCard = resolveComponent('k-card') as unknown as string
      const ElDivider = resolveComponent('el-divider') as unknown as string
      const ElText = resolveComponent('el-text') as unknown as string
      const Markdown = resolveComponent('k-markdown') as unknown as string
      const ElSpace = resolveComponent('el-space') as unknown as string
      const ElTimeline = resolveComponent('el-timeline') as unknown as string
      const ElAvatar = resolveComponent('el-avatar') as unknown as string
      const ElTimelineItem = resolveComponent('el-timeline-item') as unknown as string
      const progressPreview = (run: AgentProgressLite, key: string) => {
        if (!run.streamText) return null
        const visibleText = visibleAgentReply(run.streamText)
        return h(ElText, { key }, {
          default: () => `${progressPreviewLabel(run.phase, {
            text: visibleText,
            totalCharacters: run.streamCharacterCount ?? Array.from(run.streamText!).length,
            truncated: run.streamTruncated ?? false,
          })}\n${visibleText}`,
        })
      }
      const liveReplyRow = (run: AgentProgressLite) => {
        const visibleText = visibleAgentReply(run.streamText ?? '')
        return h('div', {
          key: `reply-${run.runId}`, class: 'sp-msg sp-live-reply', role: 'status', 'aria-live': 'polite',
        }, [
        h(ElAvatar, { size: 32, class: 'sp-msg-avatar sp-msg-avatar--agent' }, {
          default: () => h(SvgIcon, { name: agents.value.find((agent) => agent.id === run.agentId)?.iconId ?? DEFAULT_AGENT_ICON }),
        }),
        h('div', { class: 'sp-msg-body' }, [
          h('div', { class: 'sp-msg-name' }, `${run.title} · ${run.phase === 'completed' ? '正在同步回复' : '正在回复'}`),
          h('div', { class: 'sp-bubble agent sp-live-reply-bubble' }, [
            renderMarkdown(visibleText, h, {
              Markdown, Button: ElButton, transformProse: displayMentionsInMarkdown,
            }),
            run.phase !== 'completed' && visibleText !== '（正在处理工具调用，请查看工作记录）'
              ? h('span', { class: 'sp-typing-dots', 'aria-label': '正在生成' }, [h('i'), h('i'), h('i')]) : null,
          ]),
        ]),
        ])
      }
      const hasVisibleLiveReply = (run: AgentProgressLite) => Boolean(
        run.sessionId === activeId.value && run.streamText &&
        !['failed', 'cancelled'].includes(run.phase) && !progressRunHasOutcome(run, events.value),
      )
      const progressTimeline = (
        steps: AgentProgressLite['steps'],
        keyPrefix: string,
        phase?: AgentProgressLite['phase'],
      ) => h(ElTimeline, { class: 'sp-progress-timeline' }, {
        default: () => steps.map((step, index) => {
          const latest = index === steps.length - 1
          const status = latest && phase === 'failed' ? 'danger'
            : latest && phase === 'completed' ? 'success'
              : latest && phase === 'cancelled' ? 'warning'
                : latest ? 'primary' : 'info'
          const textType = step.status === 'failed' || (latest && phase === 'failed') ? 'danger'
            : step.status === 'success' || (latest && phase === 'completed') ? 'success'
              : latest && phase === 'cancelled' ? 'warning' : latest ? 'primary' : 'info'
          return h(ElTimelineItem, {
            key: `${keyPrefix}-${index}`,
            timestamp: formatTime(step.at),
            placement: 'top',
            type: status,
            hollow: !latest,
            size: latest ? 'large' : 'normal',
          }, {
            default: () => h(ElSpace, { direction: 'vertical', alignment: 'start', size: 3 }, { default: () => [
              h(ElText, { size: 'small', type: textType }, { default: () => step.label }),
              step.detail ? h(ElText, { size: 'small', type: step.status === 'failed' ? 'danger' : 'info' }, { default: () => step.detail }) : null,
              step.inputSummary ? h(ElText, { size: 'small', type: 'info' }, { default: () => `工具输入摘要：${step.inputSummary}` }) : null,
              step.resultSummary ? h(ElText, { size: 'small', type: step.status === 'failed' ? 'danger' : 'info' }, { default: () => `工具结果：${step.resultSummary}` }) : null,
              step.durationMs !== undefined ? h(ElText, { size: 'small', type: 'info' }, { default: () => `耗时 ${step.durationMs} ms` }) : null,
            ] }),
          })
        }),
      })
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
      const ElAlert = resolveComponent('el-alert') as unknown as string
      const progressCollapseProps = (name: string) => ({
        class: 'sp-progress-card', border: false,
        'data-progress-id': name,
        onChange: (active: string | number | Array<string | number>) => {
          const expanded = Array.isArray(active) ? active.some((item) => String(item) === name) : String(active) === name
          if (expanded && nearBottom.value) {
            const sessionId = activeId.value
            void nextTick(() => requestAnimationFrame(() => {
              window.setTimeout(() => {
                if (activeId.value === sessionId && nearBottom.value) scrollToBottom()
              }, 360)
            }))
          }
        },
      })

      const work = sessionWork.value
      const busySession = work?.activeSessionId
      const busyTitle = sessions.value.find((session) => session.id === busySession)?.title ?? busySession
      const waitingHere = work?.queue.some((item) => item.sessionId === activeSession.value?.id) ?? false
      const replyingHere = activeSession.value ? isSessionReplyActive({
        sessionId: activeSession.value.id,
        activeSessionId: busySession,
        runs: progressRuns.value,
        pendingSessionIds: pendingReplies.value.map((item) => item.sessionId),
      }) : false
      const activeStatus = !activeSession.value ? null
        : replyingHere
          ? { label: '聊天中…', tag: 'warning' }
          : busySession && waitingHere
            ? { label: `排队中 · ${busyTitle} 正在处理`, tag: 'info' }
            : sessionStatus(activeSession.value)
      const startNewMeeting = async () => {
        if (isMobileViewport.value && hasRail.value) {
          panelOpen.value = false
          railOpen.value = true
          await nextTick()
        }
        await router.replace({ query: { ...route.query, newMeeting: '1' } })
      }
      const toggleSidebar = (side: 'left' | 'right') => {
        const expanded = side === 'left' ? railOpen.value : panelOpen.value
        const label = side === 'left' ? '会话列表' : '协作面板'
        return h(ElButton, {
          text: true,
          class: `sp-sidebar-toggle sp-sidebar-toggle--${side}`,
          title: `${expanded ? '收起' : '展开'}${label}`,
          'aria-label': `${expanded ? '收起' : '展开'}${label}`,
          'aria-expanded': expanded,
          onClick: () => {
            if (side === 'left') {
              railOpen.value = !railOpen.value
              if (isMobileViewport.value && railOpen.value) panelOpen.value = false
              if (!isMobileViewport.value) {
                desktopSidebarState.value.rail = railOpen.value
                persistDesktopSidebarState()
              }
            } else {
              panelOpen.value = !panelOpen.value
              if (isMobileViewport.value && panelOpen.value) railOpen.value = false
              if (!isMobileViewport.value) {
                desktopSidebarState.value.panel = panelOpen.value
                persistDesktopSidebarState()
              }
            }
          },
        }, {
          default: () => h(KIcon, {
            name: side === 'left'
              ? (expanded ? 'chevron-left' : 'chevron-right')
              : (expanded ? 'chevron-right' : 'chevron-left'),
          }),
        })
      }
      const topbarLeft = () => [
        hasRail.value && !railOpen.value
          ? h('span', { key: 'rail-toggle', class: 'sp-sidebar-toggle-slot' }, [toggleSidebar('left')])
          : null,
        h('span', {
          class: 'layout-header-title sp-session-title', key: 'title',
          title: activeSession.value?.title ?? '团队空间',
        }, activeSession.value?.title ?? '团队空间'),
        activeStatus
          ? h(ElTag, { key: 'status', size: 'small', type: activeStatus.tag },
              { default: () => activeStatus.label })
          : null,
      ]
      const topbarRight = () => [
        h(ElButton, {
          key: 'agents-catalog', size: 'small', class: 'sp-mobile-secondary sp-agent-directory-button',
          onClick: () => window.location.assign('/teamspace/agents'),
        }, { default: () => h('span', { class: 'sp-agent-directory-label' }, [
          h(ICONS.agents),
          h('span', '团队 Agent'),
        ]) }),
        turn.value?.state === 'static' && turn.value.stopReason && turn.value.stopReason !== 'completed'
          ? h(ElTag, {
              key: 'paused', size: 'small', type: 'warning', class: 'sp-mobile-secondary',
              title: turn.value.stopDetail || userFacingPause(turn.value.stopReason),
            }, { default: () => '本轮已暂停' })
          : null,
        !panelOpen.value
          ? h('span', { key: 'panel', class: 'sp-sidebar-toggle-slot' }, [toggleSidebar('right')])
          : null,
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
            h('div', { class: 'sp-quote', title: qm[3] }, [
              h('span', { class: 'sp-quote-text' }, `↳ 回复 #${qm[1]} ${pretty}：${qm[3]}`),
            ]),
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
        const displayMention = (token: string) => {
          const id = token.slice(1)
          if (['all', 'everyone', '所有人'].includes(id.toLowerCase())) return '@所有人'
          const label = activityAuthorLabel(id)
          return label === id ? token : `@${label}`
        }
        return splitMentions(text).map((seg, i) => seg.at
          ? h(ElTag, { key: i, size: 'small', type: 'primary' }, { default: () => displayMention(seg.t) })
          : seg.t)
      }

      const displayMentionsInText = (text: string) => splitMentions(text)
        .map((segment) => {
          if (!segment.at) return segment.t
          const id = segment.t.slice(1)
          if (['all', 'everyone', '所有人'].includes(id.toLowerCase())) return '@所有人'
          const label = activityAuthorLabel(id)
          return label === id ? segment.t : `@${label}`
        })
        .join('')
      const displayMentionsInMarkdown = (text: string) => text
        .split(/(`+[^`]*`+)/g)
        .map((part, index) => index % 2 ? part : displayMentionsInText(part))
        .join('')

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
      const scrollToEvent = (eventId: string) => {
        const el = [...document.querySelectorAll<HTMLElement>('[data-ev-id]')]
          .find((item) => item.dataset.evId === eventId)
        el?.scrollIntoView({ behavior: 'smooth', block: 'center' })
        el?.classList.add('sp-flash')
        setTimeout(() => el?.classList.remove('sp-flash'), 1400)
      }
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
          onClick: () => scrollToEvent(replyToId),
        }, [h('span', { class: 'sp-quote-text' }, `↳ ${head}：${body}`)])
      }

      const messageRow = (
        ev: TEvent,
        flowView?: FlowEventView | null,
        causalCounts: ReadonlyMap<string, number> = new Map(),
        groupedWithPrevious = false,
      ) => {
        const isFlow = ev.authorKind === 'system' && !ev.voided && !!flowView
        const visibleText = ev.authorKind === 'agent' ? visibleAgentReply(ev.text) : ev.text
        const displayEvent = visibleText === ev.text ? ev : { ...ev, text: visibleText }
        const decision = ev.voided ? null : decisionPresentation(displayEvent, events.value)
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
        const hasAssignedDri = members.value.some((member) => member.role === 'DRI')
        const currentMembership = members.value.find((member) => member.principalId === me.value?.id)
        const ownerFallback = !hasAssignedDri && currentMembership?.role === '群主'
        const canDecide = ev.kind === 'message' && ev.authorKind === 'agent' &&
          (currentMembership?.role === 'DRI' || ownerFallback)
        const pendingDri = members.value.find((member) => member.role === 'DRI')
        const pendingDriHuman = pendingDri
          ? humans.value.find((human) => human.id === pendingDri.principalId)
          : undefined
        const pendingDriName = pendingDri
          ? pendingDriHuman?.displayName || pendingDriHuman?.username || pendingDri.duty?.trim() || pendingDri.principalId
          : undefined
        const viewerRole = members.value.find((member) => member.principalId === me.value?.id)?.role
        const accessGuidance = decision?.title === '待 DRI 决策'
          ? decisionAccessGuidance({
              viewerIsDri: canDecide,
              viewerIsOwnerFallback: canDecide && ownerFallback,
              viewerRole,
              driName: pendingDriName,
              driPrincipalId: pendingDri?.principalId,
            })
          : ''
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
          const inboxTrace = inboxTraceFromEvent(ev)
          if (inboxTrace) {
            const ElTimeline = resolveComponent('el-timeline') as unknown as string
            const ElTimelineItem = resolveComponent('el-timeline-item') as unknown as string
            const ElTag = resolveComponent('el-tag') as unknown as string
            const ElButton = resolveComponent('el-button') as unknown as string
            const ElText = resolveComponent('el-text') as unknown as string
            const ElSpace = resolveComponent('el-space') as unknown as string
            const started = Date.parse(inboxTrace.startedAt)
            const completed = Date.parse(inboxTrace.completedAt)
            const duration = Number.isFinite(started) && Number.isFinite(completed)
              ? `${Math.max(0, completed - started)} ms` : '耗时未知'
            const expanded = expandedInboxTraces.value.has(ev.id)
            const toggleTrace = () => {
              const next = new Set(expandedInboxTraces.value)
              if (next.has(ev.id)) next.delete(ev.id)
              else next.add(ev.id)
              expandedInboxTraces.value = next
            }
            const traceDetails = expanded
              ? inboxTrace.steps.length
                ? h(ElTimeline, {}, {
                    default: () => inboxTrace.steps.map((step, index) => {
                      const content = h(ElSpace, { direction: 'vertical', size: 2 }, {
                        default: () => [
                          h(ElText, { tag: 'strong' }, { default: () => step.label }),
                          step.detail ? h(ElText, { size: 'small', type: 'info' }, { default: () => step.detail }) : null,
                        ],
                      })
                      return h(ElTimelineItem, {
                        key: `${ev.id}-trace-${index}`, timestamp: step.at ? formatTime(step.at) : undefined,
                        type: step.status === 'failed' ? 'danger' : 'primary', hollow: true,
                      }, { default: () => content })
                    }),
                  })
                : h(ElText, { type: 'info' }, { default: () => '该记录没有保存阶段明细。' })
              : null
            return h('div', { class: 'sp-sys', key: ev.id, 'data-ev-id': ev.id }, [
              h(ElSpace, { size: 6, wrap: true }, { default: () => [
                h(ElTag, { size: 'small', type: inboxTrace.status === 'success' ? 'success' : 'danger', effect: 'dark' }, {
                  default: () => inboxTrace.status === 'success' ? '已完成' : '失败',
                }),
                h(ElButton, { text: true, size: 'small', 'aria-expanded': expanded, onClick: toggleTrace }, {
                  default: () => `${inboxTrace.agentTitle} · ${inboxTrace.steps.length} 步 · ${duration}`,
                }),
                inboxTrace.sourceSeq !== undefined
                  ? h(ElText, { size: 'small', type: 'info' }, { default: () => `来源 #${inboxTrace.sourceSeq}` })
                  : null,
                h(ElButton, { text: true, size: 'small', onClick: () => {
                  void router.replace({ path: '/teamspace/workspaces', query: { agent: inboxTrace.agentId } })
                } }, { default: () => '工作区 ↗' }),
              ] }),
              traceDetails,
            ])
          }
          const queuedPosition = ev.text.match(/Agent 任务已排队[（(]\s*第\s*(\d+)\s*位[）)]/u)?.[1]
          const queueStarted = /排队任务开始处理/u.test(ev.text)
          if (queuedPosition || queueStarted) {
            return h('div', {
              class: 'sp-sys', key: ev.id, 'data-ev-id': ev.id, title: ev.text,
            }, h(ElSpace, { size: 8 }, {
              default: () => [
                h(ElTag, { size: 'small', type: 'info' }, {
                  default: () => queueStarted ? '队列' : `第 ${queuedPosition} 位`,
                }),
                h(ElText, { size: 'small', type: 'info' }, {
                  default: () => queueStarted ? 'Agent 开始处理排队任务' : 'Agent 正忙，空闲后会自动继续',
                }),
              ],
            }))
          }
          const retrySource = ev.sourceEventId && /顺序处理更早的会话消息|尚未完成此前消息的顺序处理/u.test(ev.text)
            ? events.value.find((event) => event.id === ev.sourceEventId && !event.voided)
            : undefined
          return h('div', { class: 'sp-sys', key: ev.id, 'data-ev-id': ev.id }, [
            h(ElText, { size: 'small', type: 'info' }, { default: () => ev.text }),
            retrySource
              ? h(ElButton, {
                  size: 'small', text: true,
                  title: '将原消息放回输入框，检查后重新发送',
                  onClick: () => {
                    onDraft(retrySource.text)
                    void nextTick(() => inputEl.value?.focus())
                  },
                }, { default: () => '重新编辑请求' })
              : null,
          ])
        }
        const sessionMember = members.value.find((item) => item.principalId === ev.authorId)
        const directoryAgent = agents.value.find((item) => item.id === ev.authorId)
        const directoryHuman = humans.value.find((item) => item.id === ev.authorId)
        const memberName = sessionMember?.duty?.trim() || sessionMember?.role
        // A generic session role such as “成员” must not mask the shared Agent title.
        const name = ev.authorKind === 'agent'
          ? directoryAgent?.title || memberName || ev.authorId || 'Agent'
          : memberName || directoryHuman?.displayName || directoryHuman?.username || ev.authorId || '系统'
        const bubble: VNodeChild = ev.voided
          ? h(ElText, { size: 'small', type: 'info' }, { default: () => '消息已撤回' })
          : isFlow
            ? flowCard
            : ev.authorKind === 'agent' && ev.kind === 'system' && ev.text.startsWith('有话想说：')
              ? h('div', { class: 'sp-bubble agent sp-pending-bubble' }, [
                  h('span', { class: 'sp-pending-label' }, '有话想说'),
                  h(ElText, { size: 'small', type: 'info' }, {
                    default: () => ev.text.slice('有话想说：'.length).trim(),
                  }),
                ])
            : ev.authorKind === 'human'
              ? renderText(ev.text)
              : renderMarkdown(decision?.recommendation ?? visibleText, h, {
                  Markdown, Button: ElButton, transformProse: displayMentionsInMarkdown,
                })
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
                    const action = cmd.slice('decision:'.length) as DecisionAction
                    const selected = decisionActions.find((item) => item.action === action)
                    if (selected) openDecision(ev.id, action, selected.label)
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
                      ...(decision ? [] : decisionActions).map(({ action, label }) => h(ElDropdownItem, {
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
        const matchingRuns = progressRunsForTimelineEvent(ev, events.value, progressRuns.value)
        const persistedWorklog = extractAgentWorklog(ev.text, ev.toolCalls).steps
        // When the final event arrives, keep the run's in-memory timeline on
        // the message even if persistence omitted its worklog tool call.
        const completedRun = matchingRuns.at(-1)
        const worklogToShow = persistedWorklog.length ? persistedWorklog
          : completedRun?.steps.length ? completedRun.steps
          : /^【执行失败】/.test(ev.text)
            ? [{ label: '此历史运行未保存详细阶段记录', at: ev.ts }]
            : []
        const progressCards = worklogToShow.length
          ? [h(ElCollapse, {
            key: `worklog-${ev.id}`, ...progressCollapseProps(`worklog-${ev.id}`),
          }, {
            default: () => h(ElCollapseItem, { name: `worklog-${ev.id}`, class: 'sp-progress-item' }, {
              title: () => `工作记录 · ${worklogToShow.length} 步`,
              default: () => h(ElSpace, { direction: 'vertical', fill: true, size: 4 }, {
                default: () => [
                  progressTimeline(worklogToShow, `worklog-${ev.id}`, /^【执行失败】/.test(ev.text) ? 'failed' : completedRun?.phase),
                  completedRun ? progressPreview(completedRun, `${ev.id}-stream`) : null,
                ],
              }),
            }),
          })]
          : matchingRuns.map((run) => h(ElCollapse, {
            key: `run-${run.runId}`, ...progressCollapseProps(run.runId),
          }, {
            default: () => h(ElCollapseItem, { name: run.runId, class: 'sp-progress-item' }, {
              title: () => progressStageSummary(run),
              default: () => h(ElSpace, { direction: 'vertical', fill: true, size: 4 }, {
                default: () => [
                  progressTimeline(run.steps, run.runId, run.phase),
                  progressPreview(run, `${run.runId}-stream`),
                ],
              }),
            }),
          }))
        return h('div', {
          key: ev.authorKind === 'agent' && completedRun ? `reply-${completedRun.runId}` : ev.id, 'data-ev-id': ev.id,
          class: `sp-msg${self ? ' self' : ''}${progressCards.length ? ' has-progress' : ''}${groupedWithPrevious ? ' sp-msg--grouped' : ''}`,
        }, [
        !self ? h(ElAvatar, {
          size: 32,
          class: ['sp-msg-avatar', `sp-msg-avatar--${ev.authorKind}`],
        }, { default: () => ev.authorKind === 'agent'
          ? h(SvgIcon, { name: agents.value.find((agent) => agent.id === ev.authorId)?.iconId ?? DEFAULT_AGENT_ICON })
          : name.charAt(0) }) : null,
          h('div', { class: 'sp-msg-body' }, [
            h('div', { class: 'sp-msg-name' }, name),
            ev.replyTo ? quoteBlock(ev.replyTo) : null,
            h('div', {
              class: `sp-bubble${ev.authorKind === 'agent' && !ev.voided && !isFlow ? ' agent' : ''}`,
              onClick: (event: MouseEvent) => {
                const clicked = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('a') : null
                if (clicked && ev.authorKind === 'agent' && !ev.voided && clicked.hash.startsWith('#teamspace-agent?')) {
                  const action = new URLSearchParams(clicked.hash.slice('#teamspace-agent?'.length))
                  const targetId = action.get('to')
                  const task = action.get('task')
                  if (targetId && task) {
                    event.preventDefault()
                    runAgentAction(targetId, task, ev.authorId ?? '')
                    return
                  }
                }
                const link = event.target instanceof Element
                  ? event.target.closest<HTMLAnchorElement>('a[href^="#space-event-"]') : null
                if (!link) return
                event.preventDefault()
                scrollToEvent(link.hash.slice('#space-event-'.length))
              },
            }, [bubble]),
            ev.authorKind === 'agent' && !ev.voided
              ? renderCitationModule(eventCitations(ev), h, scrollToEvent)
              : null,
            decision
              ? h(ElAlert, {
                  title: decision.title,
                  description: accessGuidance
                    ? `${decision.question}\n${accessGuidance}`
                    : decision.question,
                  type: decision.type,
                  showIcon: true,
                  closable: false,
                })
              : null,
            canDecide && decision && !ev.voided
              ? h(ElSpace, {}, {
                  default: () => [
                    h(ElButton, {
                      type: 'primary',
                      onClick: () => openDecision(ev.id, 'pass', '通过该回复'),
                    }, { default: () => '通过' }),
                    h(ElDropdown, {
                      trigger: 'click',
                      onCommand: (action: DecisionAction) => {
                        const selected = decisionActions.find((item) => item.action === action)
                        if (selected) openDecision(ev.id, action, selected.label)
                      },
                    }, {
                      default: () => h(ElButton, {}, { default: () => '其他处理' }),
                      dropdown: () => decisionActions.filter((item) => item.action !== 'pass').map((item) =>
                        h(ElDropdownItem, { key: `${ev.id}-inline-${item.action}`, command: item.action }, {
                          default: () => item.label,
                        })),
                    }),
                  ],
                })
              : null,
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
        let previousEvent: TEvent | null = null
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
          const elapsed = previousEvent ? Date.parse(ev.ts) - Date.parse(previousEvent.ts) : Number.POSITIVE_INFINITY
          const groupedWithPrevious = Boolean(previousEvent &&
            ev.kind === 'message' && !ev.voided && ev.authorKind !== 'system' &&
            previousEvent.kind === 'message' && !previousEvent.voided &&
            previousEvent.authorKind === ev.authorKind && previousEvent.authorId === ev.authorId &&
            previousEvent.ts.slice(0, 10) === ev.ts.slice(0, 10) && elapsed >= 0 && elapsed <= 120_000)
          nodes.push(messageRow(ev, fv, causalCounts, groupedWithPrevious))
          // Keep a streaming reply beside the message that triggered it. Putting
          // every live draft after the whole timeline made it look like it
          // belonged to the newest message, even when another Agent was active.
          for (const run of progressRunsForTimelineEvent(ev, events.value, progressRuns.value)) {
            if (hasVisibleLiveReply(run)) nodes.push(liveReplyRow(run))
          }
          previousEvent = ev
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
            searchResults.value !== null || searchQuery.value
              ? h(ElButton, { size: 'small', onClick: clearSearch }, { default: () => '清除' })
              : null,
            // 导出 Markdown：当前时间线 events 落成 .md 文件下载（纯前端）。
            h(ElButton, { class: 'sp-search-secondary', text: true, size: 'small', disabled: events.value.length === 0, onClick: exportMarkdown },
              { default: () => '导出' }),
            h(ElDropdown, {
              class: 'sp-search-secondary',
              trigger: 'click',
              onCommand: (command: string) => command === 'generate' ? void generateSummary() : exportMinutes(),
            }, {
              default: () => h(ElButton, { text: true, size: 'small', loading: summaryGenerating.value }, { default: () => '纪要' }),
              dropdown: () => [
                h(ElDropdownItem, { command: 'generate', disabled: !events.value.some((event) => !event.voided) || summaryGenerating.value }, {
                  default: () => '请会议记录官生成',
                }),
                h(ElDropdownItem, { command: 'export', disabled: !events.value.some((event) => !event.voided) }, {
                  default: () => '导出会议纪要',
                }),
              ],
            }),
            h(ElDropdown, {
              class: 'sp-mobile-search-actions',
              trigger: 'click',
              onCommand: (command: string) => command === 'generate' ? void generateSummary() :
                command === 'minutes' ? exportMinutes() : exportMarkdown(),
            }, {
              default: () => h(ElButton, { size: 'small' }, { default: () => '更多' }),
              dropdown: () => [
                h(ElDropdownItem, { command: 'markdown', disabled: events.value.length === 0 }, { default: () => '导出 Markdown' }),
                h(ElDropdownItem, { command: 'minutes', disabled: events.value.length === 0 }, { default: () => '导出会议纪要' }),
                h(ElDropdownItem, { command: 'generate', disabled: !events.value.some((event) => !event.voided) || summaryGenerating.value }, {
                  default: () => '请会议记录官生成',
                }),
              ],
            }),
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

      const pendingReplyStatus = (item: PendingReplyLite) => {
        const work = sessionWork.value
        if (work.activeSessionId === item.sessionId) {
          if (work.owners.includes('agent-inbox')) return '正在顺序消化此前消息与 Agent 记忆'
          if (work.owners.some((owner) => owner.startsWith('orchestrator:'))) return '当前会话的前序 Agent 任务仍在处理，此请求待接续'
          return 'Agent 正在处理当前会话，此请求等待接续'
        }
        const queued = work.queue.find((entry) => entry.sessionId === item.sessionId)
        if (queued) return `Agent 正在处理其他会话；本会话排队第 ${queued.position} 位`
        if (work.activeSessionId) return 'Agent 正在处理其他会话，等待队列同步'
        return '等待 Agent 顺序消化此前消息与记忆'
      }
      const pendingReplyLines = pendingReplies.value
        .filter((item) => item.sessionId === activeId.value)
        .filter((item) => !progressRuns.value.some((run) => run.sessionId === item.sessionId &&
          run.sourceEventId === item.sourceEventId && !['failed', 'cancelled', 'completed'].includes(run.phase)))
        .map((item) => {
          const names = item.mentions.map((id) => agents.value.find((agent) => agent.id === id)?.title ??
            members.value.find((member) => member.principalId === id)?.duty?.trim() ??
            members.value.find((member) => member.principalId === id)?.role).filter(Boolean)
          const name = [...new Set(names)].join('、') || '团队 Agent'
          return h('div', { key: item.key, class: 'sp-msg sp-msg-pending', role: 'status', 'aria-live': 'polite' }, [
            h(ElAvatar, { size: 32 }, { default: () => {
              const agentId = item.mentions.find((id) => agents.value.some((agent) => agent.id === id))
              return agentId ? h(SvgIcon, { name: agents.value.find((agent) => agent.id === agentId)?.iconId ?? DEFAULT_AGENT_ICON }) : name.charAt(0)
            } }),
            h('div', { class: 'sp-msg-body' }, [
              h('div', { class: 'sp-msg-name' }, name),
              h('div', { class: 'sp-bubble agent sp-pending-bubble' }, [
                h('span', { class: 'sp-pending-label' }, pendingReplyStatus(item)),
                h(ElText, { size: 'small', type: 'info' }, {
                  default: () => `已等待 ${elapsedLabel(item.createdAt)}`,
                }),
                h('span', { class: 'sp-typing-dots', 'aria-hidden': 'true' }, [
                  h('i'), h('i'), h('i'),
                ]),
              ]),
            ]),
          ])
        })
      const liveProgressRows = progressRuns.value
        .filter((run) => run.sessionId === activeId.value && !progressRunHasTimelineAnchor(run, events.value))
        .map((run) => h('div', { key: `live-run-${run.runId}`, class: 'sp-msg has-progress' }, [
          h(ElAvatar, { size: 32 }, { default: () => h(SvgIcon, { name: agents.value.find((agent) => agent.id === run.agentId)?.iconId ?? DEFAULT_AGENT_ICON }) }),
          h('div', { class: 'sp-msg-body' }, [
            h('div', { class: 'sp-msg-name' }, `${run.title} · ${run.phase === 'completed' ? '已完成' : run.phase === 'failed' ? '执行失败' : run.phase === 'cancelled' ? '已取消' : '正在工作'}`),
            h(ElCollapse, progressCollapseProps(run.runId), {
              default: () => h(ElCollapseItem, { name: run.runId, class: 'sp-progress-item' }, {
                title: () => progressStageSummary(run),
                default: () => h(ElSpace, { direction: 'vertical', fill: true, size: 4 }, {
                  default: () => [
                    progressTimeline(run.steps, `${run.runId}-live`, run.phase),
                    progressPreview(run, `${run.runId}-live-stream`),
                  ],
                }),
              }),
            }),
          ]),
        ]))
      // If the trigger is outside the loaded timeline, retain a standalone
      // fallback. Anchored streams are rendered immediately after their trigger.
      const liveStreamRows = progressRuns.value
        .filter((run) => hasVisibleLiveReply(run) && !progressRunHasTimelineAnchor(run, events.value))
        .map(liveReplyRow)
      // 人类「正在输入」行（AI 行之上）：3s 内有 typing 帧才显示。
      const humanTypingLine = humanTyping.value.name
        ? h(ElRow, { justify: 'center', key: 'human-typing' }, {
            default: () => h(ElText, { size: 'small', type: 'info' },
              { default: () => `${humanTyping.value.name} 正在输入…` }),
          })
        : null

      const sessionListView = resolveLoadView(
        sessionsLoading.value, sessionsLoadFailed.value, sessions.value.length > 0,
      )
      const emptyMark = (symbol: string | Component, className = '') => h('span', {
        class: ['sp-empty-mark', className],
        'aria-hidden': 'true',
      }, typeof symbol === 'string' ? symbol : h(symbol))
      const timelineView = resolveLoadView(
        timelineLoadingSessionId.value === activeId.value && timelineReadySessionId.value !== activeId.value,
        timelineFailedSessionId.value === activeId.value,
        events.value.length > 0,
      )
      const liveProgressDetail = () => {
        const activeRuns = progressRuns.value.filter((run) => run.sessionId === activeId.value &&
          !['completed', 'failed', 'cancelled'].includes(run.phase))
        if (activeRuns.length) {
          return activeRuns.map((run) =>
            `${run.title}：${progressStageSummary(run)} · 最近进度 ${elapsedLabel(run.at)}前`,
          ).join('；')
        }
        const pending = pendingReplies.value.filter((item) => item.sessionId === activeId.value)
        if (pending.length) return pending.map((item) =>
          `${pendingReplyStatus(item)} · 已等待 ${elapsedLabel(item.createdAt)}`,
        ).join('；')
        return 'Agent 运行状态仍保存在服务端，连接恢复后会自动同步。'
      }
      const connectionNotice = socketState.value === 'disconnected'
          ? h(ElAlert, {
              class: 'sp-live-connection', title: '实时连接中断', description: liveProgressDetail(),
              type: 'warning', showIcon: true, closable: false, role: 'status',
            })
          : socketState.value === 'degraded'
            ? h(ElAlert, {
                class: 'sp-live-connection', title: 'Agent 实时进度超过 45 秒未更新',
                description: `${liveProgressDetail()}。运行状态仍保存在服务端，新进度到达后会自动同步。`,
                type: 'warning', showIcon: true, closable: false, role: 'status',
              })
            : socketState.value === 'resyncing'
              ? h(ElAlert, {
                class: 'sp-live-connection', title: '连接已恢复，正在同步消息与 Agent 当前阶段…',
                  type: 'info', showIcon: true, closable: false, role: 'status',
                })
              : null
      const hasConversationMessages = events.value.some((ev) => ev.kind === 'message')
      const showCenteredEmpty = searchResults.value === null && (
        !activeId.value || timelineView === 'loading' || timelineView === 'error' || !hasConversationMessages
      )
      const noActiveSession = !activeId.value && searchResults.value === null
      const messageArea = h('div', {
        class: [CENTERED, showCenteredEmpty ? 'sp-chat-empty' : '', noActiveSession ? 'sp-chat-empty--no-session' : ''],
      }, [
        searchResults.value !== null
          ? searchArea()
          : !activeId.value
            ? sessionListView === 'loading'
              ? h(ElEmpty, { description: '正在加载会话…', imageSize: 48 }, {
                  image: () => emptyMark('…', 'is-loading'),
                })
              : sessionListView === 'error'
                ? h(ElEmpty, { description: '会话暂时无法加载', imageSize: 48 }, {
                    image: () => emptyMark('!', 'is-error'),
                    default: () => h(ElButton, { type: 'primary', onClick: () => void load() }, { default: () => '重试' }),
                  })
                : h('section', { class: 'sp-chat-welcome' }, [
                    h('div', { class: 'sp-chat-welcome-mark', 'aria-hidden': 'true' }, h(ICONS.teamspace)),
                    h('span', { class: 'sp-chat-welcome-eyebrow' }, '团队协作空间'),
                    h('h2', '让讨论有清晰的下一步'),
                    h('p', '创建一场会议，邀请成员和 Agent 一起讨论；消息、分工和进度会留在同一个地方。'),
                    h(ElButton, {
                      type: 'primary',
                      onClick: () => void startNewMeeting(),
                    }, { default: () => '创建第一场会议' }),
                    h('span', { class: 'sp-chat-welcome-note' }, '已有会议可从左侧列表进入'),
                  ])
            : timelineView === 'loading'
              ? h(ElEmpty, { description: '正在加载会话消息…', imageSize: 48 }, {
                  image: () => emptyMark('…', 'is-loading'),
                })
              : timelineView === 'error'
                ? h(ElEmpty, { description: '消息暂时无法加载', imageSize: 48 }, {
                    image: () => emptyMark('!', 'is-error'),
                    default: () => h(ElButton, { type: 'primary', onClick: () => void load() }, { default: () => '重试' }),
                  })
                : events.value.length === 0
                  ? h('div', [
                      h(ElEmpty, { description: '还没有消息', imageSize: 48 }, {
                        image: () => emptyMark('···'),
                        default: () => h('span', { class: 'sp-empty-guidance' },
                          '在下方输入区发言；@成员可直接邀请 Agent 参与。'),
                      }),
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
                  : h('div', { class: ['sp-list', !hasConversationMessages ? 'sp-list--first-message' : ''] }, [
                      ...renderTimeline(),
                      !hasConversationMessages
                        ? h('div', { class: 'sp-chat-first-message' }, [
                            h('strong', '会议已准备好'),
                            h('span', '在下方输入区开始讨论；输入 @ 可邀请成员或 Agent 参与。'),
                            emptyChips().length
                              ? h(ElRow, { justify: 'center' }, {
                                  default: () => h(ElSpace, { wrap: true }, {
                                    default: () => emptyChips().map((chip) => h(ElButton, {
                                      key: chip, round: true, size: 'small',
                                      onClick: () => { onDraft(chip); inputEl.value?.focus() },
                                    }, { default: () => chip })),
                                  }),
                                })
                              : null,
                          ])
                        : null,
                      ...pendingReplyLines, ...liveProgressRows, ...liveStreamRows, humanTypingLine,
                    ]),
      ])

      // ── 协作面板：集中展示会话概览、成员、待办与活动，不暴露引擎诊断。
      const t = turn.value
      const queueSessions = [...new Map(sessionWork.value.queue.map((item) => [item.sessionId, item])).values()]
      const queueActiveRun = progressRuns.value.find((run) =>
        run.sessionId === sessionWork.value.activeSessionId &&
        !['completed', 'failed', 'cancelled'].includes(run.phase),
      )
      const contextSection = (title: string, count: string | null, content: VNodeChild, action?: VNodeChild) => h('section', {
        class: 'sp-context-section',
      }, [
        h('div', { class: 'sp-context-section-head' }, [
          h('span', { class: 'sp-context-section-title' }, title),
          action ?? (count ? h('span', { class: 'sp-context-section-count' }, count) : null),
        ]),
        content,
      ])
      const sessionInfo = () => {
        if (!activeSession.value) {
          const hasSessions = sessions.value.length > 0
          const loading = sessionListView === 'loading'
          const failed = sessionListView === 'error'
          return h('div', { class: 'sp-context-empty-state', 'aria-live': 'polite' }, [
            h('div', { class: 'sp-empty-mark' },
              loading ? '…' : failed ? '!' : hasSessions ? '↙' : '＋'),
            h('strong', loading ? '正在加载会议' : failed ? '会议暂时无法加载'
              : hasSessions ? '选择一个会议查看协作概览' : '先创建一场会议'),
            h('span', loading ? '会议信息加载后会显示在这里。' : failed ? '请重试后查看成员、待办和 Agent 进度。'
              : hasSessions
                ? '从左侧选择会议，查看成员、待办和 Agent 进度。'
                : '创建会议后，成员、待办和 Agent 进度会显示在这里。'),
            !loading && !failed
              ? h('div', { class: 'sp-context-preview' }, [
                  h('div', { class: 'sp-context-preview-head' }, '会议中可查看'),
                  ...[
                    ['成员与 Agent', '参与者与工作状态'],
                    ['待办进度', '分工与完成情况'],
                    ['会议动态', '最近讨论'],
                  ].map(([title, detail]) => h('div', { class: 'sp-context-preview-row', key: title }, [
                    h('span', { class: 'sp-context-preview-mark', 'aria-hidden': 'true' }),
                    h('span', { class: 'sp-context-preview-copy' }, [
                      h('strong', title),
                      h('span', detail),
                    ]),
                  ])),
                ])
              : null,
            failed
              ? h(ElButton, { text: true, type: 'primary', size: 'small', onClick: () => void load() }, {
                  default: () => '重试加载',
                })
              : null,
          ])
        }
        return h('div', { class: 'sp-context-overview' }, [
        h('section', { class: 'sp-context-summary' }, [
          h('div', { class: 'sp-context-summary-head' }, [
            h('div', { class: 'sp-context-session-title', title: activeSession.value?.title ?? '' },
              activeSession.value?.title ?? '未选择会话'),
            activeStatus
              ? h(ElTag, { size: 'small', type: activeStatus.tag }, { default: () => activeStatus.label })
              : null,
          ]),
          h('div', { class: 'sp-context-session-stats' }, [
            h('span', `${members.value.length} 位成员`),
            h('span', `${events.value.filter((event) => event.kind === 'message').length} 条消息`),
          ]),
          h('div', { class: 'sp-context-summary-actions' }, [
            h(ElButton, { text: true, size: 'small', onClick: scrollToBottom }, { default: () => '回到最新' }),
            h(ElButton, {
              text: true, size: 'small', disabled: !events.value.some((event) => !event.voided), onClick: exportMinutes,
            }, { default: () => '导出纪要' }),
          ]),
        ]),
        sessionWork.value.activeSessionId || queueSessions.length
          ? h('div', { class: 'sp-context-work-state', role: 'status', 'aria-label': 'Agent 处理队列' }, [
              h('span', { class: 'sp-context-live-dot' }),
              h('div', { class: 'sp-context-work-copy' }, [
                h('strong', sessionWork.value.activeSessionId
                  ? `正在处理：${sessions.value.find((item) => item.id === sessionWork.value.activeSessionId)?.title ?? sessionWork.value.activeSessionId}`
                  : `排队中 · ${queueSessions.length} 个会话`),
                queueActiveRun
                  ? h('span', `${queueActiveRun.title} · ${progressStageSummary(queueActiveRun)} · 最近进度 ${elapsedLabel(queueActiveRun.at)}前`)
                  : null,
              ]),
            ])
          : null,
        queueSessions.length
          ? h('div', { class: 'sp-context-queue' }, queueSessions.map((item) => h(ElButton, {
              key: `queue-${item.sessionId}`,
              text: true,
              size: 'small',
              class: 'sp-context-queue-item',
              onClick: () => { void router.replace({ query: { session: item.sessionId } }) },
            }, {
              default: () => `第 ${item.position} 位 · ${sessions.value.find((session) => session.id === item.sessionId)?.title ?? item.sessionId}`,
            })))
          : null,
        t?.state === 'chain'
          ? h('div', { class: 'sp-context-notice sp-context-notice--working' },
              `AI 协作中${t.delegatedTargets.length ? ` · ${t.delegatedTargets.join('、')} 正在处理` : ' · 等待 AI 回应'}`)
          : t?.state === 'static' && t.stopReason && t.stopReason !== 'completed'
            ? h('div', { class: 'sp-context-notice sp-context-notice--paused' }, userFacingPause(t.stopReason))
            : null,
        contextSection('成员', `${mentionCandidates().length}`, mentionCandidates().length
          ? h('div', {}, [
              (() => {
                const dri = members.value.find((member) => member.role === 'DRI')
                const driHuman = dri ? humans.value.find((item) => item.id === dri.principalId) : undefined
                const driName = dri
                  ? driHuman?.displayName || driHuman?.username || dri.duty?.trim() || dri.principalId
                  : ''
                return h(ElAlert, {
                  title: dri ? `当前 DRI：${driName}（${dri.principalId}）` : '当前未单独指派 DRI',
                  description: dri
                    ? '只有这个 DRI 账号登录后，Agent 回复卡片下方才显示「通过」和「其他处理」；消息「⋯」菜单里没有决策入口。成员 ID 用来区分名称相近的不同账号。'
                    : '没有专属 DRI 时，群主可直接在 Agent 回复卡片下方选择「通过」或「其他处理」。如需指定专属 DRI，请从会话「⋯」→「成员 / 角色管理」将一名人类成员设为 DRI。成员 ID 用来区分名称相近的不同账号。',
                  type: dri ? 'warning' : 'info',
                  showIcon: true,
                  closable: false,
                })
              })(),
              h('div', { class: 'sp-context-members' }, mentionCandidates().map((m) => {
              const ag = agents.value.find((a) => a.id === m.principalId)
              const human = humans.value.find((item) => item.id === m.principalId)
              const name = ag?.title || human?.displayName || human?.username || m.duty?.trim() || m.role
              const status = ag
                ? ag.status === 'working' ? '工作中' : ag.status === 'done' ? '刚完成' : '空闲'
                : m.role === '群主' ? '会议创建者' : m.role === 'DRI' ? '当前 DRI' : m.role === '成员' ? '团队成员' : m.role
              const identityStatus = ag ? status : `${status} · ${m.principalId}`
              return h(ElButton, {
                key: m.principalId,
                text: true,
                class: 'sp-context-member',
                title: `${name} · ${identityStatus} · 点击 @ 提及`,
                onClick: () => { insertMention(m.principalId); inputEl.value?.focus() },
              }, {
                default: () => [
                  h(ElAvatar, { size: 30, class: 'sp-context-avatar' }, { default: () => ag
                    ? h(SvgIcon, { name: ag.iconId ?? DEFAULT_AGENT_ICON })
                    : name.charAt(0) }),
                  h('span', { class: 'sp-context-member-copy' }, [
                    h('span', { class: 'sp-context-member-name' }, name),
                    h('span', { class: 'sp-context-member-role' }, identityStatus),
                  ]),
                  h('span', { class: 'sp-context-mention-mark', 'aria-hidden': 'true' }, '@'),
                ],
              })
            }))
            ])
          : h('div', { class: 'sp-context-empty' }, '暂无可提及的会话成员')),
        contextSection('待办', `${todos.value.filter((todo) => !todo.done).length} 项未完成`, h('div', { class: 'sp-context-todos' }, [
          todos.value.length
            ? todos.value.slice().sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map((td) => h('div', {
                key: `todo-${td.id}`,
                class: `sp-context-todo${td.done ? ' is-done' : ''}`,
              }, [
                h(ElCheckbox, {
                  modelValue: td.done,
                  'onUpdate:modelValue': (value: boolean | string | number) => void updateTodo(td, Boolean(value)),
                  disabled: closed.value,
                  label: td.text,
                }),
                !closed.value ? h(ElButton, {
                  text: true,
                  size: 'small',
                  'aria-label': `删除待办：${td.text}`,
                  title: `删除待办：${td.text}`,
                  onClick: () => void removeTodo(td),
                }, { default: () => '删除' }) : null,
              ]))
            : h('div', { class: 'sp-context-empty' }, '还没有待办'),
          !closed.value ? h(ElSpace, { class: 'sp-context-todo-add' }, {
            default: () => [
              h(ElInput, {
                modelValue: todoDraft.value,
                'onUpdate:modelValue': (value: string) => { todoDraft.value = value },
                placeholder: '添加团队待办…',
                maxlength: 500,
                showWordLimit: true,
                onKeydown: (event: KeyboardEvent) => {
                  if (event.key === 'Enter') { event.preventDefault(); void saveTodo() }
                },
              }),
              h(ElButton, { type: 'primary', disabled: !todoDraft.value.trim(), onClick: () => void saveTodo() }, {
                default: () => '添加',
              }),
            ],
          }) : null,
        ])),
        contextSection('最近讨论', null, (() => {
          const recentMessages = events.value
            .filter((event) => event.kind === 'message' && !event.voided)
            .slice(-3)
            .reverse()
          return recentMessages.length
            ? h('div', recentMessages.map((event) => {
                const author = activityAuthorLabel(event.authorId)
                const text = event.authorKind === 'agent' ? visibleAgentReply(event.text) : event.text
                const readableText = displayMentionsInText(text)
                const preview = readableText.length > 96 ? `${readableText.slice(0, 96)}…` : readableText
                return h('article', { key: `overview-recent-${event.id}`, class: 'sp-activity-item' }, [
                  h('div', { class: 'sp-activity-heading' }, [
                    h('span', { class: 'sp-activity-kind' }, author),
                    h('time', { class: 'sp-activity-time', dateTime: event.ts }, formatTime(event.ts)),
                  ]),
                  h(ElButton, {
                    text: true,
                    class: 'sp-activity-description',
                    title: `跳转到第 ${event.seq} 条消息`,
                    onClick: () => scrollToEvent(event.id),
                  }, { default: () => preview }),
                ])
              }))
            : h('div', { class: 'sp-context-empty' }, '讨论开始后会显示最近消息')
        })(), h(ElButton, {
          text: true,
          size: 'small',
          onClick: () => { panelTab.value = 'activity' },
        }, { default: () => '查看全部动态' })),
        invitableAgents().length ? contextSection('邀请 Agent', null,
          h('div', { class: 'sp-context-invite' }, [
              h(ElButton, {
                text: true,
                size: 'small',
                class: 'sp-context-invite-toggle',
                disabled: !activeId.value || closed.value || invitingAgent.value,
                onClick: () => { inviteOpen.value = !inviteOpen.value },
              }, { default: () => inviteOpen.value ? '取消' : '＋ 添加 Agent' }),
              inviteOpen.value
                ? h('div', { class: 'sp-context-invite-form' }, [
                    h(ElSelect, {
                      modelValue: inviteAgentId.value,
                      'onUpdate:modelValue': (value: string) => { inviteAgentId.value = value },
                      placeholder: '选择团队 Agent',
                      disabled: !activeId.value || closed.value || invitingAgent.value,
                      clearable: true,
                    }, {
                      default: () => invitableAgents().map((agent) => h(ElOption, {
                        key: agent.id, label: agent.title, value: agent.id,
                      }, { default: () => h('span', { class: 'sp-agent-menu-item' }, [h(SvgIcon, { name: agent.iconId ?? DEFAULT_AGENT_ICON }), h('span', agent.title)]) })),
                    }),
                    h(ElButton, {
                      type: 'primary',
                      disabled: !activeId.value || closed.value || !inviteAgentId.value,
                      loading: invitingAgent.value,
                      onClick: () => void inviteSelectedAgent(),
                    }, { default: () => '邀请' }),
                  ])
                : null,
            ]),
        ) : null,
      ])
      }
      // 活动日志消费会话事件与 runtime 写入的脱敏 toolCalls；事件经同一 socket
      // 实时送达。Agent 上下文层会过滤这些人类专属过程事件。
      const activityLog = () => {
        const activityEvents = events.value.slice().reverse()
        const loadedEvents = activityEvents.slice(0, activityLimit.value)
        const visibleEvents = groupActivityEvents(loadedEvents)
        const liveRuns = progressRuns.value.filter((run) =>
          run.sessionId === activeId.value &&
          !['completed', 'failed', 'cancelled'].includes(run.phase) &&
          !events.value.some((ev) => ev.authorKind === 'agent' && ev.authorId === run.agentId &&
            new Set([ev.sourceEventId, ...(ev.sourceEventIds ?? [])].filter(Boolean)).has(run.sourceEventId)))
        return events.value.length || liveRuns.length
          ? h(ElSpace, { direction: 'vertical', fill: true, size: 8, class: 'sp-activity-feed' }, {
            default: () => [
              ...liveRuns.map((run) => h('div', {
                key: `activity-run-${run.runId}`,
                class: 'sp-activity-live',
              }, [
                h('span', { class: 'sp-context-live-dot' }),
                h('div', { class: 'sp-activity-live-copy' }, [
                  h('div', { class: 'sp-activity-live-heading' }, [
                    h('strong', run.title),
                    h('span', '正在处理'),
                  ]),
                  h('div', { class: 'sp-activity-description' }, run.steps.at(-1)?.label ?? '正在准备'),
                ]),
              ])),
              ...visibleEvents.map(({ event: ev, count: repeatCount }) => {
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
                const calls = (ev.toolCalls ?? []).filter((call) =>
                  call.name !== 'agent.worklog' && call.name !== 'agent.reply.outcome')
                const summary = ev.voided ? '消息已撤回' : displayMentionsInText(ev.text)
                const preview = summary.length > 140 ? `${summary.slice(0, 140)}…` : summary
                const author = activityAuthorLabel(ev.authorId)
                return h('article', { key: `activity-${ev.id}`, class: 'sp-activity-item' }, [
                    h('div', { class: 'sp-activity-heading' }, [
                      h(ElAvatar, { size: 22, class: 'sp-activity-avatar' }, { default: () => ev.authorKind === 'agent'
                        ? h(SvgIcon, { name: agents.value.find((agent) => agent.id === ev.authorId)?.iconId ?? DEFAULT_AGENT_ICON })
                        : author.charAt(0) || '系' }),
                      h(ElButton, {
                        text: true, type: 'primary', size: 'small', class: 'sp-activity-meta',
                        title: `跳转到第 ${ev.seq} 条消息`, onClick: jumpToEvent,
                      }, { default: () => author }),
                      h('span', { class: 'sp-activity-sequence' }, `#${ev.seq}`),
                      repeatCount > 1 ? h('span', { class: 'sp-activity-repeat' }, `×${repeatCount}`) : null,
                      h('time', { class: 'sp-activity-time', dateTime: ev.ts }, formatTime(ev.ts)),
                    ]),
                    h('div', {
                      class: 'sp-activity-description',
                      title: summary,
                      role: 'button',
                      tabindex: 0,
                      'aria-label': `跳转到第 ${ev.seq} 条消息：${preview}`,
                      onClick: jumpToEvent,
                      onKeydown: (event: KeyboardEvent) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault()
                          jumpToEvent()
                        }
                      },
                    }, [
                      h('span', { class: 'sp-activity-kind' }, `${activityKindLabel(ev.kind)} · `),
                      preview,
                    ]),
                    ...calls.map((call, i) => {
                      const outcome = call.err ? `失败：${call.err}` : call.result ? `结果：${call.result}` : '已调用'
                      const shortOutcome = outcome.length > 140 ? `${outcome.slice(0, 140)}…` : outcome
                      return h('div', { key: `${ev.id}-tool-${i}`, class: 'sp-activity-tool' }, [
                        h('span', { class: 'sp-activity-tool-name' }, call.name),
                        h('span', { class: call.err ? 'sp-activity-tool-result is-error' : 'sp-activity-tool-result', title: outcome }, shortOutcome),
                      ])
                    }),
                  ])
              }),
              activityEvents.length > loadedEvents.length
                ? h(ElButton, {
                    text: true,
                    class: 'sp-activity-load-more',
                    onClick: () => { activityLimit.value += 100 },
                  }, { default: () => `加载更早活动 · 还有 ${activityEvents.length - loadedEvents.length} 条` })
                : null,
            ],
          })
          : h('div', { class: 'sp-context-empty sp-context-empty--activity' }, '还没有活动记录')
      }
      const panelCard = activeSession.value
        ? h(ElTabs, {
            modelValue: panelTab.value,
            'onUpdate:modelValue': (value: string) => { panelTab.value = value },
          }, {
            default: () => [
              h(ElTabPane, { label: '概览', name: 'info' }, { default: sessionInfo }),
              h(ElTabPane, { label: `活动 (${events.value.length})`, name: 'activity' }, { default: activityLog }),
            ],
          })
        : sessionInfo()
      const collabPanel = () => panelOpen.value
        ? h('aside', { id: 'space-context-sidebar', class: 'right-sidebar', 'aria-label': '协作面板' }, [
            h('div', { class: 'sp-context-sidebar-header' }, [
              toggleSidebar('right'),
              h('span', { class: 'sp-context-sidebar-title' }, '协作面板'),
            ]),
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

      const ElPopconfirm = resolveComponent('el-popconfirm') as unknown as string
      const removeStagingEntry = async (entry: StagingEntry) => {
        if (!activeId.value) return
        try {
          const response = await fetch(`${getApiBase()}/api/sessions/${encodeURIComponent(activeId.value)}/staging/${entry.seq}`, {
            method: 'DELETE',
            headers: { authorization: `Bearer ${getToken()}` },
          })
          const body = await response.json().catch(() => ({})) as { error?: string; detail?: string }
          if (response.status === 401) return unauthed()
          if (!response.ok) {
            showReply(body.detail || `删除暂存条目失败（${body.error || response.status}）`, false)
            return
          }
          staging.value = staging.value.filter((item) => item.id !== entry.id)
          showReply(`已删除暂存条目 #${entry.seq}`, true)
        } catch {
          showReply(userFacingFailure('删除暂存条目'), false)
        }
      }

      // 只有作者本人可以删除遗留暂存条目，并在执行前二次确认。
      const stagingLine = (e: StagingEntry) => h('span', { key: e.id }, [
        h(ElTag, { size: 'large', type: 'info' },
          { default: () => `#${e.seq} ${authorLabel(e.authorId, members.value)}：${e.text}` }),
        e.authorId === me.value?.id
          ? h(ElPopconfirm, {
              title: `删除暂存条目 #${e.seq}？`,
              confirmButtonText: '删除',
              cancelButtonText: '取消',
              onConfirm: () => void removeStagingEntry(e),
            }, {
              reference: () => h(IconBtn, {
                icon: 'times-full',
                label: `删除暂存条目 #${e.seq}`,
              }),
            })
          : null,
      ])

      // ── composer 悬浮卡片（贴底居中；已结束会话禁用）────────────────────
      const replySnapshot = replyTo.value
      const composer = activeId.value ? h('div', [
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
              return h('div', { key: 'quick-replies', class: `sp-quick-replies-wrap${quickRepliesHaveMore.value ? ' has-more' : ''}${quickRepliesCanGoBack.value ? ' can-go-back' : ''}` }, [
                h('div', { class: 'sp-quick-replies-viewport', onScroll: syncQuickRepliesOverflow }, [
                  h(ElSpace, { wrap: true, size: 4, class: 'sp-quick-replies-track' }, {
                    default: () => replies.map((text) => h(ElButton, {
                      key: text, round: true, size: 'small', disabled: sending.value,
                      title: '填入草稿并引用最近的 Agent 回复，可编辑后发送',
                      onClick: () => chooseQuickReply(text),
                    }, { default: () => text })),
                  }),
                ]),
                quickRepliesHaveMore.value || quickRepliesCanGoBack.value ? h(ElButton, {
                  text: true,
                  circle: true,
                  class: 'sp-quick-replies-next',
                  'aria-label': quickRepliesHaveMore.value ? '查看更多快捷回复' : '返回前面的快捷回复',
                  title: quickRepliesHaveMore.value ? '查看更多快捷回复' : '返回前面的快捷回复',
                  onClick: (event: MouseEvent) => {
                    const track = (event.currentTarget as HTMLElement).parentElement?.querySelector('.sp-quick-replies-viewport')
                    const step = Math.max(96, (track?.clientWidth ?? 0) * 0.5)
                    track?.scrollBy({ left: quickRepliesHaveMore.value ? step : -step, behavior: 'smooth' })
                  },
                }, { default: () => h(KIcon, { name: quickRepliesHaveMore.value ? 'chevron-right' : 'chevron-left' }) }) : null,
              ])
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
              placeholder: closed.value ? '会话已结束，不能继续发言' : '输入消息 · @提及成员',
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
                h('span', { key: 'composer-hint', class: 'sp-composer-hint' }, [
                  h('kbd', 'Enter'), h('span', '发送'),
                  h('span', { class: 'sp-composer-hint-separator', 'aria-hidden': 'true' }, '·'),
                  h('kbd', 'Shift+Enter'), h('span', '换行'),
                ]),
                h(ElButton, {
                  key: 'send-btn', class: 'sp-send-icon',
                  type: 'primary', loading: sending.value, disabled: closed.value,
                  'aria-label': '发送消息',
                  title: '发送（Enter）',
                  onClick: () => void sendText(draft.value),
                }, { default: () => [h('svg', {
                      viewBox: '0 0 24 24', width: 17, height: 17,
                      fill: 'none', stroke: 'currentColor', 'stroke-width': 2.4,
                      'stroke-linecap': 'round', 'stroke-linejoin': 'round',
                    }, [
                      h('path', { d: 'M12 19V6' }),
                      h('path', { d: 'M5.5 12.5 12 5.5l6.5 7' }),
                    ]), h('span', { class: 'sp-send-label' }, '发送')] }),
              ],
            }),
            ...failureNotices.value.map((notice) => h(ElAlert, {
              key: notice.id,
              title: notice.message,
              type: 'error',
              showIcon: true,
              closable: true,
              onClose: () => {
                failureNotices.value = dismissFailureNotice(failureNotices.value, notice.id)
              },
            })),
            successReply.value ? h('span', [
              h(ElTag, { size: 'small', type: 'success' }, { default: () => '回执' }),
              h('span', ` ${successReply.value}`),
              h(IconBtn, { icon: 'times-full', label: '关闭回执', onPress: () => { successReply.value = '' } }),
            ]) : null,
            // 暂存条目只在非空时显示（IM 化：主路径直达时间线，暂存是可选路径）。
            staging.value.length ? staging.value.map(stagingLine) : null,
          ],
        }),
        ]),
      ]) : null

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
            ? h('aside', { id: 'space-session-sidebar', class: 'page-sidebar', 'aria-label': '会话列表' }, [
                h('div', { class: 'sp-session-sidebar-toggle' }, [toggleSidebar('left')]),
                h(KSlot, { name: 'space-teamspace-sidebar', single: true }),
              ])
            : null,
          h('div', { class: 'content-area' }, [
            activeId.value ? searchBar : null,
            connectionNotice,
            h('div', { class: 'content-body' }, [
              h(ElScrollbar, { ref: scrollbar }, { default: () => messageArea }),
              // 「回到最新」悬浮按钮：偏离底部时出现。
              !nearBottom.value && events.value.length
                ? h(ElButton, {
                    type: 'primary', size: 'small', onClick: scrollToBottom,
                    class: 'sp-back-to-latest',
                  }, { default: () => '回到最新' })
                : null,
            ]),
            composer,
          ]),
          collabPanel(),
          h(ElDialog, {
            modelValue: decisionDraft.value !== null,
            'onUpdate:modelValue': (visible: boolean) => { if (!visible && !decisionSubmitting.value) decisionDraft.value = null },
            title: decisionDraft.value ? `处理 Agent 回复 · ${decisionDraft.value.label}` : '处理 Agent 回复',
            width: '520px',
            closeOnClickModal: false,
            closeOnPressEscape: !decisionSubmitting.value,
          }, {
            default: () => [
              h(ElText, { type: 'info' }, { default: () => '操作会记录在会话中；撤回、否决和重做会处理该回复产生的后续影响。' }),
              decisionDraft.value?.action !== 'pass'
                ? h(ElInput, {
                    modelValue: decisionReason.value,
                    'onUpdate:modelValue': (value: string) => { decisionReason.value = value },
                    type: 'textarea',
                    rows: 4,
                    maxlength: 1000,
                    showWordLimit: true,
                    placeholder: '说明原因或新的处理要求',
                  })
                : null,
            ],
            footer: () => h(ElSpace, {}, {
              default: () => [
                h(ElButton, { disabled: decisionSubmitting.value, onClick: () => { decisionDraft.value = null } }, {
                  default: () => '取消',
                }),
                h(ElButton, {
                  type: 'primary',
                  loading: decisionSubmitting.value,
                  disabled: decisionDraft.value?.action !== 'pass' && !decisionReason.value.trim(),
                  onClick: () => void submitDecision(),
                }, { default: () => decisionSubmitting.value ? '处理中…' : '确认操作' }),
              ],
            }),
          }),
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
  if (window.location.pathname === '/') {
    window.location.replace('/teamspace')
    return
  }
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
  ctx.client.router.page({ path: '/teamspace/memories', name: '记忆库', icon: MEMORY_PAGE_ICON, order: 902, component: AgentMemoryPage })
  ctx.client.router.page({ path: '/teamspace/workspaces', name: 'Agent 工作区', icon: WORKSPACE_PAGE_ICON, order: 903, component: AgentWorkspacePage })
}
