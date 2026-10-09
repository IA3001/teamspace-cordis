// 账号管理页（客户端）—— 2026-10-01 新增，挂在 5172 调试控制台。
//
// 结构：onMounted 先验证独立 Admin session；未登录时显示后台凭据登录表单。
//
// 表列：Team 用户显示名 / 用户名 / id / 创建时间 / 操作。后台管理员不在 Team users 表中。
//
// 所有操作成功后刷新列表；失败把 { error, detail } 显示在页首 el-alert。
//
// 鉴权：RPC 首参使用独立 localStorage 'admin_token'；绝不复用 Team token。
//
// 铁律 1：只用外壳全局注册的 el-* / k-*（resolveComponent），零 import
// element-plus、零手写样式、零内联样式。
import { computed, defineComponent, h, onMounted, ref, resolveComponent } from 'vue'
import { useRpc } from '@cordisjs/client'
import { ThemeStyle } from 'space-client-ui-shared/client/theme.ts'
import { pageHead, status, section, actionsRow, loginGate } from 'space-client-ui-shared/client/console.ts'

/** 用户行（users RPC 的返回形状 = PublicUser）。 */
interface UserRow {
  id: string
  username: string
  displayName: string
  kind: 'human' | 'agent'
  teamRole?: 'dri' | 'member'
  createdAt: string
}

interface MeRow { id: string; username: string }
interface ApiShape { baseURL: string; model: string; hasKey: boolean; keyTail: string; timeoutMs?: number }
interface ApiConfig {
  text: ApiShape
  embedding: ApiShape
  webSearch: ApiShape
  status: { text: boolean; embedding: boolean }
}
interface PluginRow {
  id: string
  name: string
  status: string
  config: Record<string, unknown>
}
interface SandboxApprovalRow {
  id: string; agentId: string; sessionId: string | null; sourcePath: string; reason: string
  status: 'pending' | 'approved' | 'rejected'; createdAt: string; decidedAt: string | null
  decidedBy: string | null; decisionNote: string; deliveryPath: string | null
}

/** 写操作 RPC 的返回：{ ok } 或 { error, detail }（null = 未放行）。 */
interface WriteResult {
  ok?: boolean
  error?: string
  detail?: string
}

/** 后台独立 token。浏览器 origin/storage 与 Teamspace 分离。 */
const TOKEN_KEY = 'admin_token'
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
      plugins(token: string): Promise<PluginRow[] | null>
      createUser(token: string, input: { username: string; password: string; displayName?: string; teamRole: 'dri' | 'member' }): Promise<WriteResult | null>
      getRegisterEnabled(token: string): Promise<{ enabled: boolean } | null>
      setRegisterEnabled(token: string, v: boolean): Promise<WriteResult | null>
      resetPassword(token: string, userId: string, password: string): Promise<WriteResult | null>
      removeUser(token: string, userId: string): Promise<WriteResult | null>
      getApiConfig(token: string): Promise<ApiConfig | null>
      saveTextApi(token: string, cfg: { baseURL?: string; model?: string; apiKey?: string; timeoutMs?: number }): Promise<WriteResult | null>
      saveEmbeddingApi(token: string, cfg: { baseURL?: string; model?: string; apiKey?: string }): Promise<WriteResult | null>
      saveWebSearchApi(token: string, cfg: { baseURL?: string; apiKey?: string }): Promise<WriteResult | null>
      testTextApi(token: string): Promise<WriteResult | null>
      testEmbeddingApi(token: string): Promise<WriteResult | null>
      testWebSearchApi(token: string): Promise<WriteResult | null>
      sandboxApprovals(token: string): Promise<SandboxApprovalRow[] | null>
      decideSandboxApproval(token: string, id: string, decision: 'approved' | 'rejected', note?: string): Promise<(WriteResult & { request?: SandboxApprovalRow }) | null>
      logout(token: string): Promise<WriteResult>
      login(username: string, password: string): Promise<{ token: string; user: MeRow } | { error: string; detail?: string }>
    }>()

    // 探测态：null = 还在 me()；undefined = 未登录（出登录表单）；
    // 对象 = 当前 Admin principal（出管理页面）。
    const me = ref<MeRow | null | undefined>(null)
    const users = ref([]) as { value: UserRow[] }
    const plugins = ref([]) as { value: PluginRow[] }
    const sandboxApprovals = ref([]) as { value: SandboxApprovalRow[] }
    // 页首失败条（所有写操作的 {error, detail} 都落这里）。
    const error = ref('')
    // 刷新忙标记（表格 v-loading）。
    const busy = ref(false)
    // 注册开关状态（A4）。
    const regOpen = ref(true)
    const regBusy = ref(false)
    const apiConfig = ref<ApiConfig | null>(null)
    const apiKeys = ref({ text: '', embedding: '', webSearch: '' })
    const apiNotice = ref('')
    const apiBusy = ref('')
    // 筛选 + 分页（用户反馈①⑤，2026-10-07）。
    const query = ref('')
    const pageNo = ref(1)
    const PAGE_SIZE = 10

    // ── 修改密码弹窗状态 ──────────────────────────────────────────────
    const pwVisible = ref(false)
    const pwTarget = ref<UserRow | null>(null)
    const pwValue = ref('')
    const pwBusy = ref(false)
    const createOpen = ref(false)
    const newUsername = ref('')
    const newDisplayName = ref('')
    const newPassword = ref('')
    const newTeamRole = ref<'dri' | 'member'>('member')
    const createBusy = ref(false)

    async function refresh() {
      busy.value = true
      try {
        const list = await rpc.value.users(getToken())
        users.value = Array.isArray(list) ? list : []
        const pluginList = await rpc.value.plugins(getToken())
        plugins.value = Array.isArray(pluginList) ? pluginList : []
        const approvalList = await rpc.value.sandboxApprovals(getToken())
        sandboxApprovals.value = Array.isArray(approvalList) ? approvalList : []
        const reg = await rpc.value.getRegisterEnabled(getToken())
        if (reg) regOpen.value = reg.enabled
        apiConfig.value = await rpc.value.getApiConfig(getToken())
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
      const m = await rpc.value.me(getToken())
      if (!m) {
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

    async function doCreateUser() {
      createBusy.value = true
      try {
        const result = await rpc.value.createUser(getToken(), {
          username: newUsername.value,
          displayName: newDisplayName.value,
          password: newPassword.value,
          teamRole: newTeamRole.value,
        })
        if (await handleResult(result)) {
          createOpen.value = false
          newUsername.value = ''
          newDisplayName.value = ''
          newPassword.value = ''
          newTeamRole.value = 'member'
        }
      } finally { createBusy.value = false }
    }

    async function saveApi(kind: 'text' | 'embedding' | 'webSearch') {
      if (!apiConfig.value) return
      apiBusy.value = kind
      apiNotice.value = ''
      const cfg = apiConfig.value[kind]
      const input = { baseURL: cfg.baseURL, model: cfg.model, apiKey: apiKeys.value[kind] || undefined }
      const result = kind === 'text'
        ? await rpc.value.saveTextApi(getToken(), { ...input, timeoutMs: cfg.timeoutMs })
        : kind === 'embedding'
          ? await rpc.value.saveEmbeddingApi(getToken(), input)
          : await rpc.value.saveWebSearchApi(getToken(), input)
      apiBusy.value = ''
      if (result?.ok) {
        apiKeys.value[kind] = ''
        apiNotice.value = '配置已保存；密钥不会回显。'
        await refresh()
      } else apiNotice.value = result?.detail ?? result?.error ?? '保存失败'
    }
    async function testApi(kind: 'text' | 'embedding' | 'webSearch') {
      apiBusy.value = `test-${kind}`
      const result = kind === 'text'
        ? await rpc.value.testTextApi(getToken())
        : kind === 'embedding'
          ? await rpc.value.testEmbeddingApi(getToken())
          : await rpc.value.testWebSearchApi(getToken())
      apiBusy.value = ''
      apiNotice.value = result?.detail ?? result?.error ?? '测试失败'
    }

    async function decideApproval(row: SandboxApprovalRow, decision: 'approved' | 'rejected') {
      const note = decision === 'rejected' ? window.prompt('拒绝原因（可留空）', '') ?? null : ''
      if (note === null) return
      const result = await rpc.value.decideSandboxApproval(getToken(), row.id, decision, note)
      await handleResult(result)
    }
    async function doLogout() {
      try { await rpc.value.logout(getToken()) } catch { /* idempotent */ }
      localStorage.removeItem(TOKEN_KEY)
      location.reload()
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
      const ElDescriptions = resolveComponent('el-descriptions') as unknown as string
      const ElDescriptionsItem = resolveComponent('el-descriptions-item') as unknown as string

      // ── 后台独立账号登录 ──
      const denied = () => loginGate({
      brand: 'TS',
      title: '账号管理',
      desc: '使用独立后台管理员账号登录。开发/测试默认 admin / 123456；生产环境使用部署配置的凭据。',
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

      // ── 操作列（Team 人类账号可管理；AI 身份只读）──
      const actions = (row: UserRow) => {
        if (row.kind !== 'human') {
          return h(ElTag, { type: 'info', size: 'small' }, {
            default: () => 'AI 身份由插件管理',
          })
        }
        const isSelf = false
        return h('span', null, [
          // 修改密码：按钮 → 弹窗（el-dialog 内 el-input 新密码）。
          h(ElButton, { size: 'small', link: true, type: 'primary', onClick: () => openPw(row) }, {
            default: () => '修改密码',
          }),
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
          'Team 账号与后台管理员身份完全分离；会话成员管理在团队空间页操作。',
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
              h(ElButton, { type: 'primary', onClick: () => { createOpen.value = true } }, { default: () => '创建 Team 账号' }),
              h(ElButton, {
                text: true, size: 'small', type: 'danger', style: 'margin-left:auto',
                onClick: () => void doLogout(),
              }, { default: () => '登出' }),
            ]),
            h(ElTable, { data: pagedUsers.value, loading: busy.value }, {
              default: () => [
                h(ElTableColumn, { prop: 'displayName', label: '显示名', width: 130 }),
                h(ElTableColumn, { prop: 'username', label: '用户名', width: 140 }),
                h(ElTableColumn, { prop: 'id', label: 'id', width: 150 }),
                h(ElTableColumn, { label: '团队角色', width: 110 }, {
                  default: (scope: { row: UserRow }) => scope.row.teamRole === 'dri' ? 'DRI' : '普通成员',
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
        section('插件状态', '显示当前进程实际加载的插件及其配置摘要。插件启停由系统配置决定；此页不提供运行时启停。敏感配置值已隐藏。', [
          h(ElTable, { data: plugins.value, size: 'small', rowKey: 'id' }, {
            default: () => [
              h(ElTableColumn, { prop: 'id', label: '插件 ID', minWidth: 160 }),
              h(ElTableColumn, { prop: 'name', label: '入口', minWidth: 280 }),
              h(ElTableColumn, { prop: 'status', label: '状态', width: 150 }, {
                default: (scope: { row: PluginRow }) => h(ElTag, {
                  type: scope.row.status === '运行中' ? 'success' : scope.row.status === '配置停用' ? 'info' : 'warning',
                  size: 'small',
                }, { default: () => scope.row.status }),
              }),
              h(ElTableColumn, { label: '配置摘要', minWidth: 300 }, {
                default: (scope: { row: PluginRow }) => h(ElDescriptions, { column: 1, size: 'small', border: false }, {
                  default: () => Object.entries(scope.row.config ?? {}).map(([key, value]) => h(ElDescriptionsItem, { label: key }, {
                    default: () => typeof value === 'object' ? JSON.stringify(value) : String(value),
                  })),
                }),
              }),
            ],
          }),
        ]),
        section('沙箱越界审批', '申请仅对后台管理员可见。批准会将单个普通文件复制到团队共享工作区，Agent 只能从共享区只读访问；不会挂载原始宿主机路径。', [
          h(ElTable, { data: sandboxApprovals.value, size: 'small', rowKey: 'id' }, {
            default: () => [
              h(ElTableColumn, { prop: 'createdAt', label: '申请时间', width: 170 }, { default: (s: { row: SandboxApprovalRow }) => fmtTime(s.row.createdAt) }),
              h(ElTableColumn, { prop: 'agentId', label: 'Agent', width: 130 }),
              h(ElTableColumn, { prop: 'sessionId', label: '会话', width: 130 }),
              h(ElTableColumn, { prop: 'sourcePath', label: '申请路径', minWidth: 240 }),
              h(ElTableColumn, { prop: 'reason', label: '理由', minWidth: 180 }),
              h(ElTableColumn, { prop: 'status', label: '状态', width: 100 }, { default: (s: { row: SandboxApprovalRow }) => s.row.status === 'pending' ? '待处理' : s.row.status === 'approved' ? '已批准' : '已拒绝' }),
              h(ElTableColumn, { label: '决定 / 交付路径', minWidth: 230 }, { default: (s: { row: SandboxApprovalRow }) => [s.row.decisionNote, s.row.deliveryPath].filter(Boolean).join(' · ') || '—' }),
              h(ElTableColumn, { label: '操作', width: 170, fixed: 'right' }, { default: (s: { row: SandboxApprovalRow }) => s.row.status !== 'pending' ? '—' : h(ElSpace, null, { default: () => [
                h(ElButton, { size: 'small', type: 'success', onClick: () => void decideApproval(s.row, 'approved') }, { default: () => '批准并复制' }),
                h(ElButton, { size: 'small', type: 'danger', onClick: () => void decideApproval(s.row, 'rejected') }, { default: () => '拒绝' }),
              ] }) }),
            ],
          }),
        ]),
        section('模型与 API 配置', '文字模型、Embedding 与网页搜索分别配置；密钥只写入，不回显。', [
          apiNotice.value ? h('div', { class: 'sp-note' }, apiNotice.value) : null,
          ...([
            ['text', '文字模型 API', true],
            ['embedding', 'Embedding API', true],
            ['webSearch', '网页搜索 API', false],
          ] as const).map(([kind, title, hasModel]) => {
            const cfg = apiConfig.value?.[kind]
            if (!cfg) return null
            return h('div', null, [
              h(ElText, { tag: 'strong' }, { default: () => title }),
              h(ElForm, { labelPosition: 'top' }, {
                default: () => [
                  h(ElFormItem, { label: 'API 地址' }, { default: () => h(ElInput, {
                    modelValue: cfg.baseURL,
                    'onUpdate:modelValue': (v: string) => { cfg.baseURL = v },
                    placeholder: 'https://provider.example/v1', clearable: true,
                  }) }),
                  hasModel ? h(ElFormItem, { label: '模型名' }, { default: () => h(ElInput, {
                    modelValue: cfg.model,
                    'onUpdate:modelValue': (v: string) => { cfg.model = v },
                    placeholder: '模型 ID', clearable: true,
                  }) }) : null,
                  h(ElFormItem, { label: cfg.hasKey ? `API 密钥（已配置 · 尾号 ${cfg.keyTail}；输入 - 可清除）` : 'API 密钥' }, {
                    default: () => h(ElInput, {
                      modelValue: apiKeys.value[kind],
                      'onUpdate:modelValue': (v: string) => { apiKeys.value[kind] = v },
                      type: 'password', showPassword: true,
                      placeholder: cfg.hasKey ? '留空保留现有密钥' : '输入 API 密钥',
                    }),
                  }),
                ],
              }),
              kind === 'text' && cfg.timeoutMs !== undefined
                ? h(ElFormItem, { label: '超时毫秒' }, { default: () => h(ElInput, {
                    modelValue: String(cfg.timeoutMs),
                    'onUpdate:modelValue': (v: string) => { cfg.timeoutMs = Number(v) || 60000 },
                  }) })
                : null,
              h(ElSpace, null, { default: () => [
                h(ElButton, { type: 'primary', loading: apiBusy.value === kind, onClick: () => void saveApi(kind) }, { default: () => '保存' }),
                h(ElButton, { loading: apiBusy.value === `test-${kind}`, onClick: () => void testApi(kind) }, { default: () => '连通测试' }),
              ] }),
            ])
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
        h(ElDialog, {
          modelValue: createOpen.value,
          'onUpdate:modelValue': (v: boolean) => { createOpen.value = v },
          title: '创建 Team 账号',
        }, {
          default: () => h(ElForm, { labelPosition: 'top' }, {
            default: () => [
              h(ElFormItem, { label: '用户名' }, { default: () => h(ElInput, {
                modelValue: newUsername.value,
                'onUpdate:modelValue': (v: string) => { newUsername.value = v },
                autocomplete: 'off',
              }) }),
              h(ElFormItem, { label: '显示名' }, { default: () => h(ElInput, {
                modelValue: newDisplayName.value,
                'onUpdate:modelValue': (v: string) => { newDisplayName.value = v },
                autocomplete: 'off',
              }) }),
              h(ElFormItem, { label: '初始密码' }, { default: () => h(ElInput, {
                modelValue: newPassword.value,
                'onUpdate:modelValue': (v: string) => { newPassword.value = v },
                type: 'password', showPassword: true, autocomplete: 'new-password',
              }) }),
              h(ElFormItem, { label: '团队角色' }, { default: () => h(ElSelect, {
                modelValue: newTeamRole.value,
                'onUpdate:modelValue': (v: 'dri' | 'member') => { newTeamRole.value = v },
              }, { default: () => [
                h(ElOption, { label: '普通成员', value: 'member' }),
                h(ElOption, { label: 'DRI', value: 'dri' }),
              ] }) }),
            ],
          }),
          footer: () => h(ElSpace, null, { default: () => [
            h(ElButton, { onClick: () => { createOpen.value = false } }, { default: () => '取消' }),
            h(ElButton, { type: 'primary', loading: createBusy.value, disabled: !newUsername.value || !newPassword.value, onClick: () => void doCreateUser() }, { default: () => '创建' }),
          ] }),
        }),
      ])
    }
  },
})

// ── 页面注册（官方约定，仿 auth 包）──────────────────────────────────────
interface PageCtx {
  client: {
    router: {
      page(options: { path: string; name: string; order?: number; icon?: string; component: unknown }): void
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
