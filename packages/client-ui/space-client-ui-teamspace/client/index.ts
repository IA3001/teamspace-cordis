// 团队空间整页（客户端）—— 2026-09-29 三区骨架改版（用户拍板方案落地）。
//
// 布局（k-layout 外壳 chrome + 外壳共享布局类，零手写样式）：
//   k-layout（.page-content：薄顶栏 .layout-header + .main-content flex 行）
//   ├ #header 槽（薄顶栏左上角）：折叠开关 + 会话标题 + 状态徽章
//   ├ #menu   槽（薄顶栏右上角）：「协作面板」开关（宽屏常驻 / 窄屏默认折叠，
//   │   与左栏 railOpen 同款范式；2026-09-30 拍板：遮罩抽屉改非遮罩常驻右列）
//   └ 默认槽 → .main-content（flex 行）：
//       ├ aside.page-sidebar（左：会话栏，内容来自 'space-teamspace-sidebar'
//       │   槽位视图 —— 由 space-client-ui-sessions 包经 router.slot 入驻；
//       │   该包缺席时 k-slot 渲染为空，整页照常工作 = 纯新增可插拔）
//       ├ div.content-area（中：消息区 + composer）
//       │   ├ div.content-body > el-scrollbar > div.k-content
//       │   │   （消息列居中限宽 55rem、大留白；人类消息右对齐 el-card 气泡，
//       │   │    agent/系统消息左对齐平文 + 角色标签；时间戳默认不显示，
//       │   │    悬停消息行内揭示「作者 · 时间」—— 2026-09-30 回炉：弃 el-tooltip
//       │   │    传送门（长会话下 popper 弹出不确定），改组件状态驱动的行内揭示，
//       │   │    真实鼠标与测试注入两条路径都确定可见）
//       │   └ div.k-content > composer 卡片（悬浮卡片化：贴底居中，不再通栏）
//       └ aside.right-sidebar（右：协作面板常驻列 —— 外壳 layout.scss 现成
//           右列类（与 .page-sidebar 对称），零新样式；面板空值行不渲染）
//
// 不可回退的既有交互（原样保留）：普通文本自动暂存 +「已记下 #N」回执、
// closable el-tag 暂存条目（点 × = /del）、/cur //commit 并入斜杠联想菜单、
// @ 联想浮层（el-popover virtual-triggering）与完整键盘导航（↑↓/Enter/Tab/
// Esc/Shift+Enter/菜单关时 Enter 直发）、右面板数据口径（轮次状态/暂停原因/
// 调用次数/本回合已委托 + 可@成员）、发送走 handleInbound 与 HTTP 入站同路径。
//
// 会话选中态走 URL（?session=<id>）：会话栏（独立 entry）与本页经外壳 router
// 单例同步，无跨包共享状态。
import { computed, defineComponent, h, nextTick, onMounted, onUnmounted, ref, resolveComponent, watch } from 'vue'
import { useRpc, useContext, useRoute, useRouter } from '@cordisjs/client'
import EventItem from 'space-client-ui-shared/client/EventItem.ts'
import IconBtn from 'space-client-ui-shared/client/IconBtn.ts'
import { authorLabel, formatTime, memberLabel } from 'space-client-ui-shared/client/labels.ts'
import type { EventLite, MemberLite } from 'space-client-ui-shared/client/labels.ts'

interface SessionLite { id: string; title: string; status: string }
interface StagingEntry { id: string; seq: number; text: string; authorId: string }
interface TurnLite {
  state: string
  decisionCalls: number
  delegatedTargets: string[]
  stopReason: string
  stopDetail: string
}
type SendResult = { reply: string } | { error: string; detail: string }
interface CommandLite { name: string; usage: string; minArgs: number; maxArgs: number }
/** 联想菜单：null = 关闭；否则 slash（指令联想）或 mention（成员联想）。 */
type Menu = { kind: 'slash'; query: string } | { kind: 'mention'; query: string } | null

const STATE_LABEL: Record<string, string> = {
  chain: '进行中',
  static: '已暂停',
}
const STATE_TAG: Record<string, string> = { chain: 'warning', static: 'info' }
const STOP_LABEL: Record<string, string> = {
  await_human: '等待人类下一步指示',
  invalid_target: '委托目标不在授权名单',
  coordinator_unconfigured: '协调者未配置',
  coordinator_error: '协调者调用失败',
  coordinator_empty: '协调者空输出',
  duplicate_target: '同轮重复委托',
}
/** 会话状态徽章（sessions.status：open/closed）。 */
const sessionStatus = (s: SessionLite) =>
  ({ label: s.status === 'closed' ? '已结束' : '进行中', tag: s.status === 'closed' ? 'info' : 'success' })

/** 可被 @ 的角色（目标 agent + 人类）——协调者不在清单。 */
const MENTION_ROLES = new Set(['会议记录官', '挑战者', '需求分析师', 'DRI', '成员'])

/** 中间消息列与 composer 共用的居中限宽容器：外壳 k-content 的现成类
 *  （max-width 55rem + margin auto + 响应式内边距，即「业界 ~720px 观感」）。 */
const CENTERED = 'k-content'

const TeamspacePage = defineComponent({
  name: 'SpaceTeamspace',
  setup() {
    const rpc = useRpc<{
      sessions(): Promise<SessionLite[]>
      commands(): Promise<CommandLite[]>
      events(sessionId: string): Promise<EventLite[] | null>
      members(sessionId: string): Promise<MemberLite[] | null>
      staging(sessionId: string): Promise<StagingEntry[] | null>
      turn(sessionId: string): Promise<TurnLite>
      send(sessionId: string, authorId: string, text: string, mentions?: string[]): Promise<SendResult>
    }>()
    const appCtx = useContext()
    const router = useRouter()
    const route = useRoute()

    const sessions = ref([]) as { value: SessionLite[] }
    const members = ref([]) as { value: MemberLite[] }
    const events = ref([]) as { value: EventLite[] }
    const staging = ref([]) as { value: StagingEntry[] }
    const turn = ref(null) as { value: TurnLite | null }
    const activeId = ref('')
    const draft = ref('')
    const reply = ref('')
    const replyOk = ref(true)
    const menu = ref(null) as { value: Menu }
    const activeIdx = ref(0)
    const inputEl = ref(null) as { value: HTMLTextAreaElement | null }
    const commands = ref([]) as { value: CommandLite[] }
    /** 协作面板右列开关：宽屏默认常驻、窄视口默认折叠（2026-09-30 拍板：
     *  遮罩抽屉 → 非遮罩常驻右列，与 railOpen 同款范式保持窄屏可用）。 */
    const panelOpen = ref(!window.matchMedia('(max-width: 768px)').matches)
    /** 悬停揭示「作者 · 时间」的消息 id —— 必须住 setup 体：render 体内声明
     *  会被每次重渲染重建（4s 轮询即触发），悬停状态随渲染丢弃（第四轮根因）。 */
    const hoveredId = ref('')
    /** 左栏开关：宽屏默认展开、窄视口默认收起（业界统一：开关在中央顶栏左上角）。 */
    const railOpen = ref(!window.matchMedia('(max-width: 768px)').matches)
    /** composer 提示按需揭示（2026-09-30 拍板）：悬停 / 聚焦输入区才显示操作
     *  提示行，平时留白 —— 与消息时间戳同款「状态驱动行内揭示」范式（弃
     *  el-tooltip 传送门，弹出不确定的教训在前），零手写样式。
     *  P0 回炉（交互代理复测判红）：hover 与 focus 两路径必须拆开成独立状态
     *  （单 boolean 时 mouseleave 会无条件压掉仍存在的聚焦态 = 复测 D 场景
     *  实锤）；focus 路径弃 el-input 的 onFocus prop 转发（组件内部实现面），
     *  改稳定包装 div 上的原生 focusin/focusout（focus 不冒泡但 focusin 冒泡，
     *  CDP 真实点击/键入/Tab 聚焦都确定到达）。两 ref 住 setup 体跨轮询存续。 */
    const composerHover = ref(false)
    const composerFocus = ref(false)
    const composerHint = computed(() => composerHover.value || composerFocus.value)
    /** 会话栏是否已入驻（sessions 包缺席 → 左区整体不渲染，折叠开关随之隐藏）。 */
    const hasRail = computed(() => (appCtx.client.router.views['space-teamspace-sidebar']?.length ?? 0) > 0)
    const scrollbar = ref<{ setScrollTop: (v: number) => unknown } | null>(null)
    let timer: ReturnType<typeof setInterval> | undefined

    const activeSession = computed(() => sessions.value.find((s) => s.id === activeId.value))
    /** 发送身份：所选会话的 DRI（成员表缺 DRI 时降级为调试期约定身份 u_dri）。 */
    const authorId = computed(() =>
      members.value.find((m) => m.role === 'DRI')?.principalId ?? 'u_dri')

    const mentionCandidates = () => members.value.filter((m) => MENTION_ROLES.has(m.role))

    // ── 联想菜单（业界惯例：输入 / 或 @ 时按当前 token 实时过滤）─────────
    //  / 联想：行首（或换行后）的 "/token" —— token 与指令名前缀匹配
    //  @ 联想：结尾的 "@token" —— token 与成员 id / 角色名子串匹配
    const slashRe = /(?:^|\n)\/([a-z]*)$/i
    const mentionRe = /@([\w\u4e00-\u9fa5-]*)$/
    // 空匹配（如「@第一行」无人可匹配）一律视为菜单关闭 —— 空浮层是竞态温床：
    // 用户以为存在选中态，Enter 却落进直发分支把原文发出（2026-09-29 回炉实测）。
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
    const mentionItems = (q: string) => mentionCandidates()
      .filter((m) => m.principalId.toLowerCase().includes(q) || m.role.toLowerCase().includes(q) ||
        (m.duty ?? '').toLowerCase().includes(q))

    const parseMentions = (): string[] => {
      const ids = mentionCandidates().map((m) => m.principalId)
      return [...new Set((draft.value.match(/@([^\s@]+)/g) ?? [])
        .map((t) => t.slice(1))
        .filter((t) => ids.includes(t)))]
    }

    async function load() {
      try {
        sessions.value = await rpc.value.sessions()
        if (commands.value.length === 0) commands.value = await rpc.value.commands()
        // 缺省选中：URL 指定的会话优先，否则首个会话，并回写 URL（会话栏据此高亮）。
        if (!activeId.value && sessions.value.length > 0) {
          const initial = sessions.value.find((s) => s.id === route.query.session) ?? sessions.value[0]!
          activeId.value = initial.id
          if (route.query.session !== initial.id) void router.replace({ query: { session: initial.id } })
        }
        if (!activeId.value) return
        const [ev, mb, st, tn] = await Promise.all([
          rpc.value.events(activeId.value),
          rpc.value.members(activeId.value),
          rpc.value.staging(activeId.value),
          rpc.value.turn(activeId.value),
        ])
        if (ev) events.value = ev
        if (mb) members.value = mb
        if (st) staging.value = st
        turn.value = tn
        if (reply.value.startsWith('加载失败')) reply.value = ''
      } catch (e) {
        replyOk.value = false
        reply.value = `加载失败：${String((e as Error).message ?? e)}`
      }
    }

    // 会话栏改选 = 改 URL；本页只认 URL，唯一的选中真相源。
    watch(() => route.query.session, (v) => {
      if (v && v !== activeId.value) {
        activeId.value = v
        events.value = []
        void load()
      }
    })

    function onDraft(v: string) {
      draft.value = v
      menu.value = deriveMenu(v)
      activeIdx.value = -1 // 打开菜单不预选高亮（P2：选中态只由键盘动作产生）
    }

    // ── 键盘状态机（2026-09-29 回炉定稿，单一 handler 无竞态）：
    //    · Shift+Enter 恒换行 —— 先于一切分支放行，绝不 preventDefault；
    //    · 菜单开（有候选）：Enter/Tab 恒确认选中项（未选过则确认第 0 项），
    //      ↑↓ 换选中、Esc 关闭 —— Enter 只归菜单，绝不直发；
    //    · 菜单关（无候选/已 Esc）：裸 Enter 直发。
    //    菜单「开着」的定义 = 有候选（deriveMenu 已把空匹配折算成关闭）。
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
        const c = items[activeIdx.value] ?? items[0] // 未选过/越界 → 第 0 项
        if (c) pickCommand(c.name)
      } else {
        const items = mentionItems(m.query)
        const mm = items[activeIdx.value] ?? items[0]
        if (mm) insertMention(mm.principalId)
      }
    }
    /** Shift+Enter 恒换行：preventDefault + 在光标处显式插 \n。不依赖浏览器
     *  默认行为 —— 合成事件（测试注入）不会触发默认动作，显式插入才对真实
     *  键盘与注入两条路径都成立（2026-09-30 回炉：旧写法裸 return 依赖默认
     *  行为，合成注入下零换行）。 */
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
      if (e.key === 'Enter') { void sendText(draft.value); e.preventDefault() }
    }
    // 失焦延迟关闭：给浮层里的点选留出 click 完成时间
    function onBlur(): void {
      setTimeout(() => { menu.value = null }, 200)
    }

    /** 点选指令联想：把行尾 "/token" 补全成 "/name "（有参指令留给用户填参数）。 */
    function pickCommand(name: string) {
      draft.value = draft.value.replace(slashRe, `/${name} `)
      menu.value = null
    }

    /** 点选成员联想：把结尾的 "@token" 替换成 "@id "。 */
    function insertMention(id: string) {
      draft.value = draft.value.replace(mentionRe, `@${id} `)
      menu.value = null
    }

    async function sendText(text: string) {
      if (!activeId.value) {
        replyOk.value = false
        reply.value = '请先选择或新建一个会议'
        return
      }
      if (!text.trim()) {
        replyOk.value = false
        reply.value = '请输入内容再发送'
        return
      }
      try {
        const result: SendResult = await rpc.value.send(activeId.value, authorId.value, text, parseMentions())
        replyOk.value = 'reply' in result
        reply.value = 'reply' in result ? result.reply : `出错了（${result.error}）：${result.detail}`
        if ('reply' in result) draft.value = ''
        menu.value = null
        await load()
      } catch (e) {
        replyOk.value = false
        reply.value = `发送失败：${String((e as Error).message ?? e)}`
      }
    }

    // 时间线自动滚到底部
    watch(() => events.value.length, async () => {
      await nextTick()
      scrollbar.value?.setScrollTop(999999)
    })

    onMounted(() => {
      void load()
      timer = setInterval(() => void load(), 4000)
    })
    onUnmounted(() => clearInterval(timer))

    return () => {
      const ElButton = resolveComponent('el-button') as unknown as string
      const ElCard = resolveComponent('el-card') as unknown as string
      const ElRow = resolveComponent('el-row') as unknown as string
      const ElInput = resolveComponent('el-input') as unknown as string
      const ElTag = resolveComponent('el-tag') as unknown as string
      const ElEmpty = resolveComponent('el-empty') as unknown as string
      const ElScrollbar = resolveComponent('el-scrollbar') as unknown as string
      const ElPopover = resolveComponent('el-popover') as unknown as string
      const KCard = resolveComponent('k-card') as unknown as string
      const ElDivider = resolveComponent('el-divider') as unknown as string
      const ElText = resolveComponent('el-text') as unknown as string
      const ElTimeline = resolveComponent('el-timeline') as unknown as string
      const ElTimelineItem = resolveComponent('el-timeline-item') as unknown as string
      const ElDescriptions = resolveComponent('el-descriptions') as unknown as string
      const ElDescriptionsItem = resolveComponent('el-descriptions-item') as unknown as string
      const KLayout = resolveComponent('k-layout') as unknown as string
      const KIcon = resolveComponent('k-icon') as unknown as string
      const KSlot = resolveComponent('k-slot') as unknown as string

      // ── 薄顶栏（k-layout #header / #menu 槽，外壳 .layout-header 44px）──
      const activeStatus = activeSession.value ? sessionStatus(activeSession.value) : null
      const topbarLeft = () => [
        hasRail.value
          ? h(ElButton, {
              key: 'rail-toggle', text: true, onClick: () => { railOpen.value = !railOpen.value },
            }, { default: () => h(KIcon, { name: railOpen.value ? 'chevron-left' : 'chevron-right' }) })
          : null,
        h('span', { class: 'layout-header-title', key: 'title' },
          activeSession.value?.title ?? '未选择会议'),
        activeStatus
          ? h(ElTag, {
              key: 'status', size: 'small', type: activeStatus.tag,
            }, { default: () => activeStatus.label })
          : null,
      ]
      const topbarRight = () => [
        turn.value?.state === 'static'
          ? h(ElTag, { key: 'paused', size: 'small', type: 'warning' }, { default: () => '已暂停' })
          : null,
        // 协作面板开关（2026-09-30 拍板：不再是「呼出遮罩抽屉」，而是折叠 /
        // 展开常驻右列 —— 与左栏开关同款范式，窄视口默认收起保持可用）。
        h(ElButton, {
          key: 'panel', text: true, type: panelOpen.value ? 'primary' : 'info',
          onClick: () => { panelOpen.value = !panelOpen.value },
        }, { default: () => '协作面板' }),
      ]

      // ── 消息行（时间戳默认不显示；悬停消息行内揭示「作者 · 时间」）──────
      // 2026-09-30 回炉：弃 el-tooltip —— popper 走传送门，弹出不确定；改
      // hoveredId（setup 级 ref）驱动的行内揭示。⚠ 第四轮二次回炉根因：ref
      // 曾误声明在这个 render 体内 —— 页面 4s 轮询等任何重渲染都会重建 ref，
      // 悬停状态随渲染丢弃，揭示条件永不成立（真实 CDP 复现坐实）。修法：
      // ref 上移 setup 体，跨重渲染存续。
      const messageRow = (ev: EventLite) => {
        const main = ev.authorKind === 'human'
          // 人类消息 = 右对齐气泡（el-card 作为 el-row 的直接子项按内容收缩）
          ? h(ElRow, { justify: 'end' }, {
              default: () => h(ElCard, { shadow: 'never' }, { default: () => h('div', ev.text) }),
            })
          // agent/系统消息 = 左对齐平文 + 角色标签（shared 的 EventItem，只此一份）
          : h(EventItem, { event: ev, members: members.value })
        return h(ElTimelineItem, {
          key: ev.id,
          type: ev.authorKind === 'human' ? 'primary' : ev.authorKind === 'agent' ? 'success' : 'info',
          hollow: ev.authorKind !== 'human',
        }, { default: () => h('div', {
            onMouseenter: () => { hoveredId.value = ev.id },
            onMouseleave: () => { if (hoveredId.value === ev.id) hoveredId.value = '' },
          }, [
            main,
            hoveredId.value === ev.id
              ? h(ElText, { size: 'small', type: 'info' },
                  { default: () => `${authorLabel(ev.authorId, members.value)} · ${formatTime(ev.ts)}` })
              : null,
          ]) })
      }

      const messageArea = h('div', { class: CENTERED }, [
        !activeId.value
          ? h(ElEmpty, { description: '还没有会议 —— 点左侧「新会议」开始协作' })
          : events.value.length === 0
            ? h(ElEmpty, { description: '还没有事件 —— 在下方输入区发言，/commit 提交后这里出现时间线' })
            : h(ElTimeline, {}, { default: () => events.value.map(messageRow) }),
      ])

      // ── 协作面板（2026-09-30 拍板：非遮罩常驻右列，数据口径不变）────────
      // 外壳现成右列类 .right-sidebar（layout.scss，与 .page-sidebar 对称）承
      // 接第三列，零新样式。空值行整行不渲染：「暂停原因」只在真有暂停原因时
      // 显示、「说明」只在有 stopDetail 时显示、「已委托」只在有委托时显示 ——
      // 停顿时不再满屏横杠。
      const t = turn.value
      const stopText = t ? (STOP_LABEL[t.stopReason] ?? t.stopReason) : ''
      const panelRows = [
        t && stopText && stopText !== '—'
          ? h(ElDescriptionsItem, { label: '暂停原因' }, { default: () => stopText })
          : null,
        t?.stopDetail
          ? h(ElDescriptionsItem, { label: '说明' }, { default: () => t.stopDetail })
          : null,
        t
          ? h(ElDescriptionsItem, { label: '协调者调用（本回合）' }, { default: () => String(t.decisionCalls) })
          : null,
        t && t.delegatedTargets.length
          ? h(ElDescriptionsItem, { label: '本回合已委托' }, { default: () => t.delegatedTargets.join('、') })
          : null,
      ].filter((x) => x !== null)
      const panelCard = h(ElCard, { shadow: 'hover' }, {
        header: () => [
          h(ElTag, { size: 'small', type: t ? (STATE_TAG[t.state] ?? 'info') : 'info' },
            { default: () => t ? (STATE_LABEL[t.state] ?? t.state) : '无回合' }),
          ' 协作轮次',
        ],
        default: () => [
          panelRows.length
            ? h(ElDescriptions, { column: 1, border: true, size: 'small' }, { default: () => panelRows })
            : h(ElText, { size: 'small', type: 'info' }, { default: () => '本轮无暂停 / 委托详情' }),
          h(ElDivider, { contentPosition: 'left' }, { default: () => '可 @ 的成员（协调者不可被调用）' }),
          mentionCandidates().length
            ? h(ElRow, { gutter: 8 }, {
                default: () => mentionCandidates().map((m) => h(ElTag, {
                  key: m.principalId, size: 'small',
                  type: m.role === 'DRI' ? 'success' : 'primary',
                }, { default: () => memberLabel(m) })),
              })
            : h(ElEmpty, { description: '暂无在册成员', imageSize: 60 }),
        ],
      })
      const collabPanel = () => panelOpen.value
        ? h('aside', { class: 'right-sidebar' }, [
            h('div', { class: 'page-sidebar-content' }, [panelCard]),
          ])
        : null

      // ── 联想浮层（el-popover 虚拟锚定输入框，placement top-start）──────
      // 菜单项统一渲染（P2：无特配色、无常亮主色）；高亮只属于键盘选中项。
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
          : items.map((mm, i) => menuRow(i, memberLabel(mm), '插入提及', () => insertMention(mm.principalId)))
      }
      const suggestionPopover = () => h(ElPopover, {
        visible: menu.value !== null,
        'virtual-triggering': true,
        'virtual-ref': inputEl.value,
        placement: 'top-start',
        width: 560,
      }, { default: menuContent })

      // × 用显式按钮（shared IconBtn）：el-tag 内置 close 是内部 SVG，点击命中
      // 有歧义且无法标 aria-label（2026-09-29 回炉实测）。
      // 只有作者能看到 ×（服务端 /del 对非作者仍会再校验一次）。
      const stagingLine = (e: StagingEntry) => h('span', { key: e.id }, [
        h(ElTag, { size: 'large', type: 'info' },
          { default: () => `#${e.seq} ${authorLabel(e.authorId, members.value)}：${e.text}` }),
        e.authorId === authorId.value
          ? h(IconBtn, {
              icon: 'times-full',
              label: `删除暂存条目 #${e.seq}（等价于 /del ${e.seq}）`,
              onPress: () => void sendText(`/del ${e.seq}`),
            })
          : null,
      ])

      // ── composer 悬浮卡片（贴底居中，不再通栏）──────────────────────────
      // 2026-09-30 拍板：说明书式提示与「暂存区为空」占位不再常显 —— 悬停 /
      // 聚焦输入区才揭示提示行（composerHint 状态驱动，与消息时间戳同款范式），
      // 平时留白，减少中间区文字噪音。交互契约零改动（自动暂存 /commit/@ 联想/
      // Shift+Enter 均原样）。
      // P0 回炉：揭示挂在这层「每轮 patch 必复用、永不重建」的稳定包装 div 上
      // （根 div 在 composer 定义处一次性创建、被 render 闭包长期持有），
      // hover/focus 两路各自独立状态；focusin/focusout 是冒泡的原生事件，
      // 真实鼠标、点击、Tab、键入都确定命中（原生 focus/blur 不冒泡，弃）。
      const composer = h('div', [
        h('div', {
          class: CENTERED,
          onMouseenter: () => { composerHover.value = true },
          onMouseleave: () => { composerHover.value = false },
          onFocusin: () => { composerFocus.value = true },
          onFocusout: () => { composerFocus.value = false },
        }, [
        suggestionPopover(),
        // k-card（外壳原语，首选）：圆角 8px，背景与阴影由组件自带的语义令牌
        // （映射外壳 elevated / shadow 档）承担 —— props 零手写（P2 悬浮卡片质感）。
        h(KCard, null, {
          default: () => [
            h(ElInput, {
              modelValue: draft.value,
              'onUpdate:modelValue': onDraft,
              onKeydown,
              onBlur,
              ref: (inst) => { inputEl.value = (inst as { textarea?: HTMLTextAreaElement } | null)?.textarea ?? null },
              type: 'textarea',
              rows: 3,
              placeholder: '输入发言…（/ 召唤指令联想；@ 提及成员；Enter 发送，Shift+Enter 换行）',
            }),
            h(ElRow, { justify: 'end' }, {
              default: () => h(ElButton, { type: 'primary', onClick: () => void sendText(draft.value) },
                { default: () => '发送' }),
            }),
            // 回执轻量化（P2：整行 alert 挤占空间）——行内小标签 + 文本，肉眼可见不变
            reply.value ? h('span', [
              h(ElTag, { size: 'small', type: replyOk.value ? 'success' : 'error' },
                { default: () => (replyOk.value ? '回执' : '出错') }),
              h('span', ` ${reply.value}`),
              h(IconBtn, { icon: 'times-full', label: '关闭回执', onPress: () => { reply.value = '' } }),
            ]) : null,
            // 暂存条目照常常显（有内容 = 真信息）；「暂存区为空」占位不再刷存在感
            staging.value.map(stagingLine),
          ],
        }),
        composerHint.value
          ? h('div', [
              h(ElText, { size: 'small', type: 'info' },
                { default: () => '普通文本自动暂存（不触发协调者），/commit 提交暂存' +
                  (staging.value.length === 0 ? '；暂存区为空' : '') }),
            ])
          : null,
        ]),
      ])

      // ── 根布局：k-layout（外壳 chrome）+ 三区骨架 ────────────────────────
      // 左区 = 会话栏槽位视图（sessions 包入驻；缺席时 k-slot 渲染为空，
      // 页面不 import 该包 —— 入驻 = 纯新增）。中区 = 消息列 + composer。
      // 右区 = 协作面板常驻列（2026-09-30 拍板：非遮罩，不再盖主区）。
      return h(KLayout, { main: 'page-teamspace' }, {
        header: topbarLeft,
        menu: topbarRight,
        default: () => [
          // 折叠不做动画（第四轮回炉拍板）：过渡是锦上添花，确定性一票否决 ——
          // 标准件过渡机制存在环境性失效面（仲裁实测零过渡事件 + 折叠后交互
          // 病态恶化），弃用动画换折叠/展开瞬时可靠、零过渡风险。
          railOpen.value && hasRail.value
            ? h('aside', { class: 'page-sidebar' }, [
                h(KSlot, { name: 'space-teamspace-sidebar', single: true }),
              ])
            : null,
          h('div', { class: 'content-area' }, [
            h('div', { class: 'content-body' }, [
              h(ElScrollbar, { ref: scrollbar }, { default: () => messageArea }),
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
// 页面出现在外壳菜单/路由靠 client 插件自调 client.router.page（logger-webui
// dist 原文同款）；entry 的 routes 选项只影响服务端 SPA 404/加载态判定。
// ⚠ 不能注册在 '/'：外壳自带 home 页先占了 '/'（@cordisjs/client/app/home），
// 路由按注册顺序先匹配先赢 —— 用真实路径 '/teamspace'（同官方 '/logs'）。
interface PageCtx {
  client: {
    router: {
      page(options: { path: string; name: string; icon?: string; order?: number; component: unknown }): void
    }
  }
}

export default function main(ctx: PageCtx) {
  ctx.client.router.page({
    path: '/teamspace',
    name: '团队空间',
    icon: 'activity:default',
    order: 900,
    component: TeamspacePage,
  })
}
