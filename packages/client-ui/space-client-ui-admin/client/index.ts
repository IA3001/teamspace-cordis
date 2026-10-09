// 账号管理页（客户端）—— 2026-10-01 新增，挂在 5172 调试控制台。
//
// 结构：onMounted 先 me(token) —— null（未登录/token 失效）或 isAdmin=false
// → el-empty「需要管理员权限」（附说明：第一个注册的用户自动成为管理员）；
// 是管理员 → 顶部说明 el-alert（info）+ el-table 用户列表。
//
// 表列：显示名 / 用户名 / id / 类型（human|agent el-tag）/ 管理员（是/否
// tag）/ 创建时间 / 操作。操作按行类型：human → 修改密码（el-dialog 内
// el-input → resetPassword）、设/撤管理员（setAdmin，自己这行禁用）、删除
//（el-popconfirm → removeUser）；agent 行只读 —— AI 身份由插件管理。
//
// 所有操作成功后刷新列表；失败把 { error, detail } 显示在页首 el-alert。
//
// 鉴权：RPC 首参 token（localStorage 'space_token'，与 /login、teamspace
// 页共用口径）；返回 null = 未登录/非管理员。
//
// 铁律 1：只用外壳全局注册的 el-* / k-*（resolveComponent），零 import
// element-plus、零手写样式、零内联样式。
import { computed, defineComponent, h, onMounted, ref, resolveComponent } from 'vue'
import { useRpc, useRoute } from '@cordisjs/client'
import { ThemeStyle } from 'space-client-ui-shared/client/theme.ts'
import { pageHead, status, section, actionsRow, loginGate } from 'space-client-ui-shared/client/console.ts'

/** 用户行（users RPC 的返回形状 = PublicUser）。 */
interface UserRow {
  id: string
  username: string
  displayName: string
  kind: 'human' | 'agent'
  isAdmin: boolean
  createdAt: string
}

/** me(token) 的返回形状。 */
interface MeRow extends UserRow {}

/** 写操作 RPC 的返回：{ ok } 或 { error, detail }（null = 未放行）。 */
interface WriteResult {
  ok?: boolean
  error?: string
  detail?: string
}

/** 登录 token 的 localStorage 键（与 /login 页、teamspace 页共用口径）。 */
const TOKEN_KEY = 'space_token'
const getToken = () => localStorage.getItem(TOKEN_KEY) ?? ''

/** 创建时间 → YYYY-MM-DD HH:mm（本地时区）。 */
function fmtTime(iso: string): string {
  try {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return iso
    const p = (n: number) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
  } catch {
    return iso
  }
}

const AdminPage = defineComponent({
  name: 'SpaceAdminPage',
  setup() {
    const route = useRoute()

    // 拒绝态就地登录的状态（必须在 setup 体 —— 放渲染闭包里每次重渲染会
    // 重建为空，填的值全丢，2026-10-02 实测踩坑）。
    const loginName = ref('')
    const loginPass = ref('')
    const loginErr = ref('')
    const loginBusy = ref(false)
    async function doAdminLogin() {
      loginBusy.value = true
      loginErr.value = ''
      const r = await rpc.value.login(loginName.value, loginPass.value)
      loginBusy.value = false
      if ('error' in r) { loginErr.value = r.detail ?? r.error; return }
      localStorage.setItem(TOKEN_KEY, r.token)
      window.location.reload()
    }
    const rpc = useRpc<{
      me(token: string): Promise<MeRow | null>
      users(token: string): Promise<UserRow[] | null>
      getRegisterEnabled(token: string): Promise<{ enabled: boolean } | null>
      setRegisterEnabled(token: string, v: boolean): Promise<WriteResult | null>
      resetPassword(token: string, userId: string, password: string): Promise<WriteResult | null>
      setAdmin(token: string, userId: string, v: boolean): Promise<WriteResult | null>
      removeUser(token: string, userId: string): Promise<WriteResult | null>
      uiPort(token: string): Promise<number | null>
      login(username: string, password: string): Promise<{ token: string } | { error: string; detail?: string }>
    }>()

    // 探测态：null = 还在 me()；undefined = 未登录或非管理员（出空态）；
    // 对象 = 管理员本人（出表格）。
    const me = ref<MeRow | null | undefined>(null)
    const users = ref([]) as { value: UserRow[] }
    // 页首失败条（所有写操作的 {error, detail} 都落这里）。
    const error = ref('')
    // 刷新忙标记（表格 v-loading）。
    const busy = ref(false)
    // 注册开关状态（A4）。
    const regOpen = ref(true)
    const regBusy = ref(false)
    // 筛选 + 分页（用户反馈①⑤，2026-10-07）。
    const query = ref('')
    const pageNo = ref(1)
    const PAGE_SIZE = 10

    // ── 修改密码弹窗状态 ──────────────────────────────────────────────
    const pwVisible = ref(false)
    const pwTarget = ref<UserRow | null>(null)
    const pwValue = ref('')
    const pwBusy = ref(false)

    async function refresh() {
      busy.value = true
      try {
        const list = await rpc.value.users(getToken())
        users.value = Array.isArray(list) ? list : []
        const reg = await rpc.value.getRegisterEnabled(getToken())
        if (reg) regOpen.value = reg.enabled
        // 数据量变化后页码越界收口。
        if (pageNo.value > Math.ceil(users.value.length / PAGE_SIZE)) pageNo.value = 1
      } finally {
        busy.value = false
      }
    }

    async function toggleRegister(v: boolean | string | number) {
      regBusy.value = true
      try {
        const r = await rpc.value.setRegisterEnabled(getToken(), Boolean(v))
        if (r && r.ok) {
          error.value = ''
          regOpen.value = Boolean(v)
        } else {
          const d = r as { error?: string; detail?: string } | null
          error.value = d?.detail ?? d?.error ?? '操作失败'
        }
      } finally { regBusy.value = false }
    }

    onMounted(async () => {
      // ?token= 免登（从 5174 会话栏「账号管理」跳转过来时携带）。
      const qtoken = route.query.token
      if (typeof qtoken === 'string' && qtoken) localStorage.setItem(TOKEN_KEY, qtoken)
      const m = await rpc.value.me(getToken())
      // null = token 无效（或未登录）；isAdmin=false 同样不放行。
      if (!m || !m.isAdmin) {
        me.value = undefined
        return
      }
      me.value = m
      await refresh()
    })

    /** 统一处理写操作返回：ok → 刷新列表；{error,detail} → 页首 alert。 */
    async function handleResult(r: WriteResult | null) {
      if (r && r.ok) {
        error.value = ''
        await refresh()
        return true
      }
      const d = r as { error?: string; detail?: string } | null
      error.value = d?.detail ?? d?.error ?? '操作失败'
      return false
    }

    function openPw(row: UserRow) {
      pwTarget.value = row
      pwValue.value = ''
      pwVisible.value = true
    }

    async function doResetPassword() {
      if (!pwTarget.value) return
      pwBusy.value = true
      try {
        const r = await rpc.value.resetPassword(getToken(), pwTarget.value.id, pwValue.value)
        if (await handleResult(r)) pwVisible.value = false
      } finally {
        pwBusy.value = false
      }
    }

    async function doSetAdmin(row: UserRow, v: boolean) {
      const r = await rpc.value.setAdmin(getToken(), row.id, v)
      await handleResult(r)
    }

    /** 筛选 + 分页（2026-10-07 用户反馈⑤）。 */
    const filteredUsers = computed(() => {
      const q = query.value.trim().toLowerCase()
      return users.value.filter((u) => {
        if (u.kind !== 'human') return false
        if (!q) return true
        return u.displayName.toLowerCase().includes(q) ||
          u.username.toLowerCase().includes(q) ||
          u.id.toLowerCase().includes(q)
      })
    })
    const pagedUsers = computed(() =>
      filteredUsers.value.slice((pageNo.value - 1) * PAGE_SIZE, pageNo.value * PAGE_SIZE))
    const agentsList = computed(() => users.value.filter((u) => u.kind === 'agent'))
    const humans = computed(() => users.value.filter((u) => u.kind === 'human'))

    async function doRemove(row: UserRow) {
      const r = await rpc.value.removeUser(getToken(), row.id)
      await handleResult(r)
    }

    return () => {
      const ElAlert = resolveComponent('el-alert') as unknown as string
      const ElButton = resolveComponent('el-button') as unknown as string
      const ElSpace = resolveComponent('el-space') as unknown as string
      const ElDialog = resolveComponent('el-dialog') as unknown as string
      const ElEmpty = resolveComponent('el-empty') as unknown as string
      const ElForm = resolveComponent('el-form') as unknown as string
      const ElFormItem = resolveComponent('el-form-item') as unknown as string
      const ElInput = resolveComponent('el-input') as unknown as string
      const ElText = resolveComponent('el-text') as unknown as string
      const ElPopconfirm = resolveComponent('el-popconfirm') as unknown as string
      const ElTable = resolveComponent('el-table') as unknown as string
      const ElTableColumn = resolveComponent('el-table-column') as unknown as string
      const ElTag = resolveComponent('el-tag') as unknown as string
      const ElSwitch = resolveComponent('el-switch') as unknown as string
      const ElPagination = resolveComponent('el-pagination') as unknown as string
      const ElSelect = resolveComponent('el-select') as unknown as string
      const ElOption = resolveComponent('el-option') as unknown as string

      // ── 非管理员 / 未登录：空态（附第一个注册者自动成为管理员的说明）──
      const denied = () => loginGate({
      brand: 'TS',
      title: '账号管理',
      desc: '需要管理员权限 —— 第一个注册的用户自动成为管理员。请登录管理员账号：',
      children: [
        h(ElInput, {
          modelValue: loginName.value,
          'onUpdate:modelValue': (v: string) => { loginName.value = v },
          placeholder: '管理员用户名',
        }),
        h(ElInput, {
          modelValue: loginPass.value,
          'onUpdate:modelValue': (v: string) => { loginPass.value = v },
          type: 'password', showPassword: true,
          placeholder: '密码',
          onKeydown: (e: KeyboardEvent) => { if (e.key === 'Enter') void doAdminLogin() },
        }),
        loginErr.value
          ? h(ElText, { type: 'danger', size: 'small' }, { default: () => loginErr.value })
          : null,
        h(ElButton, {
          type: 'primary', loading: loginBusy.value, style: 'width:100%',
          onClick: () => void doAdminLogin(),
        }, { default: () => '登录' }),
      ],
    })

      // ── 操作列（按行类型：human 可管理；agent 只读，AI 身份由插件管理）──
      const actions = (row: UserRow) => {
        if (row.kind !== 'human') {
          return h(ElTag, { type: 'info', size: 'small' }, {
            default: () => 'AI 身份由插件管理',
          })
        }
        const isSelf = me.value?.id === row.id
        return h('span', null, [
          // 修改密码：按钮 → 弹窗（el-dialog 内 el-input 新密码）。
          h(ElButton, { size: 'small', link: true, type: 'primary', onClick: () => openPw(row) }, {
            default: () => '修改密码',
          }),
          // 设/撤管理员：自己这行禁用（自降保护，服务端也拦）。
          h(ElButton, {
            size: 'small', link: true, type: 'warning', disabled: isSelf,
            onClick: () => void doSetAdmin(row, !row.isAdmin),
          }, { default: () => (row.isAdmin ? '撤管理员' : '设管理员') }),
          // 删除：el-popconfirm 二次确认；自己这行禁用。
          h(ElPopconfirm, {
            title: `确定删除账号 ${row.displayName}（${row.username}）吗？`,
            confirmButtonText: '删除',
            cancelButtonText: '取消',
            onConfirm: () => void doRemove(row),
          }, {
            reference: () => h(ElButton, {
              size: 'small', link: true, type: 'danger', disabled: isSelf,
            }, { default: () => '删除' }),
          }),
        ])
      }

      // ── 管理员视图：页头 + 表格分区卡 ─────────────────────────────────
      const panel = () => [
        pageHead('账号管理',
          '第一个注册的用户自动成为管理员；会话内的成员管理（邀请 / 移除）在团队空间页操作。',
          {
            statuses: [
              { text: `人类 ${users.value.filter((u) => u.kind === 'human').length}`, level: 'ok' },
              { text: `AI 成员 ${users.value.filter((u) => u.kind === 'agent').length}`, level: 'idle' },
            ],
          }),
        error.value
          ? h('div', { class: 'sp-note sp-note--err' }, error.value)
          : null,
        section('用户', 'human 账号可管理；agent 身份由插件注册表管理，此处只读。',
          [
            // 工具行：注册开关（缩小版）+ 搜索 + 类型筛选
            h('div', { class: 'sp-toolbar' }, [
              h('div', { class: 'sp-toolbar-group' }, [
                h(ElSwitch, {
                  modelValue: regOpen.value,
                  'onUpdate:modelValue': (v: boolean | string | number) => { regOpen.value = Boolean(v) },
                  onChange: (v: boolean | string | number) => void toggleRegister(v),
                  size: 'small',
                }),
                h('span', { class: 'sp-toolbar-label' },
                  regOpen.value ? '开放注册' : '已关闭注册'),
              ]),
              h(ElInput, {
                modelValue: query.value,
                'onUpdate:modelValue': (v: string) => { query.value = v; pageNo.value = 1 },
                placeholder: '搜索显示名 / 用户名 / id…',
                clearable: true,
                style: 'width:220px',
              }),
              h(ElButton, {
                text: true, size: 'small', type: 'danger', style: 'margin-left:auto',
                onClick: () => { localStorage.removeItem(TOKEN_KEY); location.href = '/' },
              }, { default: () => '登出' }),
            ]),
            h(ElTable, { data: pagedUsers.value, loading: busy.value }, {
              default: () => [
                h(ElTableColumn, { prop: 'displayName', label: '显示名', width: 130 }),
                h(ElTableColumn, { prop: 'username', label: '用户名', width: 140 }),
                h(ElTableColumn, { prop: 'id', label: 'id', width: 150 }),
                h(ElTableColumn, { label: '管理员', width: 90 }, {
                  default: (scope: { row: UserRow }) => status({
                    text: scope.row.isAdmin ? '是' : '否',
                    level: scope.row.isAdmin ? 'ok' : 'idle',
                  }),
                }),
                h(ElTableColumn, { label: '操作', minWidth: 250 }, {
                  default: (scope: { row: UserRow }) => actions(scope.row),
                }),
              ],
            }),
            h('div', { class: 'sp-pager' }, [
              h(ElPagination, {
                currentPage: pageNo.value,
                'onUpdate:currentPage': (v: number) => { pageNo.value = v },
                pageSize: PAGE_SIZE,
                total: filteredUsers.value.length,
                layout: 'prev, pager, next',
                background: true,
                small: true,
              }),
            ]),
          ]),

        // ── AI 成员（只读，独立一表）───────────────────────────────────
        section('AI 成员', '身份与行为由插件管理 —— 提示词与预算在「Agent 配置」页调。',
          [
            h(ElTable, { data: agentsList.value, size: 'small' }, {
              default: () => [
                h(ElTableColumn, { prop: 'displayName', label: '名称', width: 160 }),
                h(ElTableColumn, { prop: 'id', label: 'id', minWidth: 160 }),
                h(ElTableColumn, { label: '说明', minWidth: 220 }, {
                  default: () => '由插件注册表管理',
                }),
              ],
            }),
          ]),
      ]

      return h('div', { class: 'k-content sp-admin-wrap' }, [
        h(ThemeStyle),
        me.value === null
          ? h(ElEmpty, { description: '正在检查权限…' })
          : (me.value ? panel() : denied()),
        // 修改密码弹窗（el-dialog + el-form + el-input showPassword）。
        h(ElDialog, {
          modelValue: pwVisible.value,
          'onUpdate:modelValue': (v: boolean) => { pwVisible.value = v },
          title: `修改密码 —— ${pwTarget.value?.displayName ?? ''}（${pwTarget.value?.username ?? ''}）`,
          width: 420,
        }, {
          default: () => h(ElForm, { labelPosition: 'top' }, {
            default: () => h(ElFormItem, { label: '新密码' }, {
              default: () => h(ElInput, {
                modelValue: pwValue.value,
                'onUpdate:modelValue': (v: string) => { pwValue.value = v },
                type: 'password',
                showPassword: true,
                placeholder: '输入新密码',
              }),
            }),
          }),
          footer: () => h('span', null, [
            h(ElButton, { onClick: () => { pwVisible.value = false } }, { default: () => '取消' }),
            h(ElButton, {
              type: 'primary', loading: pwBusy.value, disabled: !pwValue.value,
              onClick: () => void doResetPassword(),
            }, { default: () => '确定' }),
          ]),
        }),
      ])
    }
  },
})

// ── 页面注册（官方约定，仿 auth 包）──────────────────────────────────────
interface PageCtx {
  client: {
    router: {
      page(options: { path: string; name: string; order?: number; component: unknown }): void
    }
  }
}

export default function main(ctx: PageCtx) {
  ctx.client.router.page({
    path: '/admin',
    name: '账号管理',
    order: 900,
    icon: 'user', component: AdminPage,
  })
}
