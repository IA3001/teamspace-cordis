// 账号管理页（客户端）—— 2026-10-01 新增，挂在 5172 调试控制台。
//
// 后台面板按用户决定免登录开放；此页所有管理 RPC 均不要求会话令牌。
//
// 表列：Team 用户显示名 / 用户名 / id / 创建时间 / 操作。后台管理员不在 Team users 表中。
//
// 页面操作失败显示在页首；弹窗操作的失败反馈留在对应弹窗内，避免被遮挡。
//
// 注意：公开管理入口，不读取 Team token 或后台 session。
//
// 铁律 1：只用外壳全局注册的 el-* / k-*（resolveComponent），零 import
// element-plus、零手写样式、零内联样式。
import { computed, defineComponent, h, onMounted, onUnmounted, ref, resolveComponent } from 'vue'
import type { Component, VNodeChild } from 'vue'
import { useRoute, useRouter, useRpc } from '@cordisjs/client'
import { ThemeStyle } from 'space-client-ui-shared/client/theme.ts'
import { ICONS, pageHead, section, actionsRow } from 'space-client-ui-shared/client/console.ts'
import { userFacingFailure } from 'space-client-ui-shared/client/errors.ts'

/** 用户行（users RPC 的返回形状 = PublicUser）。 */
interface UserRow {
  id: string
  username: string
  displayName: string
  kind: 'human' | 'agent'
  teamRole?: 'dri' | 'member'
  createdAt: string
}

interface ApiShape { baseURL: string; model: string; hasKey: boolean; keyTail: string; timeoutMs?: number }
interface EmbeddingIndexStatus {
  state: 'disabled' | 'pending' | 'running' | 'ready' | 'failed'
  model: string; total: number; completed: number; failed: number; error: string; updatedAt: string
}
interface ApiConfig {
  text: ApiShape
  textProfiles: Array<{ id: string; name: string; baseURL: string; model: string; maxOutputTokens: number | null; hasKey: boolean; keyTail: string }>
  activeTextProfileRef: string
  embedding: ApiShape
  embeddingProfiles: Array<{ id: string; name: string; baseURL: string; model: string; hasKey: boolean; keyTail: string }>
  activeEmbeddingProfileRef: string
  webSearch: ApiShape
  webSearchProfiles: Array<{ id: string; name: string; baseURL: string; hasKey: boolean; keyTail: string }>
  activeWebSearchProfileRef: string
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
  status: 'pending' | 'approving' | 'approved' | 'rejected'; createdAt: string; decidedAt: string | null
  decidedBy: string | null; decisionNote: string; deliveryPath: string | null
}

/** 写操作 RPC 的返回：{ ok } 或 { error, detail }（null = 未放行）。 */
interface WriteResult {
  ok?: boolean
  error?: string
  detail?: string
}

/** RPC 仍保留兼容参数；开放后台不附带任何 session token。 */
const getToken = () => ''

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
    const rpc = useRpc<{
      users(token: string): Promise<UserRow[] | null>
      plugins(token: string): Promise<PluginRow[] | null>
      createUser(token: string, input: { username: string; password: string; displayName?: string; teamRole: 'dri' | 'member' }): Promise<WriteResult | null>
      getRegisterEnabled(token: string): Promise<{ enabled: boolean } | null>
      setRegisterEnabled(token: string, v: boolean): Promise<WriteResult | null>
      resetPassword(token: string, userId: string, password: string): Promise<WriteResult | null>
      removeUser(token: string, userId: string): Promise<WriteResult | null>
      getApiConfig(token: string): Promise<ApiConfig | null>
      getEmbeddingIndexStatus(token: string): Promise<EmbeddingIndexStatus | null>
      retryEmbeddingIndex(token: string): Promise<WriteResult | null>
      fetchTextModels(token: string, input: { target: 'text' | 'embedding' | 'profile' | 'embeddingProfile'; profileId?: string; baseURL?: string; apiKey?: string }): Promise<{ ok: boolean; models?: string[]; detail?: string; credentialSource?: string } | null>
      saveServiceProfile(token: string, kind: 'embedding' | 'webSearch', input: { id?: string; name?: string; baseURL?: string; model?: string; apiKey?: string }): Promise<WriteResult | null>
      activateServiceProfile(token: string, kind: 'embedding' | 'webSearch', id: string): Promise<WriteResult | null>
      removeServiceProfile(token: string, kind: 'embedding' | 'webSearch', id: string): Promise<WriteResult | null>
      saveTextApi(token: string, cfg: { baseURL?: string; model?: string; apiKey?: string; timeoutMs?: number }): Promise<WriteResult | null>
      saveTextProfile(token: string, cfg: { id: string; name: string; baseURL: string; model: string; apiKey?: string; maxOutputTokens: number | null }): Promise<WriteResult | null>
      removeTextProfile(token: string, id: string): Promise<WriteResult | null>
      setDefaultTextProfile(token: string, id: string): Promise<WriteResult | null>
      testTextProfile(token: string, id: string): Promise<WriteResult | null>
      testTextProfileStream(token: string, id: string): Promise<WriteResult | null>
      saveEmbeddingApi(token: string, cfg: { baseURL?: string; model?: string; apiKey?: string }): Promise<WriteResult | null>
      saveWebSearchApi(token: string, cfg: { baseURL?: string; apiKey?: string }): Promise<WriteResult | null>
      testTextApi(token: string): Promise<WriteResult | null>
      testEmbeddingApi(token: string, profileId?: string): Promise<WriteResult | null>
      testWebSearchApi(token: string, profileId?: string): Promise<WriteResult | null>
      sandboxApprovals(token: string): Promise<SandboxApprovalRow[] | null>
      decideSandboxApproval(token: string, id: string, decision: 'approved' | 'rejected', note?: string): Promise<(WriteResult & { request?: SandboxApprovalRow }) | null>
    }>()

    const users = ref([]) as { value: UserRow[] }
    const plugins = ref([]) as { value: PluginRow[] }
    const pluginSearch = ref('')
    const pluginStatusFilter = ref('')
    const pluginPageNo = ref(1)
    const PLUGIN_PAGE_SIZE = 15
    const filteredPlugins = computed(() => {
      const query = pluginSearch.value.trim().toLocaleLowerCase()
      return plugins.value.filter((plugin) => {
        const statusMatch = !pluginStatusFilter.value ||
          (pluginStatusFilter.value === 'running' && plugin.status === '运行中') ||
          (pluginStatusFilter.value === 'disabled' && plugin.status === '配置停用') ||
          (pluginStatusFilter.value === 'other' && !['运行中', '配置停用'].includes(plugin.status))
        const queryMatch = !query ||
          `${plugin.id} ${plugin.name} ${plugin.status} ${JSON.stringify(plugin.config ?? {})}`.toLocaleLowerCase().includes(query)
        return statusMatch && queryMatch
      })
    })
    const pagedPlugins = computed(() =>
      filteredPlugins.value.slice((pluginPageNo.value - 1) * PLUGIN_PAGE_SIZE, pluginPageNo.value * PLUGIN_PAGE_SIZE))
    const sandboxApprovals = ref([]) as { value: SandboxApprovalRow[] }
    // 页首失败条（所有写操作的 {error, detail} 都落这里）。
    const error = ref('')
    const loadFailed = ref(false)
    const dataLoaded = ref(false)
    // 刷新忙标记（表格 v-loading）。
    const busy = ref(false)
    // 注册开关状态（A4）。
    const regOpen = ref(true)
    const regBusy = ref(false)
    const regError = ref('')
    const apiConfig = ref<ApiConfig | null>(null)
    const apiKeys = ref({ text: '', embedding: '', webSearch: '' })
    const apiNotice = ref('')
    const serviceFeedbackType = ref<'info' | 'success' | 'error'>('info')
    const embeddingIndex = ref<EmbeddingIndexStatus | null>(null)
    const indexLoadError = ref('')
    const indexRetryBusy = ref(false)
    let indexFetching = false
    const apiSectionFeedback = ref({
      kind: '' as 'text' | 'embedding' | 'webSearch' | '',
      message: '',
      type: 'info' as 'success' | 'error' | 'info',
    })
    const apiBusy = ref('')
    const activeModelCategory = ref<'text' | 'embedding' | 'webSearch'>('text')
    const selectedModelProvider = ref('default')
    const profileDraft = ref({ id: '', name: '', baseURL: '', model: '', apiKey: '', maxOutputTokens: null as number | null })
    const serviceDraft = ref({ id: '', name: '', baseURL: '', model: '', apiKey: '', hasKey: false, keyTail: '' })
    const modelCatalogs = ref<Record<string, { models: string[]; query: string; message: string; type: 'info' | 'success' | 'error' }>>({})
    function modelCatalogKey(target: 'text' | 'embedding' | 'profile', draft?: { id: string; baseURL: string }) {
      const cfg = draft ?? (target === 'profile' ? profileDraft.value : apiConfig.value?.[target])
      return JSON.stringify([target, draft ? 'service-profile' : target === 'profile' ? 'text-profile' : 'default',
        draft?.id ?? (target === 'profile' ? profileDraft.value.id : 'default'), cfg?.baseURL.trim() ?? ''])
    }
    function invalidateModelCatalog(target: 'text' | 'embedding' | 'profile', draft?: { id: string; baseURL: string }) {
      delete modelCatalogs.value[modelCatalogKey(target, draft)]
    }
    // 筛选 + 分页（用户反馈①⑤，2026-10-07）。
    const query = ref('')
    const accountRoleFilter = ref('')
    const pageNo = ref(1)
    const PAGE_SIZE = 15

    // ── 修改密码弹窗状态 ──────────────────────────────────────────────
    const pwVisible = ref(false)
    const pwTarget = ref<UserRow | null>(null)
    const pwValue = ref('')
    const pwBusy = ref(false)
    const pwError = ref('')
    const createOpen = ref(false)
    const newUsername = ref('')
    const newDisplayName = ref('')
    const newPassword = ref('')
    const newTeamRole = ref<'dri' | 'member'>('member')
    const createBusy = ref(false)
    const createError = ref('')
    const approvalDialogOpen = ref(false)
    const approvalTarget = ref<SandboxApprovalRow | null>(null)
    const approvalDecision = ref<'approved' | 'rejected'>('approved')
    const approvalNote = ref('')
    const approvalBusy = ref(false)
    const approvalError = ref('')

    async function refresh() {
      busy.value = true
      loadFailed.value = false
      try {
        const [list, pluginList, approvalList, reg, config] = await Promise.all([
          rpc.value.users(getToken()),
          rpc.value.plugins(getToken()),
          rpc.value.sandboxApprovals(getToken()),
          rpc.value.getRegisterEnabled(getToken()),
          rpc.value.getApiConfig(getToken()),
        ])
        if (!list || !pluginList || !approvalList || !reg || !config) throw new Error('admin-data-unavailable')
        users.value = list
        plugins.value = pluginList
        sandboxApprovals.value = approvalList
        regOpen.value = reg.enabled
        apiConfig.value = config
        dataLoaded.value = true
        // 数据量变化后页码越界收口。
        if (pageNo.value > Math.ceil(users.value.length / PAGE_SIZE)) pageNo.value = 1
        error.value = ''
      } catch {
        loadFailed.value = true
        error.value = userFacingFailure('加载后台管理数据')
      } finally {
        busy.value = false
      }
    }

    async function toggleRegister(v: boolean | string | number) {
      if (regBusy.value) return
      const previous = regOpen.value
      const next = Boolean(v)
      regOpen.value = next
      regBusy.value = true
      regError.value = ''
      try {
        const r = await rpc.value.setRegisterEnabled(getToken(), next)
        if (r && r.ok) {
          error.value = ''
        } else {
          const d = r as { error?: string; detail?: string } | null
          regOpen.value = previous
          regError.value = d?.detail ?? d?.error ?? '修改注册设置失败，请重试。'
        }
      } catch {
        regOpen.value = previous
        regError.value = userFacingFailure('修改注册设置')
      } finally { regBusy.value = false }
    }

    async function refreshEmbeddingIndex() {
      if (indexFetching || route.path !== '/admin/models' || activeModelCategory.value !== 'embedding') return
      indexFetching = true
      try {
        const result = await rpc.value.getEmbeddingIndexStatus(getToken())
        if (!result) throw new Error('index-status-unavailable')
        embeddingIndex.value = result
        indexLoadError.value = ''
      } catch { indexLoadError.value = userFacingFailure('读取向量索引进度') }
      finally { indexFetching = false }
    }
    async function retryEmbeddingIndex() {
      if (indexRetryBusy.value) return
      indexRetryBusy.value = true
      try {
        const result = await rpc.value.retryEmbeddingIndex(getToken())
        if (!result?.ok) throw new Error('index-retry-failed')
        await refreshEmbeddingIndex()
      } catch { indexLoadError.value = userFacingFailure('重试向量索引任务') }
      finally { indexRetryBusy.value = false }
    }
    let indexPoll: ReturnType<typeof setInterval> | undefined
    onMounted(() => {
      void refresh()
      indexPoll = setInterval(() => void refreshEmbeddingIndex(), 1500)
    })
    onUnmounted(() => { if (indexPoll) clearInterval(indexPoll) })

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
      pwError.value = ''
      pwVisible.value = true
    }

    async function doResetPassword() {
      if (!pwTarget.value || pwBusy.value) return
      pwBusy.value = true
      pwError.value = ''
      try {
        const r = await rpc.value.resetPassword(getToken(), pwTarget.value.id, pwValue.value)
        if (!r?.ok) {
          pwError.value = r?.detail ?? r?.error ?? '修改失败，请重试。'
          return
        }
        error.value = ''
        pwValue.value = ''
        pwVisible.value = false
        await refresh()
      } catch {
        pwError.value = userFacingFailure('修改账号密码')
      } finally {
        pwBusy.value = false
      }
    }

    async function doCreateUser() {
      if (createBusy.value) return
      createBusy.value = true
      createError.value = ''
      try {
        const result = await rpc.value.createUser(getToken(), {
          username: newUsername.value,
          displayName: newDisplayName.value,
          password: newPassword.value,
          teamRole: newTeamRole.value,
        })
        if (!result?.ok) {
          createError.value = result?.detail ?? result?.error ?? '创建失败，请重试。'
          return
        }
        error.value = ''
        createOpen.value = false
        newUsername.value = ''
        newDisplayName.value = ''
        newPassword.value = ''
        newTeamRole.value = 'member'
        await refresh()
      } catch {
        createError.value = userFacingFailure('创建 Team 账号')
      } finally { createBusy.value = false }
    }

    async function saveApi(kind: 'text' | 'embedding' | 'webSearch') {
      if (!apiConfig.value || apiBusy.value) return
      apiBusy.value = kind
      apiNotice.value = ''
      apiSectionFeedback.value = { kind, message: '', type: 'info' }
      const cfg = apiConfig.value[kind]
      const input = { baseURL: cfg.baseURL, model: cfg.model, apiKey: apiKeys.value[kind] || undefined }
      try {
        const result = kind === 'text'
          ? await rpc.value.saveTextApi(getToken(), { ...input, timeoutMs: cfg.timeoutMs })
          : kind === 'embedding'
            ? await rpc.value.saveEmbeddingApi(getToken(), input)
            : await rpc.value.saveWebSearchApi(getToken(), input)
        if (result?.ok) {
          apiKeys.value[kind] = ''
          apiSectionFeedback.value = { kind, message: '配置已保存；密钥不会回显。', type: 'success' }
          await refresh()
        } else apiSectionFeedback.value = {
          kind, message: result?.detail ?? result?.error ?? '保存失败', type: 'error',
        }
      } catch {
        apiSectionFeedback.value = {
          kind,
          message: userFacingFailure(kind === 'text' ? '保存文字模型配置' : kind === 'embedding' ? '保存 Embedding 配置' : '保存网页搜索配置'),
          type: 'error',
        }
      } finally { apiBusy.value = '' }
    }
    async function testApi(kind: 'text' | 'embedding' | 'webSearch', profileId?: string) {
      if (apiBusy.value) return
      apiBusy.value = `test-${kind}`
      apiNotice.value = ''
      apiSectionFeedback.value = { kind, message: '', type: 'info' }
      try {
        const result = kind === 'text'
          ? await rpc.value.testTextApi(getToken())
          : kind === 'embedding'
            ? await rpc.value.testEmbeddingApi(getToken(), profileId)
            : await rpc.value.testWebSearchApi(getToken(), profileId)
        apiSectionFeedback.value = {
          kind, message: result?.detail ?? result?.error ?? '测试失败',
          type: result?.ok ? 'success' : 'error',
        }
      } catch {
        apiSectionFeedback.value = {
          kind,
          message: userFacingFailure(kind === 'text' ? '测试文字模型连接' : kind === 'embedding' ? '测试 Embedding 连接' : '测试网页搜索连接'),
          type: 'error',
        }
      } finally { apiBusy.value = '' }
    }
    async function fetchModels(target: 'text' | 'embedding' | 'profile', draft?: { id: string; baseURL: string; apiKey: string }) {
      if (apiBusy.value) return
      const cfg = draft ?? (target === 'profile' ? profileDraft.value : apiConfig.value?.[target])
      if (!cfg) return
      apiBusy.value = `models-${target}`
      apiNotice.value = ''
      const catalogKey = modelCatalogKey(target, draft)
      modelCatalogs.value[catalogKey] = { models: [], query: '', message: '', type: 'info' }
      const catalog = modelCatalogs.value[catalogKey]
      try {
        const result = await rpc.value.fetchTextModels(getToken(), {
          target: draft ? 'embeddingProfile' : target,
          ...(draft ? { profileId: draft.id } : target === 'profile' ? { profileId: profileDraft.value.id } : {}),
          baseURL: cfg.baseURL,
          apiKey: draft ? draft.apiKey : target === 'profile' ? profileDraft.value.apiKey : apiKeys.value[target],
        })
        if (result?.ok && result.models) {
          catalog.models = result.models
          const source = result.credentialSource ? `本次使用：${result.credentialSource}。` : ''
          catalog.message = `已获取 ${result.models.length} 个模型，请从列表选择。${source}`
          catalog.type = 'success'
        } else {
          const source = result?.credentialSource ? ` 本次使用：${result.credentialSource}。` : ''
          const detail = result?.detail ?? '获取模型列表失败。'
          const message = `${detail}${detail.includes('本次使用：') ? '' : source}`
          catalog.message = message
          catalog.type = 'error'
        }
      } catch {
        const message = userFacingFailure('获取供应商模型列表')
        catalog.message = message
        catalog.type = 'error'
      } finally { apiBusy.value = '' }
    }
    function apiFeedback(kind: 'text' | 'embedding' | 'webSearch', ElAlert: string) {
      if (apiSectionFeedback.value.kind !== kind || !apiSectionFeedback.value.message) return null
      return h(ElAlert, {
        class: 'sp-admin-api-feedback',
        title: apiSectionFeedback.value.message,
        type: apiSectionFeedback.value.type,
        showIcon: true,
        closable: true,
        onClose: () => { apiSectionFeedback.value = { kind: '', message: '', type: 'info' } },
      })
    }
    async function saveTextProfile() {
      if (apiBusy.value) return
      apiBusy.value = 'save-profile'
      apiNotice.value = ''
      try {
        const result = await rpc.value.saveTextProfile(getToken(), {
          ...profileDraft.value,
          apiKey: profileDraft.value.apiKey || undefined,
        })
        if (result?.ok) {
          profileDraft.value.apiKey = ''
          apiNotice.value = '文字模型配置已保存；密钥不会回显。'
          await refresh()
        } else apiNotice.value = result?.detail ?? result?.error ?? '保存失败'
      } catch {
        apiNotice.value = userFacingFailure('保存对话模型供应商')
      } finally { apiBusy.value = '' }
    }
    async function testTextProfile(id: string) {
      if (apiBusy.value) return
      apiBusy.value = `test-profile-${id}`
      apiNotice.value = ''; apiSectionFeedback.value = { kind: '', message: '', type: 'info' }
      try {
        const result = await rpc.value.testTextProfile(getToken(), id)
        apiSectionFeedback.value = { kind: 'text', message: `${id || '当前默认配置'}：${result?.detail ?? result?.error ?? '测试失败'}`, type: result?.ok ? 'success' : 'error' }
      } catch { apiSectionFeedback.value = { kind: 'text', type: 'error', message: userFacingFailure(`测试 ${id} 连接`) } }
      finally { apiBusy.value = '' }
    }
    async function testTextProfileStream(id: string) {
      if (apiBusy.value) return
      apiBusy.value = `test-profile-stream-${id}`
      apiNotice.value = ''; apiSectionFeedback.value = { kind: '', message: '', type: 'info' }
      try {
        const result = await rpc.value.testTextProfileStream(getToken(), id)
        apiSectionFeedback.value = { kind: 'text', message: `${id || '当前默认配置'}：${result?.detail ?? result?.error ?? '流式测试失败'}`, type: result?.ok ? 'success' : 'error' }
      } catch { apiSectionFeedback.value = { kind: 'text', type: 'error', message: userFacingFailure(`测试 ${id || '默认配置'} 流式连接`) } }
      finally { apiBusy.value = '' }
    }
    async function removeTextProfile(id: string) {
      if (apiBusy.value) return
      apiBusy.value = `remove-profile-${id}`
      try {
        const result = await rpc.value.removeTextProfile(getToken(), id)
        if (await handleResult(result)) {
          invalidateModelCatalog('profile')
          selectedModelProvider.value = 'default'
          profileDraft.value = { id: '', name: '', baseURL: '', model: '', apiKey: '', maxOutputTokens: null }
          apiNotice.value = ''
          apiSectionFeedback.value = { kind: 'text', message: '供应商配置已删除。', type: 'success' }
        } else apiSectionFeedback.value = { kind: 'text', message: result?.detail ?? result?.error ?? '删除供应商配置失败。', type: 'error' }
      } catch { apiSectionFeedback.value = { kind: 'text', message: userFacingFailure('删除文字模型配置'), type: 'error' } }
      finally { apiBusy.value = '' }
    }
    async function setDefaultTextProfile(id: string) {
      if (apiBusy.value) return
      apiBusy.value = `default-profile-${id}`
      try {
        const result = await rpc.value.setDefaultTextProfile(getToken(), id)
        await handleResult(result)
      } catch { error.value = userFacingFailure('设置默认文字模型') }
      finally { apiBusy.value = '' }
    }
    function clearApiFeedback() {
      apiNotice.value = ''; apiSectionFeedback.value = { kind: '', message: '', type: 'info' }
    }

    function editTextProfile(profile: NonNullable<ApiConfig['textProfiles']>[number]) {
      apiNotice.value = ''; apiSectionFeedback.value = { kind: '', message: '', type: 'info' }
      profileDraft.value = {
        id: profile.id, name: profile.name, baseURL: profile.baseURL, model: profile.model,
        apiKey: '', maxOutputTokens: profile.maxOutputTokens,
      }
    }

    function editServiceProfile(profile: NonNullable<ApiConfig['embeddingProfiles']>[number] | NonNullable<ApiConfig['webSearchProfiles']>[number]) {
      apiNotice.value = ''; apiSectionFeedback.value = { kind: '', message: '', type: 'info' }
      serviceDraft.value = {
        id: profile.id, name: profile.name, baseURL: profile.baseURL,
        model: 'model' in profile ? profile.model : '', apiKey: '',
        hasKey: profile.hasKey, keyTail: profile.keyTail,
      }
    }
    async function saveServiceProfile() {
      if (apiBusy.value || !['embedding', 'webSearch'].includes(activeModelCategory.value)) return
      const kind = activeModelCategory.value as 'embedding' | 'webSearch'
      apiBusy.value = `save-service-profile-${kind}`
      apiNotice.value = ''; serviceFeedbackType.value = 'info'
      try {
        const result = await rpc.value.saveServiceProfile(getToken(), kind, serviceDraft.value)
        if (!result?.ok) { serviceFeedbackType.value = 'error'; apiNotice.value = result?.detail ?? result?.error ?? '保存供应商配置失败。'; return }
        selectedModelProvider.value = serviceDraft.value.id
        await refresh()
        const saved = (kind === 'embedding' ? apiConfig.value?.embeddingProfiles : apiConfig.value?.webSearchProfiles)
          ?.find((profile) => profile.id === serviceDraft.value.id)
        if (saved) editServiceProfile(saved)
        serviceFeedbackType.value = 'success'
        apiNotice.value = '供应商配置已保存。'
      } catch { serviceFeedbackType.value = 'error'; apiNotice.value = userFacingFailure('保存供应商配置') }
      finally { apiBusy.value = '' }
    }
    async function activateServiceProfile(id: string) {
      if (apiBusy.value || !['embedding', 'webSearch'].includes(activeModelCategory.value)) return
      const kind = activeModelCategory.value as 'embedding' | 'webSearch'
      apiBusy.value = `activate-service-profile-${kind}`
      apiNotice.value = ''; serviceFeedbackType.value = 'info'
      try {
        const result = await rpc.value.activateServiceProfile(getToken(), kind, id)
        if (!result?.ok) { serviceFeedbackType.value = 'error'; apiNotice.value = result?.detail ?? result?.error ?? '切换服务配置失败。'; return }
        selectedModelProvider.value = id === 'default' ? 'default' : id
        await refresh()
        if (id !== 'default') {
          const profile = (kind === 'embedding' ? apiConfig.value?.embeddingProfiles : apiConfig.value?.webSearchProfiles)
            ?.find((item) => item.id === id)
          if (profile) editServiceProfile(profile)
        }
        serviceFeedbackType.value = 'success'
        apiNotice.value = `已切换到${id === 'default' ? '系统默认服务' : serviceDraft.value.name}。`
      } catch { serviceFeedbackType.value = 'error'; apiNotice.value = userFacingFailure('切换服务配置') }
      finally { apiBusy.value = '' }
    }
    async function removeServiceProfile(id: string) {
      if (apiBusy.value || !['embedding', 'webSearch'].includes(activeModelCategory.value)) return
      const kind = activeModelCategory.value as 'embedding' | 'webSearch'
      apiBusy.value = `remove-service-profile-${kind}`
      apiNotice.value = ''; serviceFeedbackType.value = 'info'
      try {
        const result = await rpc.value.removeServiceProfile(getToken(), kind, id)
        if (!result?.ok) { serviceFeedbackType.value = 'error'; apiNotice.value = result?.detail ?? result?.error ?? '删除供应商配置失败。'; return }
        if (kind === 'embedding') invalidateModelCatalog('embedding', serviceDraft.value)
        selectedModelProvider.value = 'default'
        serviceDraft.value = { id: '', name: '', baseURL: '', model: '', apiKey: '', hasKey: false, keyTail: '' }
        await refresh()
        serviceFeedbackType.value = 'success'
        apiNotice.value = '供应商配置已删除。'
      } catch { serviceFeedbackType.value = 'error'; apiNotice.value = userFacingFailure('删除供应商配置') }
      finally { apiBusy.value = '' }
    }

    function openApproval(row: SandboxApprovalRow, decision: 'approved' | 'rejected') {
      approvalTarget.value = row
      approvalDecision.value = decision
      approvalNote.value = ''
      approvalError.value = ''
      approvalDialogOpen.value = true
    }
    function closeApproval() {
      if (approvalBusy.value) return
      approvalDialogOpen.value = false
      approvalTarget.value = null
      approvalNote.value = ''
      approvalError.value = ''
    }
    async function decideApproval() {
      const row = approvalTarget.value
      const decision = approvalDecision.value
      if (!row || approvalBusy.value) return
      approvalBusy.value = true
      approvalError.value = ''
      try {
        const result = await rpc.value.decideSandboxApproval(getToken(), row.id, decision, decision === 'rejected' ? approvalNote.value : '')
        if (!result?.ok) {
          approvalError.value = result?.detail ?? result?.error ?? '操作失败，请重试。'
          return
        }
        error.value = ''
        await refresh()
        closeApproval()
      } catch { approvalError.value = userFacingFailure(decision === 'approved' ? '批准沙箱请求' : '拒绝沙箱请求') }
      finally { approvalBusy.value = false }
    }
    /** 筛选 + 分页（2026-10-07 用户反馈⑤）。 */
    const filteredUsers = computed(() => {
      const q = query.value.trim().toLowerCase()
      return users.value.filter((u) => {
        if (u.kind !== 'human') return false
        if (accountRoleFilter.value && u.teamRole !== accountRoleFilter.value) return false
        if (!q) return true
        return u.displayName.toLowerCase().includes(q) ||
          u.username.toLowerCase().includes(q) ||
          u.id.toLowerCase().includes(q)
      })
    })
    const pagedUsers = computed(() =>
      filteredUsers.value.slice((pageNo.value - 1) * PAGE_SIZE, pageNo.value * PAGE_SIZE))
    const humans = computed(() => users.value.filter((u) => u.kind === 'human'))

    async function doRemove(row: UserRow) {
      try {
        const r = await rpc.value.removeUser(getToken(), row.id)
        await handleResult(r)
      } catch { error.value = userFacingFailure('删除 Team 账号') }
    }

    return () => {
      const ElAlert = resolveComponent('el-alert') as unknown as string
      const ElCard = resolveComponent('el-card') as unknown as string
      const ElProgress = resolveComponent('el-progress') as unknown as string
      const ElButton = resolveComponent('el-button') as unknown as string
      const ElSpace = resolveComponent('el-space') as unknown as string
      const ElDialog = resolveComponent('el-dialog') as unknown as string
      const ElEmpty = resolveComponent('el-empty') as unknown as string
      const ElForm = resolveComponent('el-form') as unknown as string
      const ElFormItem = resolveComponent('el-form-item') as unknown as string
      const ElInput = resolveComponent('el-input') as unknown as string
      const ElRow = resolveComponent('el-row') as unknown as string
      const ElCol = resolveComponent('el-col') as unknown as string
      const ElText = resolveComponent('el-text') as unknown as string
      const ElPopconfirm = resolveComponent('el-popconfirm') as unknown as string
      const ElTable = resolveComponent('el-table') as unknown as string
      const ElTableColumn = resolveComponent('el-table-column') as unknown as string
      const ElTag = resolveComponent('el-tag') as unknown as string
      const ElSwitch = resolveComponent('el-switch') as unknown as string
      const ElPagination = resolveComponent('el-pagination') as unknown as string
      const ElSelect = resolveComponent('el-select') as unknown as string
      const ElInputNumber = resolveComponent('el-input-number') as unknown as string
      const ElOption = resolveComponent('el-option') as unknown as string
      const ElDivider = resolveComponent('el-divider') as unknown as string
      const ElDescriptions = resolveComponent('el-descriptions') as unknown as string
      const ElDescriptionsItem = resolveComponent('el-descriptions-item') as unknown as string
      const ElTabs = resolveComponent('el-tabs') as unknown as string
      const ElTabPane = resolveComponent('el-tab-pane') as unknown as string
      const renderModelPicker = (
        target: 'text' | 'embedding' | 'profile',
        currentModel: string,
        onSelect: (model: string) => void,
        draft?: { id: string; baseURL: string },
      ) => {
        const catalog = modelCatalogs.value[modelCatalogKey(target, draft)]
        if (!catalog) return null
        const search = catalog.query.trim().toLocaleLowerCase()
        const rows = catalog.models
          .filter((model) => !search || model.toLocaleLowerCase().includes(search))
          .map((model) => ({ modelId: model }))
        return h(ElSpace, { direction: 'vertical', fill: true, size: 12, class: 'sp-admin-model-picker' }, { default: () => [
          catalog.message ? h(ElAlert, { title: catalog.message, type: catalog.type, showIcon: true, closable: true, onClose: () => { catalog.message = '' } }) : null,
          ...(catalog.models.length ? [
          h(ElRow, { justify: 'space-between', align: 'middle' }, [
            h(ElText, { tag: 'strong' }, { default: () => `可选模型 · ${rows.length} / ${catalog.models.length}` }),
            h(ElText, { size: 'small', type: 'info' }, { default: () => '选择一项填入模型 ID' }),
          ]),
          h(ElInput, {
            modelValue: catalog.query,
            'onUpdate:modelValue': (value: string) => { catalog.query = value },
            clearable: true,
            placeholder: '搜索模型名称或 ID',
            'aria-label': '搜索模型列表',
          }),
          h(ElTable, {
            data: rows,
            rowKey: 'modelId',
            currentRowKey: currentModel,
            highlightCurrentRow: true,
            height: 220,
            scrollbarAlwaysOn: true,
            size: 'small',
            emptyText: '没有匹配的模型',
            'aria-label': '可选择的模型列表',
            onRowClick: (row: { modelId: string }) => onSelect(row.modelId),
          }, { default: () => [h(ElTableColumn, { prop: 'modelId', label: '模型 ID', minWidth: 240, showOverflowTooltip: true })] }),
          ] : []),
        ] })
      }
      const apiFooter = (kind: 'text' | 'embedding' | 'webSearch', actions: VNodeChild[], danger?: VNodeChild, hint = '测试使用已保存配置；修改后请先保存。') =>
        h(ElSpace, { direction: 'vertical', fill: true, size: 12, class: 'sp-admin-api-footer' }, { default: () => [
          h(ElRow, { gutter: 12, justify: 'space-between', align: 'middle', class: 'sp-admin-api-action-row' }, { default: () => [
            h(ElCol, { xs: 24, sm: danger ? 20 : 24 }, { default: () => h(ElSpace, { wrap: true, size: 8 }, { default: () => actions }) }),
            danger ? h(ElCol, { xs: 24, sm: 4 }, { default: () => h(ElRow, { justify: 'end' }, { default: () => danger }) }) : null,
          ] }),
          h(ElText, { size: 'small', type: 'info' }, { default: () => hint }),
          apiFeedback(kind, ElAlert),
        ] })

      // ── 操作列（Team 登录账号）──
      const actions = (row: UserRow) => {
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
      const panel = () => {
        const currentPath = route.path
        const page = currentPath === '/admin/runtime' ? 'runtime' : currentPath === '/admin/models' ? 'models' : 'accounts'
        const heading = pageHead(
          page === 'accounts' ? 'Team 账号' : page === 'runtime' ? '运行状态与审批' : '模型与服务',
          page === 'accounts'
            ? '管理团队成员账号、角色、注册入口和密码。'
            : page === 'runtime'
              ? '查看插件运行状态，并处理 Agent 越界访问申请。'
              : '统一配置对话模型、Embedding 和网页搜索供应商；通过 Base URL 与 API Key 接入并获取模型列表。',
          {
            statuses: [
              { text: `Team 账号 ${humans.value.length}`, level: 'ok' },
            ],
            actions: [],
          })
        const feedback = error.value
          ? actionsRow([
            h('div', null, [
              h('div', { class: 'sp-note sp-note--err' }, error.value),
              loadFailed.value
                ? h('div', { class: 'sp-hint', role: 'status' }, dataLoaded.value
                  ? '仍显示上次成功加载的数据。'
                  : '后台数据尚未加载，请重试后再继续管理操作。')
                : null,
            ]),
            loadFailed.value
              ? h(ElButton, { loading: busy.value, onClick: () => void refresh() }, { default: () => '重试加载' })
              : null,
          ])
          : null
        if (!dataLoaded.value) {
          return [heading, feedback ?? h(ElEmpty, { description: busy.value ? '正在加载后台管理数据…' : '后台数据尚未加载' })]
        }
        const textProfiles = apiConfig.value?.textProfiles ?? []
        const editingProfile = textProfiles.find((profile) => profile.id === profileDraft.value.id)
        const pendingSandboxApprovals = sandboxApprovals.value.filter((approval) =>
          approval.status === 'pending' || approval.status === 'approving').length
        const providerList = () => h('div', { class: 'sp-admin-model-provider-list' }, [
          h('div', { class: 'sp-admin-model-provider-list-head' }, [
            h(ElText, { tag: 'strong' }, { default: () => '供应商列表' }),
            h(ElTag, { size: 'small', type: 'info' }, { default: () => {
              const count = activeModelCategory.value === 'text' ? textProfiles.length + 1
                : activeModelCategory.value === 'embedding' ? (apiConfig.value?.embeddingProfiles.filter((profile) => profile.id !== 'default').length ?? 0) + 1
                  : (apiConfig.value?.webSearchProfiles.filter((profile) => profile.id !== 'default').length ?? 0) + 1
              return `${count} 项`
            } }),
          ]),
          ...(activeModelCategory.value === 'text'
            ? [
              h('button', {
                type: 'button',
                class: `sp-admin-model-provider-item${selectedModelProvider.value === 'default' ? ' is-active' : ''}`,
                onClick: () => { if (!apiBusy.value) { clearApiFeedback(); selectedModelProvider.value = 'default' } },
              }, [h('strong', '系统默认对话'), h('span', apiConfig.value?.text.model || '尚未选择模型')]),
              ...textProfiles.map((profile) => h('button', {
                key: profile.id,
                type: 'button',
                class: `sp-admin-model-provider-item${selectedModelProvider.value === profile.id ? ' is-active' : ''}`,
                onClick: () => { if (!apiBusy.value) { selectedModelProvider.value = profile.id; editTextProfile(profile) } },
              }, [
                h('strong', profile.name || profile.id),
                h('span', `${profile.model || '未选择模型'} · ${profile.id}`),
                apiConfig.value?.activeTextProfileRef === profile.id ? h(ElTag, { size: 'small', type: 'success' }, { default: () => '系统默认' }) : null,
              ])),
              !textProfiles.length ? h(ElEmpty, { description: '还没有对话供应商配置', imageSize: 48 }) : null,
              h(ElButton, {
                class: 'sp-admin-model-provider-add',
                disabled: Boolean(apiBusy.value),
                onClick: () => { clearApiFeedback(); selectedModelProvider.value = 'new'; profileDraft.value = { id: '', name: '', baseURL: '', model: '', apiKey: '', maxOutputTokens: null } },
              }, { default: () => '新增对话供应商' }),
            ]
            : (() => {
              const kind = activeModelCategory.value as 'embedding' | 'webSearch'
              const profiles = kind === 'embedding' ? apiConfig.value?.embeddingProfiles ?? [] : apiConfig.value?.webSearchProfiles ?? []
              const activeId = kind === 'embedding' ? apiConfig.value?.activeEmbeddingProfileRef : apiConfig.value?.activeWebSearchProfileRef
              return [
                h('button', {
                  type: 'button',
                  class: `sp-admin-model-provider-item${selectedModelProvider.value === 'default' ? ' is-active' : ''}`,
                  onClick: () => { if (!apiBusy.value) { clearApiFeedback(); selectedModelProvider.value = 'default' } },
                }, [h('strong', '系统默认供应商'), h('span', '兼容现有服务配置'), activeId ? null : h(ElTag, { size: 'small', type: 'success' }, { default: () => '当前使用' })]),
                ...profiles.filter((profile) => profile.id !== 'default').map((profile) => h('button', {
                  key: profile.id,
                  type: 'button',
                  class: `sp-admin-model-provider-item${selectedModelProvider.value === profile.id ? ' is-active' : ''}`,
                  onClick: () => { if (!apiBusy.value) { selectedModelProvider.value = profile.id; editServiceProfile(profile) } },
                }, [
                  h('strong', profile.name || profile.id),
                  h('span', `${kind === 'embedding' && 'model' in profile ? profile.model : profile.baseURL} · ${profile.id}`),
                  activeId === profile.id ? h(ElTag, { size: 'small', type: 'success' }, { default: () => '当前使用' }) : null,
                ])),
                h(ElButton, {
                  class: 'sp-admin-model-provider-add',
                  disabled: Boolean(apiBusy.value),
                  onClick: () => {
                    selectedModelProvider.value = 'new'
                    serviceDraft.value = { id: '', name: '', baseURL: '', model: '', apiKey: '', hasKey: false, keyTail: '' }
                    apiNotice.value = ''
                  },
                }, { default: () => kind === 'embedding' ? '新增嵌入模型供应商' : '新增网页搜索供应商' }),
              ]
            })()),
        ])
        const sections = [
        h('div', { class: 'sp-admin-account-frame' }, [
        section('Team 账号', '管理成员登录账号、角色和密码。',
          [
            // 工具行：注册开关（缩小版）+ 搜索 + 类型筛选
            h(ElSpace, { size: 12, wrap: true, class: 'sp-admin-user-toolbar' }, {
              default: () => [
                h('div', { class: 'sp-toolbar-group' }, [
                  h(ElSwitch, {
                    modelValue: regOpen.value,
                    'onUpdate:modelValue': (v: boolean | string | number) => void toggleRegister(v),
                    disabled: regBusy.value,
                    size: 'small',
                  }),
                  h('span', { class: 'sp-toolbar-label' },
                    regOpen.value ? '开放注册' : '已关闭注册'),
                  regBusy.value
                    ? h(ElText, { size: 'small', type: 'info', role: 'status' }, { default: () => '正在更新注册设置…' })
                    : null,
                ]),
                h(ElInput, {
                class: 'sp-admin-user-search',
                modelValue: query.value,
                'onUpdate:modelValue': (v: string) => { query.value = v; pageNo.value = 1 },
                placeholder: '姓名 / 用户名 / ID',
                clearable: true,
              }),
              h(ElSelect, {
                class: 'sp-admin-role-filter',
                modelValue: accountRoleFilter.value,
                placeholder: '全部角色',
                'onUpdate:modelValue': (value: string) => { accountRoleFilter.value = value; pageNo.value = 1 },
                'aria-label': '按团队角色筛选账号',
              }, {
                default: () => [
                  h(ElOption, { label: '全部角色', value: '' }),
                  h(ElOption, { label: 'DRI', value: 'dri' }),
                  h(ElOption, { label: '普通成员', value: 'member' }),
                ],
              }),
              h(ElText, { size: 'small', type: 'info' }, { default: () => `${filteredUsers.value.length} 个账号` }),
              h(ElButton, {
                type: 'primary', size: 'small',
                onClick: () => { createError.value = ''; createOpen.value = true },
              }, { default: () => '创建账号' }),
            ],
            }),
            regError.value ? h(ElAlert, {
              title: regError.value, type: 'error', showIcon: true, closable: true,
              onClose: () => { regError.value = '' },
            }) : null,
            h('div', { class: 'sp-admin-account-table-area' }, [
              h('div', { class: 'sp-table-scroll-hint' }, '表格可左右滑动查看更多列'),
              h('div', { class: 'sp-account-table-scroll' }, [
                h(ElTable, { data: pagedUsers.value, loading: busy.value }, {
                  default: () => [
                    h(ElTableColumn, { prop: 'displayName', label: '显示名', minWidth: 130 }),
                    h(ElTableColumn, { prop: 'username', label: '用户名', minWidth: 140 }),
                    h(ElTableColumn, { prop: 'id', label: 'id', minWidth: 150 }),
                    h(ElTableColumn, { label: '团队角色', minWidth: 110 }, {
                      default: (scope: { row: UserRow }) => scope.row.teamRole === 'dri' ? 'DRI' : '普通成员',
                    }),
                    h(ElTableColumn, { label: '操作', minWidth: 250 }, {
                      default: (scope: { row: UserRow }) => actions(scope.row),
                    }),
                  ],
                }),
              ]),
            ]),
            h('div', { class: 'sp-admin-account-rows' }, pagedUsers.value.map((user) => h('article', {
              key: user.id,
              class: 'sp-admin-account-row',
            }, [
              h('div', { class: 'sp-admin-account-row-head' }, [
                h('strong', user.displayName || user.username),
                h(ElTag, { size: 'small', type: user.teamRole === 'dri' ? 'primary' : 'info' }, {
                  default: () => user.teamRole === 'dri' ? 'DRI' : '普通成员',
                }),
              ]),
              h('div', { class: 'sp-admin-account-row-meta' }, [
                h('span', `@${user.username}`),
                h('span', { class: 'sp-admin-account-row-id' }, [
                  h('span', 'ID'),
                  h('code', user.id),
                ]),
              ]),
              h('div', { class: 'sp-admin-account-row-actions' }, [actions(user)]),
            ]))),
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
        ]),

        section('插件状态', '显示当前进程实际加载的插件及其配置摘要。插件启停由系统配置决定；此页不提供运行时启停。敏感配置值已隐藏。', [
          h('div', { class: 'sp-admin-plugin-toolbar' }, [
            h(ElSpace, { size: 8 }, { default: () => [
              h(ElInput, { class: 'sp-admin-plugin-search', modelValue: pluginSearch.value, clearable: true,
                placeholder: '搜索插件 ID / 配置', title: '搜索插件 ID、入口或配置',
                'onUpdate:modelValue': (value: string) => { pluginSearch.value = value; pluginPageNo.value = 1 } }),
              h(ElSelect, {
                class: 'sp-admin-plugin-status',
                modelValue: pluginStatusFilter.value,
                clearable: true,
                placeholder: '全部状态',
                onChange: (value: string) => { pluginStatusFilter.value = value ?? ''; pluginPageNo.value = 1 },
              }, { default: () => [
                h(ElOption, { label: '运行中', value: 'running' }),
                h(ElOption, { label: '配置停用', value: 'disabled' }),
                h(ElOption, { label: '其他状态', value: 'other' }),
              ] }),
            ] }),
            h('span', { class: 'sp-admin-plugin-count', role: 'status' }, `${filteredPlugins.value.length} / ${plugins.value.length} 个插件`),
          ]),
          h('div', { class: 'sp-table-scroll-hint sp-admin-plugin-table-hint' }, '表格可左右滑动查看更多列'),
          h('div', { class: 'sp-admin-runtime-table-scroll sp-admin-plugin-table-scroll' }, [
          h(ElTable, { data: pagedPlugins.value, size: 'small', rowKey: 'id', emptyText: '没有匹配的插件' }, {
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
                default: (scope: { row: PluginRow }) => h('div', { class: 'sp-admin-plugin-config' },
                  Object.entries(scope.row.config ?? {}).map(([key, value]) => h('div', {
                    key: `${scope.row.id}-${key}`, class: 'sp-admin-plugin-row-config',
                  }, [
                    h('span', `${key} ·`),
                    h('span', typeof value === 'object' ? JSON.stringify(value) : String(value)),
                  ]))),
              }),
            ],
          }),
          ]),
          h('div', { class: 'sp-admin-plugin-rows' }, filteredPlugins.value.length
            ? pagedPlugins.value.map((plugin) => h('article', {
            key: plugin.id,
            class: 'sp-admin-plugin-row',
          }, [
            h('div', { class: 'sp-admin-plugin-row-head' }, [
              h('strong', plugin.id),
              h(ElTag, {
                type: plugin.status === '运行中' ? 'success' : plugin.status === '配置停用' ? 'info' : 'warning',
                size: 'small',
              }, { default: () => plugin.status }),
            ]),
            h('div', { class: 'sp-admin-plugin-row-entry' }, plugin.name),
            ...Object.entries(plugin.config ?? {}).map(([key, value]) => h('div', {
              key: `${plugin.id}-${key}`,
              class: 'sp-admin-plugin-row-config',
            }, [
              h('span', `${key} ·`),
              h('span', typeof value === 'object' ? JSON.stringify(value) : String(value)),
            ])),
          ]))
            : [h(ElEmpty, { description: '没有匹配的插件', imageSize: 48 })]),
          filteredPlugins.value.length > PLUGIN_PAGE_SIZE ? h(ElRow, { justify: 'end', class: 'sp-admin-plugin-pagination' }, [
            h(ElPagination, {
              currentPage: pluginPageNo.value,
              'onUpdate:currentPage': (value: number) => { pluginPageNo.value = value },
              pageSize: PLUGIN_PAGE_SIZE,
              total: filteredPlugins.value.length,
              layout: 'prev, pager, next',
              background: true,
              small: true,
            }),
          ]) : null,
        ]),
        section(pendingSandboxApprovals ? `沙箱越界审批 · ${pendingSandboxApprovals} 项待处理` : '沙箱越界审批', sandboxApprovals.value.length
          ? '申请仅对后台管理员可见。批准会将单个普通文件复制到团队共享工作区，Agent 只能从共享区只读访问；不会挂载原始宿主机路径。'
          : '', [
          ...(sandboxApprovals.value.length
            ? [
          h('div', { class: 'sp-table-scroll-hint' }, '表格可左右滑动查看更多列'),
          h('div', { class: 'sp-admin-runtime-table-scroll sp-admin-approval-table-scroll' }, [
          h(ElTable, { data: sandboxApprovals.value, size: 'small', rowKey: 'id' }, {
            default: () => [
              h(ElTableColumn, { prop: 'createdAt', label: '申请时间', width: 170 }, { default: (s: { row: SandboxApprovalRow }) => fmtTime(s.row.createdAt) }),
              h(ElTableColumn, { prop: 'agentId', label: 'Agent', width: 130 }),
              h(ElTableColumn, { prop: 'sessionId', label: '会话', width: 130 }),
              h(ElTableColumn, { prop: 'sourcePath', label: '申请路径', minWidth: 240 }),
              h(ElTableColumn, { prop: 'reason', label: '理由', minWidth: 180 }),
              h(ElTableColumn, { prop: 'status', label: '状态', width: 100 }, { default: (s: { row: SandboxApprovalRow }) => s.row.status === 'pending' ? '待处理' : s.row.status === 'approving' ? '交付中，可重试' : s.row.status === 'approved' ? '已批准' : '已拒绝' }),
              h(ElTableColumn, { label: '决定 / 交付路径', minWidth: 230 }, { default: (s: { row: SandboxApprovalRow }) => [s.row.decisionNote, s.row.deliveryPath].filter(Boolean).join(' · ') || '—' }),
              h(ElTableColumn, { label: '操作', width: 190, fixed: 'right' }, { default: (s: { row: SandboxApprovalRow }) => !['pending', 'approving'].includes(s.row.status) ? '—' : h(ElSpace, null, { default: () => [
                h(ElButton, { size: 'small', type: 'success', onClick: () => openApproval(s.row, 'approved') }, { default: () => s.row.status === 'approving' ? '重试交付' : '批准并复制' }),
                s.row.status === 'pending' ? h(ElButton, { size: 'small', type: 'danger', onClick: () => openApproval(s.row, 'rejected') }, { default: () => '拒绝' }) : null,
              ] }) }),
            ],
          }),
          ]),
            ]
            : [h('div', { class: 'sp-admin-approval-empty-state', role: 'status' }, '暂无待审批请求')]),
        ]),
        section('AI 服务供应商', '在一个管理区配置对话、Embedding 与网页搜索服务。OpenAI 兼容供应商统一使用 Base URL 与 API Key，可获取模型列表；密钥只写入，不回显。', [
          h(ElTabs, {
            class: 'sp-admin-model-category-tabs',
            modelValue: activeModelCategory.value,
            'onUpdate:modelValue': (value: 'text' | 'embedding' | 'webSearch') => {
              clearApiFeedback()
              activeModelCategory.value = value
              if (value === 'embedding') void refreshEmbeddingIndex()
              if (value === 'text') selectedModelProvider.value = 'default'
              else {
                const activeRef = value === 'embedding' ? apiConfig.value?.activeEmbeddingProfileRef : apiConfig.value?.activeWebSearchProfileRef
                selectedModelProvider.value = activeRef || 'default'
                const profiles = value === 'embedding' ? apiConfig.value?.embeddingProfiles : apiConfig.value?.webSearchProfiles
                const active = profiles?.find((profile) => profile.id === activeRef)
                if (active) editServiceProfile(active)
              }
            },
          }, { default: () => [
            h(ElTabPane, { label: '对话模型', name: 'text' }),
            h(ElTabPane, { label: '嵌入模型', name: 'embedding' }),
            h(ElTabPane, { label: '网页搜索', name: 'webSearch' }),
          ] }),
          h('div', { class: 'sp-admin-model-category-description', role: 'note' },
            activeModelCategory.value === 'text'
              ? '配置系统默认对话模型，并管理可供 Agent 选择的对话供应商。'
              : activeModelCategory.value === 'embedding'
                ? '配置知识库检索使用的嵌入模型；此配置与对话模型相互独立。'
                : '配置网页搜索服务。搜索服务只负责检索网页，不属于语言模型。'),
          activeModelCategory.value === 'embedding' ? h(ElCard, { shadow: 'never' }, { default: () => [
            h(ElText, { tag: 'strong' }, { default: () => '知识库向量索引' }),
            indexLoadError.value ? h(ElAlert, { title: indexLoadError.value, type: 'error', showIcon: true, closable: false }) : null,
            embeddingIndex.value ? h('div', [
              h(ElAlert, {
                title: ({ disabled: '向量服务未配置', pending: '等待重建向量索引', running: '正在重建向量索引', ready: '向量索引已就绪', failed: '向量索引重建失败' })[embeddingIndex.value.state],
                description: embeddingIndex.value.error || (embeddingIndex.value.state === 'ready'
                  ? `当前模型：${embeddingIndex.value.model}` : '重建完成前使用关键词检索；原文和已完成的分块会保留。'),
                type: embeddingIndex.value.state === 'failed' ? 'error' : embeddingIndex.value.state === 'ready' ? 'success' : 'info',
                showIcon: true, closable: false,
              }),
              h(ElProgress, {
                percentage: embeddingIndex.value.total ? Math.floor(embeddingIndex.value.completed * 100 / embeddingIndex.value.total) : 100,
                status: embeddingIndex.value.state === 'failed' ? 'exception' : embeddingIndex.value.state === 'ready' ? 'success' : undefined,
              }),
              h(ElText, { size: 'small' }, { default: () => `已完成 ${embeddingIndex.value!.completed} / ${embeddingIndex.value!.total} 个分块 · 当前模型 ${embeddingIndex.value!.model}` }),
              ['pending', 'failed'].includes(embeddingIndex.value.state) ? h(ElButton, {
                loading: indexRetryBusy.value, onClick: () => void retryEmbeddingIndex(),
              }, { default: () => '重试未完成索引' }) : null,
            ]) : h(ElText, { type: 'info' }, { default: () => '正在读取索引进度…' }),
          ] }) : null,
          h('div', { class: 'sp-admin-model-provider-workspace' }, [
          providerList(),
          h('div', { class: 'sp-admin-model-provider-editor' }, [
          selectedModelProvider.value === 'default' ? h('div', { class: 'sp-admin-api-config-grid sp-admin-api-config-grid--single' }, [...([
            ['text', '默认对话供应商', true],
            ['embedding', 'Embedding 供应商', true],
            ['webSearch', '网页搜索供应商', false],
          ] as const).filter(([kind]) => kind === activeModelCategory.value).map(([kind, title, hasModel]) => {
            const cfg = apiConfig.value?.[kind]
            if (!cfg) return null
            return h('div', { class: 'sp-admin-api-config-block' }, [
              h(ElText, { tag: 'strong' }, { default: () => title }),
              h(ElForm, { labelPosition: 'top', disabled: Boolean(apiBusy.value) }, {
                default: () => [
                  h(ElFormItem, { label: 'API 地址' }, { default: () => h(ElInput, {
                    modelValue: cfg.baseURL,
                    'onUpdate:modelValue': (v: string) => { cfg.baseURL = v },
                    type: 'textarea', autosize: { minRows: 1, maxRows: 3 }, resize: 'none',
                    placeholder: 'https://provider.example/v1', clearable: true,
                  }) }),
                  hasModel ? h(ElFormItem, { label: '模型 ID' }, { default: () => h('div', [
                    h(ElSpace, { alignment: 'start', fill: true }, { default: () => [
                      h(ElInput, {
                        modelValue: cfg.model,
                        'onUpdate:modelValue': (v: string) => { cfg.model = v },
                        clearable: true,
                        placeholder: '手动输入或从下方列表选择模型',
                      }),
                      h(ElButton, {
                        loading: apiBusy.value === `models-${kind}`,
                        disabled: Boolean(apiBusy.value && apiBusy.value !== `models-${kind}`),
                        onClick: () => void fetchModels(kind as 'text' | 'embedding'),
                      }, { default: () => '获取模型列表' }),
                    ] }),
                    renderModelPicker(kind as 'text' | 'embedding', cfg.model, (model) => { cfg.model = model }),
                  ]) }) : null,
                  kind === 'embedding'
                    ? h(ElText, { size: 'small', type: 'info' }, { default: () => '列表仅显示识别为 Embedding 的模型；也可手动输入供应商支持的模型 ID。' })
                    : null,
                  h(ElFormItem, { label: cfg.hasKey ? `API 密钥（已配置 · 尾号 ${cfg.keyTail}；输入 - 可清除）` : 'API 密钥' }, {
                    default: () => h(ElInput, {
                      modelValue: apiKeys.value[kind],
                      'onUpdate:modelValue': (v: string) => { apiKeys.value[kind] = v; if (kind !== 'webSearch') invalidateModelCatalog(kind) },
                      type: 'password', showPassword: true, autocomplete: 'new-password',
                      placeholder: cfg.hasKey ? '留空保留现有密钥' : '输入 API 密钥',
                    }),
                  }),
                  h(ElText, { size: 'small', type: 'info' }, { default: () => '获取模型列表会优先使用此输入框；留空则使用已保存密钥。' }),
                  kind === 'text' && cfg.timeoutMs !== undefined
                    ? h(ElFormItem, { label: '请求超时（毫秒）' }, { default: () => h(ElInputNumber, {
                        modelValue: cfg.timeoutMs,
                        min: 1, step: 1000, controlsPosition: 'right',
                        'onUpdate:modelValue': (v: number | null) => { if (v !== null) cfg.timeoutMs = v },
                      }) })
                    : null,
                ],
              }),
              apiFooter(kind, [
                h(ElButton, {
                  type: 'primary', loading: apiBusy.value === kind,
                  disabled: Boolean(apiBusy.value && apiBusy.value !== kind), onClick: () => void saveApi(kind),
                }, { default: () => '保存' }),
                kind !== 'text' && (kind === 'embedding' ? apiConfig.value?.activeEmbeddingProfileRef : apiConfig.value?.activeWebSearchProfileRef) ? h(ElButton, {
                  disabled: Boolean(apiBusy.value), onClick: () => void activateServiceProfile('default'),
                }, { default: () => '设为当前服务' }) : null,
                h(ElButton, {
                  loading: apiBusy.value === `test-${kind}`,
                  disabled: Boolean(apiBusy.value && apiBusy.value !== `test-${kind}`), onClick: () => void testApi(kind, kind === 'text' ? undefined : 'default'),
                }, { default: () => '连通测试' }),
                kind === 'text' ? h(ElButton, { disabled: Boolean(apiBusy.value), loading: apiBusy.value === 'test-profile-stream-', onClick: () => void testTextProfileStream('') }, { default: () => '流式测试' }) : null,
              ]),
            ])
          })]) : null,
        activeModelCategory.value === 'text' && selectedModelProvider.value !== 'default' ? h('div', { class: 'sp-admin-profile-workspace' }, [
          h(ElDivider, { contentPosition: 'left' }, { default: () => '可供 Agent 选择的对话模型' }),
          apiNotice.value ? h('div', { class: 'sp-note', role: 'status' }, apiNotice.value) : null,
          h(ElFormItem, { label: '系统默认文字模型配置', class: 'sp-admin-default-profile-item' }, {
            default: () => h(ElSelect, {
              modelValue: apiConfig.value?.activeTextProfileRef ?? '',
            disabled: Boolean(apiBusy.value),
              onChange: (value: string) => void setDefaultTextProfile(value),
              placeholder: '使用兼容默认配置',
            }, {
              default: () => [
                h(ElOption, { label: '默认对话供应商（上方）', value: '' }),
                ...textProfiles.map((profile) => h(ElOption, {
                  label: `${profile.name}（${profile.id}）`, value: profile.id,
                })),
              ],
            }),
          }),
          h('div', { class: 'sp-admin-profile-editor-shell' }, [
              h(ElRow, { justify: 'space-between', align: 'middle' }, [
                h(ElText, { tag: 'strong' }, { default: () => editingProfile ? `编辑供应商 · ${editingProfile.name}` : '新增供应商配置' }),
                editingProfile ? h(ElButton, { size: 'small', disabled: Boolean(apiBusy.value) || apiConfig.value?.activeTextProfileRef === editingProfile.id, onClick: () => void setDefaultTextProfile(editingProfile.id) }, { default: () => apiConfig.value?.activeTextProfileRef === editingProfile.id ? '当前默认' : '设为默认' }) : null,
              ]),
              h(ElForm, { class: 'sp-admin-profile-editor', labelPosition: 'top', disabled: Boolean(apiBusy.value) }, {
            default: () => [
              h(ElRow, { gutter: 20 }, { default: () => [
              h(ElCol, { xs: 24, sm: 12 }, h(ElFormItem, { label: '配置 ID（供 Agent 引用）' }, { default: () => h(ElInput, {
                modelValue: profileDraft.value.id,
                'onUpdate:modelValue': (v: string) => { profileDraft.value.id = v },
                placeholder: 'qwen-prod', clearable: true,
              }) })),
              h(ElCol, { xs: 24, sm: 12 }, h(ElFormItem, { label: '显示名称' }, { default: () => h(ElInput, {
                modelValue: profileDraft.value.name,
                'onUpdate:modelValue': (v: string) => { profileDraft.value.name = v },
                placeholder: '阿里云 Qwen', clearable: true,
              }) })),
              h(ElCol, { span: 24 }, h(ElFormItem, { label: 'Base URL' }, { default: () => h(ElInput, {
                modelValue: profileDraft.value.baseURL,
                'onUpdate:modelValue': (v: string) => { profileDraft.value.baseURL = v },
                type: 'textarea', autosize: { minRows: 1, maxRows: 3 }, resize: 'none',
                placeholder: 'https://provider.example/v1', clearable: true,
              }) })),
              h(ElCol, { xs: 24, sm: 12 }, h(ElFormItem, { label: '模型 ID' }, { default: () => h('div', [
                h(ElSpace, { alignment: 'start', fill: true }, { default: () => [
                  h(ElInput, {
                    modelValue: profileDraft.value.model,
                    'onUpdate:modelValue': (v: string) => { profileDraft.value.model = v },
                    clearable: true,
                    placeholder: '手动输入或从下方列表选择模型',
                  }),
                  h(ElButton, {
                    loading: apiBusy.value === 'models-profile',
                    disabled: Boolean(apiBusy.value && apiBusy.value !== 'models-profile'),
                    onClick: () => void fetchModels('profile'),
                  }, { default: () => '获取模型列表' }),
                ] }),
              ]) })),
              h(ElCol, { xs: 24, sm: 12 }, h(ElFormItem, { label: '最大输出 Token（留空使用供应商默认）' }, { default: () => h(ElInputNumber, {
                modelValue: profileDraft.value.maxOutputTokens,
                'onUpdate:modelValue': (v: number | null) => { profileDraft.value.maxOutputTokens = v ? Math.floor(v) : null },
                min: 1, max: 200000, step: 512, controlsPosition: 'right', clearable: true,
              }) })),
              h(ElCol, { span: 24 }, { default: () => renderModelPicker('profile', profileDraft.value.model, (model) => { profileDraft.value.model = model }) }),
              h(ElCol, { span: 24 }, h(ElFormItem, { label: 'API Key（编辑时留空保留现值；输入 - 清除）' }, { default: () => h(ElInput, {
                modelValue: profileDraft.value.apiKey,
                'onUpdate:modelValue': (v: string) => { profileDraft.value.apiKey = v; invalidateModelCatalog('profile') },
                type: 'password', showPassword: true, autocomplete: 'new-password', placeholder: '仅写入，不回显',
              }) })),
              ] }),
              apiFooter('text', [
                h(ElButton, {
                  type: 'primary', loading: apiBusy.value === 'save-profile',
                  disabled: Boolean(apiBusy.value && apiBusy.value !== 'save-profile'), onClick: () => void saveTextProfile(),
                }, { default: () => '保存供应商配置' }),
                editingProfile ? h(ElButton, { loading: apiBusy.value === `test-profile-${editingProfile.id}`, disabled: Boolean(apiBusy.value),
                  onClick: () => void testTextProfile(editingProfile.id) }, { default: () => '连通测试' }) : null,
                editingProfile ? h(ElButton, { loading: apiBusy.value === `test-profile-stream-${editingProfile.id}`, disabled: Boolean(apiBusy.value),
                  onClick: () => void testTextProfileStream(editingProfile.id) }, { default: () => '流式测试' }) : null,
                h(ElButton, { disabled: Boolean(apiBusy.value), onClick: () => { profileDraft.value = { id: '', name: '', baseURL: '', model: '', apiKey: '', maxOutputTokens: null } } }, { default: () => '清空表单' }),
              ], editingProfile ? h(ElPopconfirm, {
                  title: `确定删除供应商“${editingProfile.name}”吗？`,
                  confirmButtonText: '删除', cancelButtonText: '取消',
                  onConfirm: () => void removeTextProfile(editingProfile.id),
                }, { reference: () => h(ElButton, {
                  type: 'danger', loading: apiBusy.value === `remove-profile-${editingProfile.id}`,
                  disabled: Boolean(apiBusy.value),
                }, { default: () => '删除配置' }) }) : null, editingProfile ? undefined : '保存配置后可进行连通测试。'),
            ],
          }),
          ]),
          ]) : null,
          activeModelCategory.value !== 'text' && selectedModelProvider.value !== 'default' ? h('div', { class: 'sp-admin-profile-workspace' }, [
            h(ElRow, { justify: 'space-between', align: 'middle' }, [
              h(ElText, { tag: 'strong' }, { default: () => selectedModelProvider.value === 'new' ? '新增服务供应商' : `编辑供应商 · ${serviceDraft.value.name}` }),
              selectedModelProvider.value !== 'new' ? h(ElTag, {
                size: 'small',
                type: (activeModelCategory.value === 'embedding'
                  ? apiConfig.value?.activeEmbeddingProfileRef
                  : apiConfig.value?.activeWebSearchProfileRef) === serviceDraft.value.id ? 'success' : 'info',
              }, { default: () => (activeModelCategory.value === 'embedding'
                ? apiConfig.value?.activeEmbeddingProfileRef
                : apiConfig.value?.activeWebSearchProfileRef) === serviceDraft.value.id ? '当前使用' : '未启用' }) : null,
            ]),
            apiNotice.value ? h(ElAlert, { title: apiNotice.value, type: serviceFeedbackType.value, showIcon: true, closable: true, onClose: () => { apiNotice.value = '' } }) : null,
            h(ElForm, { labelPosition: 'top', disabled: Boolean(apiBusy.value) }, {
              default: () => [
                h(ElRow, { gutter: 20 }, { default: () => [
                  h(ElCol, { xs: 24, sm: 12 }, h(ElFormItem, { label: '配置 ID' }, { default: () => h(ElInput, {
                    modelValue: serviceDraft.value.id,
                    'onUpdate:modelValue': (value: string) => { serviceDraft.value.id = value },
                    disabled: selectedModelProvider.value !== 'new',
                    placeholder: '例如 ark-embedding-prod',
                  }) })),
                  h(ElCol, { xs: 24, sm: 12 }, h(ElFormItem, { label: '显示名称' }, { default: () => h(ElInput, {
                    modelValue: serviceDraft.value.name,
                    'onUpdate:modelValue': (value: string) => { serviceDraft.value.name = value },
                    placeholder: activeModelCategory.value === 'embedding' ? '例如 Ark Embedding' : '例如 Tavily 搜索',
                  }) })),
                  h(ElCol, { span: 24 }, h(ElFormItem, { label: 'Base URL' }, { default: () => h(ElInput, {
                    modelValue: serviceDraft.value.baseURL,
                    'onUpdate:modelValue': (value: string) => { serviceDraft.value.baseURL = value },
                    placeholder: activeModelCategory.value === 'embedding' ? 'https://provider.example/v1' : 'https://provider.example',
                    clearable: true,
                  }) })),
                  activeModelCategory.value === 'embedding' ? h(ElCol, { span: 24 }, h(ElFormItem, { label: 'Embedding 模型 ID' }, { default: () => h('div', [
                    h(ElSpace, { alignment: 'start', fill: true }, { default: () => [
                      h(ElInput, {
                        modelValue: serviceDraft.value.model,
                        'onUpdate:modelValue': (value: string) => { serviceDraft.value.model = value },
                        placeholder: '手动输入或从下方模型列表选择', clearable: true,
                      }),
                      h(ElButton, {
                        loading: apiBusy.value === 'models-embedding',
                        disabled: Boolean(apiBusy.value && apiBusy.value !== 'models-embedding'),
                        onClick: () => void fetchModels('embedding', serviceDraft.value),
                      }, { default: () => '获取模型列表' }),
                    ] }),
                    h(ElText, { size: 'small', type: 'info' }, { default: () => '只列出识别为 Embedding 的模型；特殊模型 ID 也可以手动填写。' }),
                  ]) })) : null,
                  activeModelCategory.value === 'embedding' ? h(ElCol, { span: 24 }, { default: () => renderModelPicker('embedding', serviceDraft.value.model, (model) => { serviceDraft.value.model = model }, serviceDraft.value) }) : null,
                  h(ElCol, { span: 24 }, h(ElFormItem, { label: serviceDraft.value.hasKey ? `API Key（已配置 · 尾号 ${serviceDraft.value.keyTail}；留空保留，输入 - 清除）` : 'API Key' }, { default: () => h(ElInput, {
                    modelValue: serviceDraft.value.apiKey,
                    'onUpdate:modelValue': (value: string) => { serviceDraft.value.apiKey = value; if (activeModelCategory.value === 'embedding') invalidateModelCatalog('embedding', serviceDraft.value) },
                    type: 'password', showPassword: true, autocomplete: 'new-password',
                    placeholder: serviceDraft.value.hasKey ? '留空保留现有密钥' : '输入 API Key',
                  }) })),
                ] }),
                apiFooter(activeModelCategory.value as 'embedding' | 'webSearch', [
                  h(ElButton, { type: 'primary', loading: apiBusy.value === `save-service-profile-${activeModelCategory.value}`, onClick: () => void saveServiceProfile() }, { default: () => '保存配置' }),
                  selectedModelProvider.value !== 'new' ? h(ElButton, {
                    disabled: (activeModelCategory.value === 'embedding'
                      ? apiConfig.value?.activeEmbeddingProfileRef
                      : apiConfig.value?.activeWebSearchProfileRef) === serviceDraft.value.id || Boolean(apiBusy.value),
                    onClick: () => void activateServiceProfile(serviceDraft.value.id),
                  }, { default: () => '设为当前服务' }) : null,
                  selectedModelProvider.value !== 'new' ? h(ElButton, {
                    loading: apiBusy.value === `test-${activeModelCategory.value}`, disabled: Boolean(apiBusy.value),
                    onClick: () => void testApi(activeModelCategory.value as 'embedding' | 'webSearch', serviceDraft.value.id),
                  }, { default: () => '连通测试' }) : null,
                ], selectedModelProvider.value !== 'new' ? h(ElPopconfirm, {
                    title: `确定删除供应商“${serviceDraft.value.name}”吗？`,
                    confirmButtonText: '删除', cancelButtonText: '取消',
                    onConfirm: () => void removeServiceProfile(serviceDraft.value.id),
                  }, { reference: () => h(ElButton, { type: 'danger', disabled: Boolean(apiBusy.value) }, { default: () => '删除配置' }) }) : null, selectedModelProvider.value === 'new' ? '保存配置后可进行连通测试。' : undefined),
              ],
            }),
          ]) : null,
          ]),
          ]),
        ]),
        ]
        const visibleSections = page === 'accounts'
          ? [sections[0]]
          : page === 'runtime'
            ? [sections[1], sections[2]]
            : [sections[3]]
        return [heading, feedback, ...visibleSections]
      }

      return h('div', { class: 'k-content sp-admin-wrap' }, [
        h(ThemeStyle),
        panel(),
        // 修改密码弹窗（el-dialog + el-form + el-input showPassword）。
        h(ElDialog, {
          class: 'sp-admin-password-dialog',
          modelValue: pwVisible.value,
          'onUpdate:modelValue': (v: boolean) => { if (!pwBusy.value) pwVisible.value = v },
          title: `修改密码 —— ${pwTarget.value?.displayName ?? ''}（${pwTarget.value?.username ?? ''}）`,
          width: 420,
        }, {
          default: () => [
            pwError.value ? h(ElAlert, {
              title: pwError.value, type: 'error', showIcon: true, closable: false,
            }) : null,
            h(ElForm, { labelPosition: 'top', disabled: pwBusy.value }, {
              default: () => h(ElFormItem, { label: '新密码' }, {
                default: () => h(ElInput, {
                  modelValue: pwValue.value,
                  'onUpdate:modelValue': (v: string) => { pwValue.value = v },
                  type: 'password',
                  showPassword: true,
                  autocomplete: 'new-password',
                  placeholder: '输入新密码',
                }),
              }),
            }),
          ],
          footer: () => h('span', null, [
            h(ElButton, { disabled: pwBusy.value, onClick: () => { pwVisible.value = false } }, { default: () => '取消' }),
            h(ElButton, {
              type: 'primary', loading: pwBusy.value, disabled: pwBusy.value || !pwValue.value,
              onClick: () => void doResetPassword(),
            }, { default: () => pwBusy.value ? '正在保存…' : '确定' }),
          ]),
        }),
        h(ElDialog, {
          class: 'sp-admin-create-dialog',
          modelValue: createOpen.value,
          'onUpdate:modelValue': (v: boolean) => { createOpen.value = v },
          title: '创建 Team 账号',
        }, {
          default: () => [
            createError.value ? h(ElAlert, {
              title: createError.value, type: 'error', showIcon: true, closable: false,
            }) : null,
            h(ElForm, { labelPosition: 'top', disabled: createBusy.value }, {
              default: () => h(ElRow, { gutter: 20 }, [
              h(ElCol, { xs: 24, sm: 12 }, h(ElFormItem, { label: '用户名' }, { default: () => h(ElInput, {
                modelValue: newUsername.value,
                'onUpdate:modelValue': (v: string) => { newUsername.value = v },
                autocomplete: 'off',
              }) })),
              h(ElCol, { xs: 24, sm: 12 }, h(ElFormItem, { label: '显示名' }, { default: () => h(ElInput, {
                modelValue: newDisplayName.value,
                'onUpdate:modelValue': (v: string) => { newDisplayName.value = v },
                autocomplete: 'off',
              }) })),
              h(ElCol, { xs: 24, sm: 12 }, h(ElFormItem, { label: '初始密码' }, { default: () => h(ElInput, {
                modelValue: newPassword.value,
                'onUpdate:modelValue': (v: string) => { newPassword.value = v },
                type: 'password', showPassword: true, autocomplete: 'new-password',
              }) })),
              h(ElCol, { xs: 24, sm: 12 }, h(ElFormItem, { label: '团队角色' }, {
                default: () => h(ElSelect, {
                  modelValue: newTeamRole.value,
                  'onUpdate:modelValue': (v: 'dri' | 'member') => { newTeamRole.value = v },
                }, { default: () => [
                  h(ElOption, { label: '普通成员', value: 'member' }),
                  h(ElOption, { label: 'DRI', value: 'dri' }),
                ] }),
              })),
              ]),
            }),
          ],
          footer: () => h(ElSpace, null, { default: () => [
            h(ElButton, { disabled: createBusy.value, onClick: () => { createOpen.value = false } }, { default: () => '取消' }),
            h(ElButton, { type: 'primary', loading: createBusy.value, disabled: createBusy.value || !newUsername.value || !newPassword.value, onClick: () => void doCreateUser() }, { default: () => createBusy.value ? '正在创建…' : '创建' }),
          ] }),
        }),
        h(ElDialog, {
          modelValue: approvalDialogOpen.value,
          'onUpdate:modelValue': (v: boolean) => { if (!v) closeApproval() },
          title: approvalDecision.value === 'rejected' ? '拒绝越界请求' : approvalTarget.value?.status === 'approving' ? '重试文件交付' : '批准文件交付',
          width: 560,
        }, {
          default: () => [
            approvalError.value ? h(ElAlert, { title: approvalError.value, type: 'error', showIcon: true, closable: false }) : null,
            h(ElAlert, {
              title: '批准后只会复制该普通文件到团队共享工作区；Agent 只能读取副本，不会获得原始宿主机路径访问权。',
              type: 'info', showIcon: true, closable: false,
            }),
            approvalTarget.value ? h(ElDescriptions, { column: 1, size: 'small', border: true, class: 'sp-approval-details' }, {
              default: () => [
                h(ElDescriptionsItem, { label: 'Agent' }, { default: () => approvalTarget.value?.agentId ?? '—' }),
                h(ElDescriptionsItem, { label: '会话' }, { default: () => approvalTarget.value?.sessionId ?? '全局工作区' }),
                h(ElDescriptionsItem, { label: '申请路径' }, { default: () => approvalTarget.value?.sourcePath ?? '—' }),
                h(ElDescriptionsItem, { label: '申请理由' }, { default: () => approvalTarget.value?.reason ?? '—' }),
              ],
            }) : null,
            approvalDecision.value === 'rejected' ? h(ElForm, { labelPosition: 'top', disabled: approvalBusy.value }, {
              default: () => h(ElFormItem, { label: '拒绝原因（可选）' }, {
                default: () => h(ElInput, {
                  modelValue: approvalNote.value,
                  'onUpdate:modelValue': (v: string) => { approvalNote.value = v },
                  type: 'textarea', rows: 3, maxlength: 500, showWordLimit: true,
                  placeholder: '说明拒绝原因，方便申请者调整请求',
                }),
              }),
            }) : null,
          ],
          footer: () => h(ElSpace, null, { default: () => [
            h(ElButton, { disabled: approvalBusy.value, onClick: closeApproval }, { default: () => '取消' }),
            h(ElButton, {
              type: approvalDecision.value === 'rejected' ? 'danger' : 'success',
              loading: approvalBusy.value, disabled: approvalBusy.value,
              onClick: () => void decideApproval(),
            }, { default: () => approvalBusy.value ? approvalDecision.value === 'rejected' ? '正在提交…' : '正在交付…' : approvalDecision.value === 'rejected' ? '确认拒绝' : approvalTarget.value?.status === 'approving' ? '重试并复制文件' : '确认批准并复制' }),
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
      page(options: { path: string; name: string; order?: number; icon?: Component | string; component: unknown }): void
      slot(options: { type: string; order?: number; component: Component }): void
    }
  }
}

const DebugHome = defineComponent({
  name: 'DebugConsoleHome',
  setup() {
    const router = useRouter()
    const ElButton = resolveComponent('el-button') as unknown as string
    const ElCard = resolveComponent('el-card') as unknown as string
    const ElSpace = resolveComponent('el-space') as unknown as string
    const ElText = resolveComponent('el-text') as unknown as string

    const open = (path: string) => { void router.push({ path }) }

    return () => h(ElSpace, { direction: 'vertical', fill: true, size: 16 }, {
      default: () => [
        h(ElCard, { shadow: 'never' }, {
          header: () => 'Cordis 调试控制台',
          default: () => h(ElSpace, { direction: 'vertical', size: 8 }, {
            default: () => [
              h(ElText, null, { default: () => '服务已启动。选择一个页面查看当前运行状态。' }),
              h(ElSpace, { wrap: true }, {
                default: () => [
                  h(ElButton, { type: 'primary', onClick: () => open('/plugins') }, { default: () => '插件管理' }),
                  h(ElButton, { onClick: () => open('/logs') }, { default: () => '运行日志' }),
                  h(ElButton, { onClick: () => open('/database') }, { default: () => '数据库' }),
                ],
              }),
            ],
          }),
        }),
      ],
    })
  },
})

export default function main(ctx: PageCtx) {
  ctx.client.router.slot({ type: 'home', order: -1000, component: DebugHome })
  ctx.client.router.page({
    path: '/admin',
    name: 'Team 账号',
    order: 900,
    icon: ICONS.admin,
    component: AdminPage,
  })
  ctx.client.router.page({
    path: '/admin/runtime',
    name: '运行与审批',
    order: 901,
    icon: ICONS.agents,
    component: AdminPage,
  })
  ctx.client.router.page({
    path: '/admin/models',
    name: '模型与服务',
    order: 902,
    icon: ICONS.models,
    component: AdminPage,
  })
}
