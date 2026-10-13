/// <reference types="vite/client" />

// 左侧会话栏（客户端）—— IM 化改造（2026-09-30，微信式聊天列表）。
//
// 结构（本次拍板）：置顶「新会议」主动作（el-dialog：标题输入 + 受邀成员
// 多选 + Agent 多选，确定 = createGroup）→ 会话列表改微信式横向行
// （el-avatar 首字 + 标题 + 状态 tag + HH:mm 时间 + 悬停揭示操作按钮：
// 结束会议 / 邀请 / 移除成员）→ 底部「当前身份」= 登录用户（me(token)）。
// 邀请与移除成员各用 el-dialog + 多选确认。
//
// 鉴权：RPC 首参 token（localStorage 'space_token'，TOKEN_KEY 常量，与
// /login 页、teamspace 页共用口径）；token 为空 → 列表区出 el-empty
// 「请先登录」+ 跳 '/login' 按钮；RPC 返回 null（无效 token）同样跳登录。
//
// 选中态走 URL：?session=<id>（useRouter.replace 写、useRoute 读）——页面与
// 本组件分属两个 entry，URL 是唯一同步点（原样保留）。
//
// 铁律 1：组件只用外壳全局注册的 el-* / k-*（零 import element-plus），
// 零样式文件、零内联样式、零令牌定义。
import { computed, defineComponent, h, nextTick, onMounted, onUnmounted, ref, resolveComponent, watch } from 'vue'
import { useRoute, useRouter, useRpc, useContext } from '@cordisjs/client'
import { userFacingFailure } from 'space-client-ui-shared/client/errors.ts'
import { resolveLoadView } from 'space-client-ui-shared/client/load-state.ts'
import 'space-client-ui-shared/client/im.css'

/** 会话的客户端视图（列表需要的列；形状 = seam Session 的子集）。 */
interface SessionRow {
  id: string
  title: string
  status: string
  updatedAt: string
}

/** Agent 名册条目（新会议邀请 Agent 的多选数据源）。 */
interface RosterRow {
  id: string
  title: string
}

/** 人类用户条目（「邀请成员」多选的数据源）。 */
interface HumanRow {
  id: string
  username: string
  displayName: string
}

interface MemberRow {
  sessionId: string
  principalId: string
  role: string
  status: string
  duty: string
  joinedAt: string
  leftAt: string | null
}

/** 当前登录用户（me(token) 的返回）。 */
interface MeRow {
  id: string
  username: string
  displayName: string
}

/** 最近一条消息摘要（summaries RPC 的行；authorName 服务端已解析好）。 */
interface SummaryRow {
  sessionId: string
  text: string
  ts: string
  authorKind: string
  /** 事件作者 id（系统事件为 null）。 */
  authorId: string | null
  /** 作者显示名（系统事件 = '系统'；由服务端按会话名册解析）。 */
  authorName: string
  /** 未读数（本人消息以外的 message 事件晚于客户端已读时刻；B1）。 */
  unreadCount: number
  /** @我 计数（mentions 命中本人 或 正文 @用户名/显示名；A5）。 */
  mentionsCount: number
}

/** 登录 token 的 localStorage 键（/login 页与各 RPC 共用）。 */
const TOKEN_KEY = 'space_token'
const getToken = () => localStorage.getItem(TOKEN_KEY) ?? ''
/** RPC 返回 {error:'forbidden', detail} 的判定（群权限拒绝等结构化错误）。 */
const isForbidden = (r: unknown) =>
  typeof r === 'object' && r !== null && (r as { error?: string }).error === 'forbidden'
const isError = (r: unknown) =>
  typeof r === 'object' && r !== null && typeof (r as { error?: unknown }).error === 'string'
/** 每会话「已读时刻」的 localStorage 键前缀（未读红点 = lastTs > seen）。 */
const seenKey = (sid: string) => `space_seen_${sid}`
const getSeen = (sid: string) => Number(localStorage.getItem(seenKey(sid)) ?? 0)
const markSeen = (sid: string) => localStorage.setItem(seenKey(sid), String(Date.now()))
const emptyMark = (symbol: string, className = '') => h('span', {
  class: ['sp-empty-mark', className],
  'aria-hidden': 'true',
}, symbol)

// 置顶 / 免打扰的 localStorage 键（跨包约定，teamspace 页逐字一致读取）。
/** 置顶会话：值为 sessionId 字符串数组。 */
const PINNED_KEY = 'space_pinned_sessions'
/** 免打扰会话：值为 sessionId 字符串数组（teamspace 页桌面通知读同一 key 静音）。 */
const MUTED_KEY = 'space_muted_sessions'
/** 从 localStorage 读 sessionId 数组（坏数据一律当空数组）。 */
const readIdList = (key: string): string[] => {
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? '[]')
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []
  } catch {
    return []
  }
}
/** 写回 sessionId 数组。 */
const writeIdList = (key: string, ids: string[]) => localStorage.setItem(key, JSON.stringify(ids))

/** updatedAt → HH:mm（zh-CN 当日时间）。 */
const hhmm = (iso: string) => {
  try {
    return new Date(iso).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
  } catch {
    return ''
  }
}

/** 最近更新在前。 */
const byUpdatedDesc = (a: SessionRow, b: SessionRow) => b.updatedAt.localeCompare(a.updatedAt)

const SessionsRail = defineComponent({
  name: 'SpaceSessionsRail',
  setup() {
    const rpc = useRpc<{
      me(token: string): Promise<MeRow | null>
      sessions(token: string): Promise<SessionRow[] | null>
      summaries(token: string, seen?: Record<string, number>): Promise<SummaryRow[] | null>
      members(token: string, sessionId: string): Promise<MemberRow[] | null>
      agentRoster(token: string): Promise<RosterRow[]>
      listHumans(token: string): Promise<HumanRow[]>
      createGroup(token: string, title: string, userIds: string[], agentIds: string[]): Promise<SessionRow | null>
      invite(token: string, sessionId: string, userIds: string[]): Promise<unknown>
      removeMember(token: string, sessionId: string, principalId: string): Promise<unknown>
      setMemberRole(token: string, sessionId: string, principalId: string, role: string): Promise<unknown>
      close(token: string, sessionId: string): Promise<SessionRow | null>
      rename(token: string, sessionId: string, title: string): Promise<SessionRow | { error: string; detail?: string } | null>
      logout(token: string): Promise<boolean | null>
    }>()
    const appCtx = useContext()
    const router = useRouter()
    const route = useRoute()

    const me = ref(null) as { value: MeRow | null }
    const sessions = ref([]) as { value: SessionRow[] }
    const sessionsLoaded = ref(false)
    const sessionsLoading = ref(true)
    const sessionsLoadFailed = ref(false)
    const roster = ref([]) as { value: RosterRow[] }
    const humans = ref([]) as { value: HumanRow[] }
    const creating = ref(false)
    const createError = ref('')
    const error = ref('')
    /** 悬停会话行 id（操作按钮只在悬停行揭示）。 */

    // 置顶 / 免打扰：本地 ref 副本 = localStorage 的镜像；开关即时写回并
    // 重新赋值 ref.value 触发响应（沿用本文件 ref.value 重赋值的既有风格）。
    const pinnedIds = ref(readIdList(PINNED_KEY)) as { value: string[] }
    const mutedIds = ref(readIdList(MUTED_KEY)) as { value: string[] }
    const isPinned = (sid: string) => pinnedIds.value.includes(sid)
    const isMuted = (sid: string) => mutedIds.value.includes(sid)
    /** 切换置顶：写 localStorage 后重赋 ref 触发重渲染。 */
    function togglePinned(sid: string) {
      const next = isPinned(sid)
        ? pinnedIds.value.filter((x) => x !== sid)
        : [...pinnedIds.value, sid]
      writeIdList(PINNED_KEY, next)
      pinnedIds.value = next
    }
    /** 切换免打扰：只静音桌面通知（teamspace 页读 key），不静音本栏未读红点。 */
    function toggleMuted(sid: string) {
      const next = isMuted(sid)
        ? mutedIds.value.filter((x) => x !== sid)
        : [...mutedIds.value, sid]
      writeIdList(MUTED_KEY, next)
      mutedIds.value = next
    }

    /** 「新会议」对话框：标题输入 + 受邀成员和 Agent 多选。 */
    const dialogOpen = ref(false)
    const newTitle = ref('')
    const renaming = ref(false)
    const renameError = ref('')
    const renameOpen = ref(false)
    const renameSessionId = ref('')
    const renameTitle = ref('')
    const selectedUsers = ref([]) as { value: string[] }
    const selected = ref([]) as { value: string[] }

    /** 「邀请成员」对话框（针对某个会话）。 */
    const inviteOpen = ref(false)
    const invitingMembers = ref(false)
    const inviteError = ref('')
    const inviteSessionId = ref('')
    const inviteUsers = ref([]) as { value: string[] }

    /** 「移除成员」对话框（针对某个会话，单选或直接按 id 确认）。 */
    const removeOpen = ref(false)
    const removeSessionId = ref('')
    const removeUserId = ref('')
    const managedMembers = ref([]) as { value: MemberRow[] }
    const membersLoading = ref(false)
    const membersLoadError = ref('')
    const roleDrafts = ref({}) as { value: Record<string, string> }

    /** 最近一条消息摘要：sessionId → {text, ts}（summaries RPC + socket 增量）。 */
    const lastMap = ref({}) as { value: Record<string, SummaryRow> }
    let socket: WebSocket | undefined
    let slowTimer: ReturnType<typeof setInterval> | undefined

    // ── Ctrl+K 快速切换会话（2026-10-01）────────────────────────────────
    const quickOpen = ref(false)
    const quickQuery = ref('')
    const quickIndex = ref(0)
    const quickInput = ref(null) as { value: HTMLInputElement | null }
    /** openOnes + closedOnes 合并、按 updatedAt 倒序（切换面板不分组，一列到底）。 */
    const allSessions = computed(() => [...openOnes.value, ...closedOnes.value].sort(byUpdatedDesc))
    /** 标题、最近发言人和最近消息内容都可命中（大小写不敏感），便于区分同名会议。 */
    const quickList = computed(() => {
      const q = quickQuery.value.trim().toLowerCase()
      return q ? allSessions.value.filter((s) => {
        const summary = lastMap.value[s.id]
        return `${s.title} ${summary?.authorName ?? ''} ${summary?.text ?? ''}`.toLowerCase().includes(q)
      }) : allSessions.value
    })
    function openQuickSwitch() {
      quickQuery.value = ''
      quickIndex.value = 0
      quickOpen.value = true
    }
    /** ⌘/Ctrl+K 切换面板；Esc 在面板开着时只关面板（不进输入框状态机）。 */
    function onGlobalKeydown(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        if (quickOpen.value) {
          quickOpen.value = false
          quickQuery.value = ''
        } else openQuickSwitch()
      } else if (e.key === 'Escape' && quickOpen.value) {
        quickOpen.value = false
        quickQuery.value = ''
        e.preventDefault()
      }
    }
    /** 打开后清过滤并自动聚焦输入框（dialog opened 回调 + nextTick 等 DOM 就绪）。 */
    function onQuickOpened() {
      quickQuery.value = ''
      quickIndex.value = 0
      void nextTick(() => { quickInput.value?.focus() })
    }
    /** 点选会话：select(id)（= 已读 + 改 URL）并关闭面板。 */
    function quickPick(id: string) {
      select(id)
      quickOpen.value = false
      quickQuery.value = ''
      quickIndex.value = 0
    }
    function navigateQuickList(event: KeyboardEvent) {
      if (!quickList.value.length) return
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        quickIndex.value = (quickIndex.value + 1) % quickList.value.length
      } else if (event.key === 'ArrowUp') {
        event.preventDefault()
        quickIndex.value = (quickIndex.value - 1 + quickList.value.length) % quickList.value.length
      } else if (event.key === 'Enter') {
        event.preventDefault()
        quickPick(quickList.value[quickIndex.value]?.id ?? quickList.value[0]!.id)
      }
    }

    /** 当前选中会话 = URL 上的 ?session=（页面负责在缺省时写入首个会话）。 */
    const activeId = computed(() => route.query.session ?? '')
    const openOnes = computed(() => sessions.value.filter((s) => s.status !== 'closed').sort(byUpdatedDesc))
    const closedOnes = computed(() => sessions.value.filter((s) => s.status === 'closed').sort(byUpdatedDesc))
    /** 置顶会话（组内同样按 updatedAt 排序），渲染时单独一组放最上面。 */
    const pinnedOnes = computed(() =>
      sessions.value.filter((s) => pinnedIds.value.includes(s.id)).sort(byUpdatedDesc))

    /** 未读判定（B1）：服务端计数（本人以外的消息晚于已读时刻）；当前打开、
     *  已结束、免打扰的会话一律不计 —— 红点只代表「真的有要看的」。 */
    const unread = (s: SessionRow) => {
      if (s.id === activeId.value || s.status === 'closed' || isMuted(s.id)) return false
      return (lastMap.value[s.id]?.unreadCount ?? 0) > 0 ||
        (!!lastMap.value[s.id] &&
          new Date(lastMap.value[s.id]!.ts).getTime() > getSeen(s.id) &&
          lastMap.value[s.id]!.authorKind === 'message' &&
          lastMap.value[s.id]!.authorId !== (me.value?.id ?? ''))
    }

    // ── 未读数进标签页标题（2026-10-01）：未读会话数 → document.title ────
    /** 未读会话总数（unread(s) 复用：lastMap + space_seen_<id>）。 */
    const totalUnread = computed(() => sessions.value.filter((s) => unread(s)).length)
    watch(totalUnread, (n) => {
      document.title = n > 0 ? `(${n}) 团队空间` : '团队空间'
    }, { immediate: true })

    /** 摘要文本（「作者： 文本」微信式；去换行、截 18 字）。
     *  作者名用服务端解析好的 authorName（系统事件即「系统」）。 */
    const humanizeMentions = (text: string) => text.replace(/@[^\s@]+/g, (token) => {
      const id = token.slice(1)
      if (['all', 'everyone', '所有人'].includes(id.toLowerCase())) return '@所有人'
      const human = humans.value.find((item) => item.id === id)
      if (human) return `@${human.displayName || human.username}`
      const agent = roster.value.find((item) => item.id === id)
      return agent ? `@${agent.title}` : token
    })
    const brief = (sid: string) => {
      const last = lastMap.value[sid]
      if (!last?.text) return '（还没有消息）'
      const oneLine = humanizeMentions(last.text).replaceAll(/\s+/g, ' ').trim()
      const body = oneLine.length > 18 ? `${oneLine.slice(0, 18)}…` : oneLine
      return `${last.authorName || '成员'}：${body}`
    }


    /** 登出：服务端删 token + 前端清 localStorage → 回登录页。 */
    async function doLogout() {
      try { await rpc.value.logout(getToken()) } catch { /* 幂等 */ }
      localStorage.removeItem(TOKEN_KEY)
      location.href = '/login'
    }

    async function load() {
      const token = getToken()
      const initialLoad = !sessionsLoaded.value
      if (initialLoad) sessionsLoading.value = true
      try {
        // seen 快照：全部本地已读时刻一并上报，服务端按它数未读（B1）。
        const seen: Record<string, number> = {}
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i)
          if (k?.startsWith('space_seen_')) seen[k.slice('space_seen_'.length)] = Number(localStorage.getItem(k) ?? 0)
        }
        const [list, sums] = await Promise.all([
          rpc.value.sessions(token),
          rpc.value.summaries(token, seen),
        ])
        if (list === null) return unauthed()
        sessions.value = list
        sessionsLoaded.value = true
        sessionsLoadFailed.value = false
        if (sums) {
          const map: Record<string, SummaryRow> = {}
          for (const s of sums) map[s.sessionId] = s
          lastMap.value = map
        }
        error.value = ''
      } catch {
        if (sessionsLoaded.value) error.value = userFacingFailure('会话栏加载')
        else sessionsLoadFailed.value = true
      } finally {
        if (initialLoad) sessionsLoading.value = false
      }
    }

    // ── 实时推送（IM 化）：socket 'space:event' 增量更新摘要与未读 ─────────
    function onSocketMessage(ev: MessageEvent) {
      try {
        const msg = JSON.parse(String(ev.data))
        if (msg?.type !== 'space:event') return
        // 推送的是完整 SessionEvent（含 authorId/authorKind）。
        const event = msg.body?.event as
          { sessionId: string; text: string; ts: string; authorId: string | null } | undefined
        if (!event?.sessionId) return
        // 轻量解析作者名：系统事件 →「系统」；当前用户 → 自己的显示名；
        // 人类名单能查到 → displayName；否则复用旧摘要同名作者的名字，兜底「成员」。
        const prev = lastMap.value[event.sessionId]
        const human = humans.value.find((u) => u.id === event.authorId)
        const authorName = !event.authorId
          ? '系统'
          : (event.authorId === me.value?.id
              ? me.value.displayName
              : ((human?.displayName ?? (prev?.authorId === event.authorId ? prev.authorName : '')) || '成员'))
        // 未读数增量（B1）：非本人消息 + 非当前会话 + 非免打扰 → +1；否则清零。
        // @我 计数同步增量（A5）：正文 @我用户名/显示名 → +1（服务端在下次
        // load() 用 mentions 数组给权威值，这里只做实时近似）。
        const isActive = event.sessionId === route.query.session
        const prevUnread = prev?.unreadCount ?? 0
        const bump = event.authorId !== me.value?.id && !isActive && !isMuted(event.sessionId)
        const atMeText = event.authorId !== me.value?.id && (() => {
          const t = (event.text || '').toLowerCase()
          const u = me.value?.username?.toLowerCase() ?? ''
          const d = me.value?.displayName?.toLowerCase() ?? ''
          return (u && t.includes(`@${u}`)) || (d && t.includes(`@${d}`))
        })()
        lastMap.value = {
          ...lastMap.value,
          [event.sessionId]: {
            sessionId: event.sessionId, text: event.text, ts: event.ts,
            authorKind: 'message', authorId: event.authorId, authorName,
            unreadCount: bump ? prevUnread + 1 : 0,
            mentionsCount: bump
              ? (prev?.mentionsCount ?? 0) + (atMeText ? 1 : 0)
              : 0,
          },
        }
      } catch {
        // 非法帧忽略。
      }
    }
    /** 慢速兜底轮询（会话新建/更名等 socket 不覆盖的变更；30s 一次）。 */
    function startSlowPoll() {
      slowTimer = setInterval(() => void load(), 30000)
    }

    /** 未登录：清空本地视图 + 跳登录页。已在 /login 时不跳（本组件挂在
     *  全部页面包括登录页 —— 否则会自己跳自己，死循环卡死登录页）。 */
    function unauthed() {
      sessions.value = []
      me.value = null
      if (location.pathname === '/login') return
      void router.replace({ path: '/login' })
      location.href = '/login'
    }

    /** Agent 名册与人类名单各只拉一次。 */
    async function loadMeta() {
      const token = getToken()
      try {
        roster.value = await rpc.value.agentRoster(token)
      } catch {
        roster.value = [] // 名册取不到 = 不展示多选（纯会议照常可开）
      }
      try {
        humans.value = await rpc.value.listHumans(token)
      } catch {
        humans.value = []
      }
    }

    function select(id: string) {
      markSeen(id) // 点开 = 已读（红点即灭）
      void router.replace({ query: { session: id } })
    }

    /** 打开「新会议」对话框（每次打开重置输入 = 上一轮的选择不残留）。 */
    function openDialog() {
      newTitle.value = ''
      selectedUsers.value = []
      selected.value = []
      createError.value = ''
      dialogOpen.value = true
    }

    // Teamspace entry points share the router query across page entries.
    watch(() => route.query.newMeeting, (value) => {
      if (value !== '1') return
      openDialog()
      void router.replace({ query: { ...route.query, newMeeting: undefined } })
    })

    /** 确定：createGroup(token, 标题(可空→''), 受邀成员, Agent)。
     *  成功后关对话框、刷新列表并选中新会话。 */
    async function create() {
      if (creating.value) return
      creating.value = true
      createError.value = ''
      try {
        const s = await rpc.value.createGroup(getToken(), newTitle.value.trim(), [...selectedUsers.value], [...selected.value])
        if (!s) return unauthed()
        dialogOpen.value = false
        await load()
        select(s.id)
      } catch {
        createError.value = userFacingFailure('新建会话')
      } finally {
        creating.value = false
      }
    }

    /** 邀请成员：invite(token, sessionId, userIds)。结构化拒绝（forbidden）直接进错误条。 */
    async function doInvite() {
      if (invitingMembers.value || !inviteSessionId.value || inviteUsers.value.length === 0) return
      invitingMembers.value = true
      inviteError.value = ''
      try {
        const r = await rpc.value.invite(getToken(), inviteSessionId.value, [...inviteUsers.value]) as unknown
        if (r === null) return unauthed()
        if (isError(r)) {
          inviteError.value = (r as { detail?: string }).detail ?? '邀请成员失败，请检查网络后重试。'
          return
        }
        inviteOpen.value = false
        inviteUsers.value = []
        inviteError.value = ''
      } catch {
        inviteError.value = userFacingFailure('邀请成员')
      } finally {
        invitingMembers.value = false
      }
    }

    /** 移除成员：removeMember(token, sessionId, principalId)。 */
    async function doRemove() {
      if (!removeUserId.value) return
      try {
        const r = await rpc.value.removeMember(getToken(), removeSessionId.value, removeUserId.value) as unknown
        if (r === null) return unauthed()
        if (isForbidden(r)) { error.value = (r as { detail: string }).detail; return }
        if (isError(r)) { error.value = (r as { detail?: string }).detail ?? '移除失败'; return }
        removeUserId.value = ''
        error.value = ''
        await loadManagedMembers()
      } catch {
        error.value = userFacingFailure('移除成员')
      }
    }

    async function loadManagedMembers() {
      membersLoading.value = true
      membersLoadError.value = ''
      try {
        const rows = await rpc.value.members(getToken(), removeSessionId.value)
        if (rows === null) return unauthed()
        managedMembers.value = rows
        roleDrafts.value = Object.fromEntries(managedMembers.value.map((member) => [member.principalId, member.role]))
      } catch {
        membersLoadError.value = userFacingFailure('读取会话成员')
      } finally {
        membersLoading.value = false
      }
    }
    async function openMemberManagement(sessionId: string) {
      removeSessionId.value = sessionId
      removeUserId.value = ''
      managedMembers.value = []
      membersLoadError.value = ''
      removeOpen.value = true
      await loadManagedMembers()
    }
    async function doSetMemberRole(row: MemberRow) {
      const role = roleDrafts.value[row.principalId]
      if (!role || role === row.role) return
      try {
        const r = await rpc.value.setMemberRole(getToken(), removeSessionId.value, row.principalId, role)
        if (r === null) return unauthed()
        if (isForbidden(r) || isError(r)) { error.value = (r as { detail?: string }).detail ?? '角色调整失败'; return }
        error.value = ''
        await loadManagedMembers()
      } catch { error.value = userFacingFailure('调整角色') }
    }

    /** 结束会议：close(token, sessionId)（幂等）。 */
    async function doClose(id: string) {
      try {
        const r = await rpc.value.close(getToken(), id) as unknown
        if (r === null) return unauthed()
        if (isForbidden(r)) { error.value = (r as { detail: string }).detail; return }
        await load()
      } catch {
        error.value = userFacingFailure('结束会话')
      }
    }

    function openRename(session: SessionRow) {
      renameSessionId.value = session.id
      renameTitle.value = session.title
      renameError.value = ''
      renameOpen.value = true
    }
    async function doRename() {
      if (!renameSessionId.value || !renameTitle.value.trim() || renaming.value) return
      renaming.value = true
      renameError.value = ''
      try {
        const result = await rpc.value.rename(getToken(), renameSessionId.value, renameTitle.value)
        if (result === null) return unauthed()
        if ('error' in result) { renameError.value = result.detail ?? '重命名失败，请重试。'; return }
        renameOpen.value = false
        error.value = ''
        await load()
      } catch { renameError.value = userFacingFailure('重命名会话') }
      finally { renaming.value = false }
    }

    onMounted(async () => {
      const token = getToken()
      if (!token) { unauthed(); return }
      try {
        me.value = await rpc.value.me(token)
        if (!me.value) return unauthed()
      } catch {
        return unauthed()
      }
      await load()
      await nextTick()
      document.querySelector('#space-session-sidebar .sp-rail-item.active')?.scrollIntoView({ block: 'nearest' })
      void loadMeta()
      // IM 化：socket 实时更新摘要/未读，替代 5s 轮询；断线重连全量刷新一次，
      // 另留 30s 慢速兜底（会话新建/更名等 socket 不覆盖的变更）。
      // client.socket 是 Vue ref（可能为 null）—— 取 .value 并守卫。
      const clientWithSocket = appCtx.client as typeof appCtx.client & { socket?: { value?: WebSocket } }
      const rawSocket = clientWithSocket.socket?.value
      socket = rawSocket && typeof rawSocket.addEventListener === 'function' ? rawSocket : undefined
      if (!socket) console.warn('[space] client.socket 不可监听（外壳版本差异），实时推送降级为手动刷新')
      socket?.addEventListener('message', onSocketMessage)
      socket?.addEventListener('open', () => { void load() })
      startSlowPoll()
      // Ctrl+K 快速切换会话：全局 keydown（组件卸载即移除）。
      window.addEventListener('keydown', onGlobalKeydown)
    })
    onUnmounted(() => {
      socket?.removeEventListener('message', onSocketMessage)
      clearInterval(slowTimer)
      window.removeEventListener('keydown', onGlobalKeydown)
      // 会话栏卸载：标签页标题恢复默认（未读前缀不再残留）。
      document.title = '团队空间'
    })

    // 当前打开的会话 = 已读（URL 驱动，页面切会话时红点即灭）。
    watch(activeId, (v) => { if (v) markSeen(String(v)) })

    /** 会话头像：用主题强调色与标题首字保持统一。 */
    const avatarOf = (s: { id: string; title: string }) => {
      // ElAvatar 在渲染闭包里才 resolve（resolveComponent 不能提前到 setup 体）。
      const ElAvatar = resolveComponent('el-avatar') as unknown as string
      const bare = s.title.replace(/^新会议\s*/, '') || s.title
      return h(ElAvatar, {
        size: 32,
        color: 'var(--accent)',
      }, { default: () => bare.charAt(0) || '会' })
    }

    return () => {
      const ElButton = resolveComponent('el-button') as unknown as string
      const ElAvatar = resolveComponent('el-avatar') as unknown as string
      const ElBadge = resolveComponent('el-badge') as unknown as string
      const ElDivider = resolveComponent('el-divider') as unknown as string
      const ElEmpty = resolveComponent('el-empty') as unknown as string
      const ElAlert = resolveComponent('el-alert') as unknown as string
      const ElSpace = resolveComponent('el-space') as unknown as string
      const ElText = resolveComponent('el-text') as unknown as string
      const ElTag = resolveComponent('el-tag') as unknown as string
      const ElDropdown = resolveComponent('el-dropdown') as unknown as string
      const ElDropdownItem = resolveComponent('el-dropdown-item') as unknown as string
      const ElSelect = resolveComponent('el-select') as unknown as string
      const ElOption = resolveComponent('el-option') as unknown as string
      const ElDialog = resolveComponent('el-dialog') as unknown as string
      const ElInput = resolveComponent('el-input') as unknown as string
      const ElScrollbar = resolveComponent('el-scrollbar') as unknown as string
      const ElForm = resolveComponent('el-form') as unknown as string
      const ElFormItem = resolveComponent('el-form-item') as unknown as string
      const ElTable = resolveComponent('el-table') as unknown as string
      const ElTableColumn = resolveComponent('el-table-column') as unknown as string

      /** 会话条目：微信式横向行 —— 头像（标题首字，未读时带红点）+ 标题 +
       *  状态 + 最近消息摘要 + 时间 + 悬停操作；选中项 primary 高亮。 */
      const sessionItem = (s: SessionRow) => {
        const open = s.status !== 'closed'
        const hasUnread = unread(s)
        return h('div', {
          key: s.id,
          class: `sp-rail-item${s.id === activeId.value ? ' active' : ''}`,
          // 未读红点的行给原生 title 提示（悬停可见「有新消息」）。
          title: hasUnread ? '有新消息' : undefined,
        }, [
          // 主体行：点击选中（text 按钮，active 由 URL 派生，保留 primary 高亮）。
          h('div', {
            class: 'sp-rail-main',
            role: 'button',
            tabindex: 0,
            'aria-pressed': s.id === activeId.value,
            onClick: () => select(s.id),
            onKeydown: (event: KeyboardEvent) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                select(s.id)
              }
            },
          }, {
            default: () => [
              unread(s)
                ? h(ElBadge, {
                    value: Math.min(lastMap.value[s.id]?.unreadCount ?? 1, 99),
                    hideNumber: false,
                  }, { default: () => avatarOf(s) })
                : avatarOf(s),
              h('span', { class: 'sp-rail-col' }, [
                h('span', { class: 'sp-rail-title' }, [s.title]),
                // 免打扰是唯一需要行内常显的状态（置顶由分组头表达、状态由摘要行表达）。
                isMuted(s.id)
                  ? h(ElTag, { size: 'small', type: 'info' }, { default: () => '免打扰' })
                  : null,
                // @我 标签（A5）：离线被点名，红底高亮 —— 比未读数字更响的信号。
                (lastMap.value[s.id]?.mentionsCount ?? 0) > 0
                  ? h(ElTag, { size: 'small', type: 'danger', effect: 'dark' },
                      { default: () => `[@我] ${lastMap.value[s.id]!.mentionsCount}` })
                  : null,
                h('span', { class: 'sp-rail-sub' }, [
                  h('span', { class: 'sp-brief' }, brief(s.id)),
                  h('span', { class: 'sp-rail-time' }, hhmm(lastMap.value[s.id]?.ts ?? s.updatedAt)),
                ]),
              ]),
            ],
          }),
          // 常显「⋯ 操作」下拉（2026-10-02 用户拍板：废弃悬停揭示 —— 悬停
          // 插入节点会挤开布局惊吓用户）。结束会议 / 邀请 / 移除成员 / 置顶 /
          // 免打扰全部收进一个 el-dropdown（click 触发）。
          h(ElDropdown, {
                trigger: 'click',
                onCommand: (cmd: string) => {
                  if (cmd === 'close') return void doClose(s.id)
                  if (cmd === 'rename') return openRename(s)
                  if (cmd === 'invite') {
                    inviteSessionId.value = s.id
                    inviteUsers.value = []
                    inviteError.value = ''
                    inviteOpen.value = true
                    return
                  }
                  if (cmd === 'remove') {
                    return void openMemberManagement(s.id)
                  }
                  if (cmd === 'pinned') return togglePinned(s.id)
                  if (cmd === 'muted') return toggleMuted(s.id)
                },
              }, {
                default: () => h(ElButton, {
                  text: true, type: 'info', size: 'small',
                }, { default: () => '⋯' }),
                dropdown: () => [
                  open ? h(ElDropdownItem, { command: 'close' }, { default: () => '结束会议' }) : null,
                  h(ElDropdownItem, { command: 'rename' }, { default: () => '重命名' }),
                  h(ElDropdownItem, { command: 'invite' }, { default: () => '邀请' }),
                  h(ElDropdownItem, { command: 'remove' }, { default: () => '移除成员' }),
                  h(ElDropdownItem, { command: 'pinned', divided: true },
                    { default: () => (isPinned(s.id) ? '取消置顶' : '置顶') }),
                  h(ElDropdownItem, { command: 'muted' },
                    { default: () => (isMuted(s.id) ? '取消免打扰' : '免打扰') }),
                ],
              }),
        ])
      }

      /** 状态分组：分组头用 el-divider（content-position left）。 */
      const group = (label: string, list: SessionRow[]) => [
        h(ElDivider, { contentPosition: 'left' }, { default: () => label }),
        list.map(sessionItem),
      ]

      const content = () => {
        if (!getToken()) {
          return [h(ElEmpty, { description: '请先登录', imageSize: 48 }, {
            image: () => emptyMark('↗'),
            default: () => h(ElButton, {
              type: 'primary', onClick: () => { location.href = '/login' },
            }, { default: () => '去登录' }),
          })]
        }
        if (sessions.value.length === 0) {
          const state = resolveLoadView(sessionsLoading.value, sessionsLoadFailed.value, false)
          if (state === 'loading') return [h(ElEmpty, { description: '正在加载会话…', imageSize: 48 }, {
            image: () => emptyMark('…', 'is-loading'),
          })]
          if (state === 'error') return [h(ElEmpty, { description: '会话暂时无法加载', imageSize: 48 }, {
            image: () => emptyMark('!', 'is-error'),
            default: () => h(ElButton, { type: 'primary', onClick: () => void load() }, { default: () => '重试' }),
          })]
          return [h('div', { class: 'sp-session-empty', role: 'status' }, '创建后，会议会显示在这里')]
        }
        return [
          // 置顶组放最上面（组内按 updatedAt 排序）；下方两组剔除已置顶项。
          ...(pinnedOnes.value.length
            ? group('置顶', pinnedOnes.value)
            : []),
          ...(openOnes.value.filter((s) => !isPinned(s.id)).length
            ? group('进行中', openOnes.value.filter((s) => !isPinned(s.id)))
            : []),
          ...(closedOnes.value.filter((s) => !isPinned(s.id)).length
            ? group('已结束', closedOnes.value.filter((s) => !isPinned(s.id)))
            : []),
        ]
      }

      /** 新会议主动作：侧栏只留按钮，表单全部收进对话框。 */
      const header = () => h(ElSpace, { size: 8 }, { default: () => [
        h(ElButton, {
          type: 'primary', disabled: creating.value, onClick: openDialog,
        }, { default: () => '新会议' }),
        sessions.value.length ? h(ElButton, {
          title: '快速切换会话（Ctrl+K）', onClick: openQuickSwitch,
        }, { default: () => '搜索会话' }) : null,
      ] })

      /** 通用多选（label/value 供给项 + 绑定值）。 */
      const multiSelect = (
        list: { id: string; label: string }[],
        value: string[],
        onUpdate: (v: string[]) => void,
        placeholder: string,
        disabled = false,
      ) => list.length
        ? h(ElSelect, {
            multiple: true,
            disabled,
            collapseTags: true,
            collapseTagsTooltip: true,
            clearable: true,
            filterable: true,
            placeholder,
            modelValue: value,
            'onUpdate:modelValue': onUpdate,
          }, { default: () => list.map((a) => h(ElOption, { key: a.id, label: a.label, value: a.id })) })
        : h(ElText, { type: 'info' }, { default: () => '（名单为空）' })

      /** 「新会议」对话框：标题（可空 → 服务端默认命名）+ 受邀成员和 Agent 多选。 */
      const newSessionDialog = h(ElDialog, {
        modelValue: dialogOpen.value,
        'onUpdate:modelValue': (v: boolean) => {
          if (!creating.value) dialogOpen.value = v
          if (!v && !creating.value) createError.value = ''
        },
        title: '创建新会议',
        width: 680,
        closeOnClickModal: false,
        showClose: !creating.value,
        onOpened: () => {
          void nextTick(() => document.querySelector<HTMLInputElement>(
            '.sp-session-create-form .el-form-item:first-child input',
          )?.focus())
        },
      }, {
        default: () => [
          createError.value
            ? h(ElAlert, {
                title: createError.value, type: 'error', showIcon: true, closable: true,
                onClose: () => { createError.value = '' },
              })
            : null,
          h(ElText, { type: 'info', class: 'sp-session-form-intro' }, {
            default: () => '会议主题可留空，创建后也能邀请成员和 Agent。',
          }),
          h(ElForm, { labelPosition: 'top', class: 'sp-session-create-form' }, {
            default: () => [
              h(ElFormItem, { label: '会议主题（可选）' }, {
                default: () => h(ElInput, {
                  modelValue: newTitle.value,
                  'onUpdate:modelValue': (v: string) => { newTitle.value = v },
                  disabled: creating.value,
                  placeholder: '例如：官网改版评审',
                  maxlength: 120,
                }),
              }),
              h(ElFormItem, { label: '邀请团队成员' }, {
                default: () => multiSelect(humans.value.map((u) => ({
                  id: u.id, label: `${u.displayName}（${u.username}）`,
                })), selectedUsers.value, (v: string[]) => { selectedUsers.value = v }, '搜索并选择成员', creating.value),
              }),
              h(ElFormItem, { label: '邀请 Agent' }, {
                default: () => roster.value.length
                  ? multiSelect(roster.value.map((a) => ({ id: a.id, label: a.title })),
                      selected.value, (v: string[]) => { selected.value = v }, '搜索并选择 Agent（可选）', creating.value)
                  : h(ElText, { type: 'info' }, { default: () => '当前没有可邀请的 Agent' }),
              }),
            ],
          }),
        ],
        footer: () => h(ElSpace, { size: 8 }, {
          default: () => [
            h(ElButton, { disabled: creating.value, onClick: () => { dialogOpen.value = false } }, { default: () => '取消' }),
            h(ElButton, {
              type: 'primary', loading: creating.value, disabled: creating.value,
              onClick: () => void create(),
            }, { default: () => creating.value ? '正在创建…' : '创建会议' }),
          ],
        }),
      })

      const renameDialog = h(ElDialog, {
        modelValue: renameOpen.value,
        'onUpdate:modelValue': (value: boolean) => { if (!renaming.value) renameOpen.value = value },
        title: '重命名会话',
        width: 420,
        closeOnClickModal: false,
        showClose: !renaming.value,
      }, {
        default: () => [
          renameError.value ? h(ElAlert, { title: renameError.value, type: 'error', showIcon: true, closable: false }) : null,
          h(ElInput, {
            modelValue: renameTitle.value,
            'onUpdate:modelValue': (value: string) => { renameTitle.value = value },
            maxlength: 120,
            showWordLimit: true,
            disabled: renaming.value,
            placeholder: '输入会话标题',
            onKeydown: (event: KeyboardEvent) => { if (event.key === 'Enter') void doRename() },
          }),
        ],
        footer: () => h(ElSpace, { size: 8 }, {
          default: () => [
            h(ElButton, { disabled: renaming.value, onClick: () => { renameOpen.value = false } }, { default: () => '取消' }),
            h(ElButton, { type: 'primary', loading: renaming.value, disabled: renaming.value || !renameTitle.value.trim(), onClick: () => void doRename() }, { default: () => renaming.value ? '正在保存…' : '保存' }),
          ],
        }),
      })

      /** 「邀请成员」对话框：listHumans 多选 → invite。 */
      const inviteDialog = h(ElDialog, {
        modelValue: inviteOpen.value,
        'onUpdate:modelValue': (v: boolean) => { if (!invitingMembers.value) inviteOpen.value = v },
        title: '邀请成员加入会议',
        width: 420,
        closeOnClickModal: false,
        showClose: !invitingMembers.value,
      }, {
        default: () => [
          inviteError.value
            ? h(ElAlert, { title: inviteError.value, type: 'error', showIcon: true, closable: false })
            : null,
          multiSelect(
            humans.value.map((u) => ({ id: u.id, label: `${u.displayName}（${u.username}）` })),
            inviteUsers.value,
            (v: string[]) => { inviteUsers.value = v },
            '选择要邀请的成员（可多选）',
            invitingMembers.value,
          ),
        ],
        footer: () => h(ElSpace, { size: 8 }, {
          default: () => [
            h(ElButton, { disabled: invitingMembers.value, onClick: () => { inviteOpen.value = false } }, { default: () => '取消' }),
            h(ElButton, {
              type: 'primary', loading: invitingMembers.value,
              disabled: !inviteUsers.value.length, onClick: () => void doInvite(),
            }, { default: () => '确定' }),
          ],
        }),
      })

      /** 成员管理：展示在册成员、记录角色调整或移除事件。 */
      const removeDialog = h(ElDialog, {
        modelValue: removeOpen.value,
        'onUpdate:modelValue': (v: boolean) => { removeOpen.value = v },
        title: '会话成员管理',
        width: 760,
        closeOnClickModal: false,
      }, {
        default: () => [
          membersLoadError.value
            ? h(ElAlert, { title: membersLoadError.value, type: 'error', showIcon: true, closable: false })
            : null,
          membersLoadError.value
            ? h(ElButton, {
                type: 'primary', loading: membersLoading.value, onClick: () => void loadManagedMembers(),
              }, { default: () => '重试加载成员' })
            : null,
          !membersLoadError.value ? h(ElTable, {
            data: managedMembers.value, size: 'small', rowKey: 'principalId', loading: membersLoading.value,
            emptyText: membersLoading.value ? '正在加载成员…' : '当前会话暂无成员',
          }, {
          default: () => [
            h(ElTableColumn, { label: '成员', minWidth: 220 }, {
              default: (scope: { row: MemberRow }) => {
                const human = humans.value.find((item) => item.id === scope.row.principalId)
                return `${scope.row.duty || human?.displayName || scope.row.principalId}（${scope.row.principalId}）`
              },
            }),
            h(ElTableColumn, { label: '会话角色', width: 220 }, {
              default: (scope: { row: MemberRow }) => {
                const human = humans.value.some((item) => item.id === scope.row.principalId)
                const fixed = scope.row.role === '群主' || !human
                return fixed
                  ? h(ElTag, { type: 'info', size: 'small' }, { default: () => scope.row.role })
                  : h(ElSelect, {
                    modelValue: roleDrafts.value[scope.row.principalId],
                    'onUpdate:modelValue': (value: string) => { roleDrafts.value[scope.row.principalId] = value },
                    size: 'small',
                    onChange: () => { void doSetMemberRole(scope.row) },
                  }, { default: () => [
                    h(ElOption, { label: '普通成员', value: '成员' }),
                    h(ElOption, { label: 'DRI', value: 'DRI' }),
                    h(ElOption, { label: '管理员', value: '管理员' }),
                  ] })
              },
            }),
            h(ElTableColumn, { label: '操作', width: 100 }, {
              default: (scope: { row: MemberRow }) => scope.row.role === '群主'
                ? h(ElTag, { type: 'info', size: 'small' }, { default: () => '创建者' })
                : h(ElButton, { type: 'danger', link: true, onClick: () => { removeUserId.value = scope.row.principalId; void doRemove() } }, {
                  default: () => '移出会话',
                }),
            }),
          ],
        }) : null,
        ],
        footer: () => h(ElButton, { onClick: () => { removeOpen.value = false } }, { default: () => '完成' }),
      })

      /** Ctrl+K 快速切换会话面板：过滤输入（打开即聚焦）+ 全量会话列表
       *  （进行中/已结束合并，updatedAt 倒序）。选中即切换并自动关；
       *  Esc / 点 × / 遮罩均可关（el-dialog 双向绑定自带）。 */
      const quickSwitchDialog = h(ElDialog, {
        modelValue: quickOpen.value,
        'onUpdate:modelValue': (v: boolean) => { quickOpen.value = v },
        title: '快速切换会话（Ctrl+K）',
        width: 420,
        onOpened: onQuickOpened,
        onClose: () => { quickQuery.value = '' },
      }, {
        default: () => [
          h(ElInput, {
            modelValue: quickQuery.value,
            'onUpdate:modelValue': (v: string) => { quickQuery.value = v; quickIndex.value = 0 },
            ref: (inst: { input?: HTMLInputElement } | null) => { quickInput.value = inst?.input ?? null },
            placeholder: '搜索标题、发言人或最近消息…',
            onKeydown: navigateQuickList,
          }),
          h(ElText, { size: 'small', type: 'info' }, { default: () => '↑↓ 选择 · Enter 打开' }),
          quickList.value.length
            ? h(ElScrollbar, { maxHeight: 'min(55vh, 440px)' }, {
                default: () => h(ElSpace, {
                  direction: 'vertical', fill: true, size: 2, class: 'sp-quick-switch-list',
                }, {
                  default: () => quickList.value.map((s, index) => h(ElButton, {
                    key: s.id,
                    class: ['sp-quick-session-button', index === quickIndex.value ? 'is-current' : ''],
                    text: true,
                    size: 'small',
                    'aria-pressed': index === quickIndex.value,
                    title: lastMap.value[s.id]
                      ? `${lastMap.value[s.id]!.authorName}：${humanizeMentions(lastMap.value[s.id]!.text)}`
                      : s.title,
                    onClick: () => quickPick(s.id),
                  }, {
                    default: () => {
                      const summary = lastMap.value[s.id]
                      return h('div', { class: 'sp-quick-session' }, [
                        h('div', { class: 'sp-quick-session-head' }, [
                          h(ElText, { truncated: true, class: 'sp-quick-session-title' }, {
                            default: () => s.title || '（未命名会议）',
                          }),
                          h(ElText, { size: 'small', type: 'info', class: 'sp-quick-session-time' }, {
                            default: () => hhmm(summary?.ts ?? s.updatedAt),
                          }),
                          h(ElTag, {
                            size: 'small', type: s.status === 'closed' ? 'info' : 'success',
                          }, { default: () => (s.status === 'closed' ? '已结束' : '进行中') }),
                        ]),
                        h('div', { class: 'sp-quick-session-preview' }, summary
                          ? [
                              h('span', { class: 'sp-quick-session-author' }, `${summary.authorName} · `),
                              humanizeMentions(summary.text).replaceAll(/\s+/g, ' ').trim(),
                            ]
                          : '暂无最近消息'),
                      ])
                    },
                  })),
                }),
              })
            : h(ElText, { size: 'small', type: 'info' }, { default: () => '没有匹配的会话' }),
        ],
      })

      return [
        error.value
          ? h(ElAlert, {
              title: error.value,
              type: 'error',
              showIcon: true,
              closable: true,
              onClose: () => { error.value = '' },
            })
          : null,
        h('div', { class: 'page-sidebar-header' }, [header()]),
        h('div', { class: 'page-sidebar-content' }, content()),
        newSessionDialog,
        renameDialog,
        inviteDialog,
        removeDialog,
        quickSwitchDialog,
        h('div', { class: 'sp-identity' }, [
          h(ElAvatar, { size: 24 }, { default: () => (me.value?.displayName ?? '?').charAt(0) }),
          h('div', { class: 'sp-identity-name',
              title: me.value ? `${me.value.displayName}（${me.value.username}）` : '' },
            { default: () => me.value?.displayName ?? '未登录' }),
          h('span', { class: 'sp-identity-actions' }, [
            h(ElButton, { text: true, size: 'small',
                onClick: () => void doLogout() }, { default: () => '登出' }),
          ]),
        ]),
      ]
    }
  },
})

/** 本包 client 插件：把会话栏挂到整页预留的槽位（外壳原生跨 entry 通道）。 */
interface RailCtx {
  client: {
    router: {
      slot(options: { type: string; component: unknown; order?: number }): void
    }
  }
}

export default function main(ctx: RailCtx) {
  ctx.client.router.slot({ type: 'space-teamspace-sidebar', component: SessionsRail, order: 0 })
}
