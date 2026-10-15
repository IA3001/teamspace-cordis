// 后台入口：按用户决定免登录开放；管理操作使用统一的 open-admin 审计主体。
import type { Context } from 'cordis'
import type {} from '@cordisjs/plugin-webui'
import type {} from '@cordisjs/plugin-loader'
import type { Entry } from '@cordisjs/plugin-loader'
import type { AdminPrincipal } from 'space-admin-auth'
import { IdentityError } from 'space-identity'
import type { TeamRole } from 'space-identity'
import type {} from 'space-sandbox-approval'
import type {} from 'space-agent-catalog'

export const name = 'space-client-ui-admin'
export const inject = ['webui', 'users', 'settings', 'sandboxApproval', 'sandboxApprovalDelivery', 'llm', 'embeddings', 'loader', 'agentCatalog', 'kbIndex']

async function auth(_ctx: Context, _token: string): Promise<AdminPrincipal> {
  // The user explicitly chose an open, login-free administration panel.
  // Keep a stable audit actor so write operations remain attributable in logs.
  return { id: 'admin-open', username: 'open-admin' }
}
function fail(e: unknown): { error: string; detail: string } {
  if (e instanceof IdentityError) return { error: e.code, detail: e.message }
  return { error: 'internal', detail: e instanceof Error ? e.message : String(e) }
}
function saveApi(ctx: Context, prefix: string, cfg: { baseURL?: string; model?: string; apiKey?: string }) {
  if (typeof cfg.baseURL === 'string') ctx.settings.set(`${prefix}.baseURL`, cfg.baseURL.trim())
  if (typeof cfg.model === 'string') ctx.settings.set(`${prefix}.model`, cfg.model.trim())
  if (cfg.apiKey === '-') ctx.settings.set(`${prefix}.apiKey`, undefined)
  else if (typeof cfg.apiKey === 'string' && cfg.apiKey.trim()) ctx.settings.set(`${prefix}.apiKey`, cfg.apiKey.trim())
}
function audit(ctx: Context, adminId: string, action: string, target: string) {
  ctx.logger.info('[admin-audit] admin=%s action=%s target=%s', adminId, action, target)
}

type ManagedService = 'embedding' | 'webSearch'
type ManagedServiceProfile = { id: string; name: string }
function serviceKeys(kind: ManagedService) {
  return kind === 'embedding' ? ['baseURL', 'model', 'apiKey'] as const : ['baseURL', 'apiKey'] as const
}
function servicePrefix(kind: ManagedService) { return kind === 'embedding' ? 'embed' : 'search' }
function serviceProfilesKey(kind: ManagedService) { return `${servicePrefix(kind)}.profiles` }
function serviceActiveKey(kind: ManagedService) { return `${servicePrefix(kind)}.activeProfileRef` }
function serviceProfilePrefix(kind: ManagedService, id: string) { return `${servicePrefix(kind)}.profile.${id}` }
function readServiceProfiles(ctx: Context, kind: ManagedService) {
  return ctx.settings.get<ManagedServiceProfile[]>(serviceProfilesKey(kind), []) ?? []
}
function profileShape(ctx: Context, kind: ManagedService, profile: ManagedServiceProfile) {
  const prefix = serviceProfilePrefix(kind, profile.id)
  const key = ctx.settings.get<string>(`${prefix}.apiKey`, '')
  return {
    ...profile,
    baseURL: ctx.settings.get<string>(`${prefix}.baseURL`, ''),
    ...(kind === 'embedding' ? { model: ctx.settings.get<string>(`${prefix}.model`, '') } : {}),
    hasKey: Boolean(key), keyTail: key ? key.slice(-4) : '',
  }
}
function copyServiceProfile(ctx: Context, kind: ManagedService, id: string) {
  const sourcePrefix = serviceProfilePrefix(kind, id)
  const targetPrefix = servicePrefix(kind)
  for (const key of serviceKeys(kind)) {
    const value = ctx.settings.get<string>(`${sourcePrefix}.${key}`, '')
    ctx.settings.set(`${targetPrefix}.${key}`, value || undefined)
  }
}

function modelId(row: unknown): string {
  return typeof row === 'string' ? row : row && typeof row === 'object' && 'id' in row ? String((row as { id: unknown }).id) : ''
}

function isEmbeddingModel(row: unknown): boolean {
  const id = modelId(row)
  const metadata = row && typeof row === 'object'
    ? ['type', 'task', 'model_type', 'modelType', 'capabilities', 'supported_tasks', 'supportedTasks', 'endpoints']
      .map((key) => (row as Record<string, unknown>)[key])
      .flatMap((value) => Array.isArray(value) ? value : [value])
      .filter((value): value is string => typeof value === 'string')
      .join(' ')
      .toLowerCase()
    : ''
  if (/embedding|text[-_ ]?embedding|embed(?:ding)?/i.test(metadata)) return true
  if (/chat|completion|text[-_ ]?generation|language[-_ ]?model/i.test(metadata)) return false
  return /(?:^|[-_./:])(?:text[-_]?embedding|embedding|embed(?:ding)?|bge|gte|e5|mxbai)(?:[-_./:]|$)/i.test(id) ||
    /(?:jina|voyage)[-_./:].*(?:embed|embedding)/i.test(id)
}

async function listProviderModels(baseURLInput: string, apiKey: string, target: 'text' | 'embedding'): Promise<{ ok: true; models: string[] } | { ok: false; detail: string }> {
  const baseURL = String(baseURLInput ?? '').trim().replace(/\/+$/, '')
  if (!baseURL || !apiKey) return { ok: false, detail: '请先填写 API 地址和密钥；已保存的密钥可直接使用。' }
  let url: URL
  try { url = new URL(`${baseURL}/models`) }
  catch { return { ok: false, detail: 'API 地址格式无效。' } }
  if (!['https:', 'http:'].includes(url.protocol)) return { ok: false, detail: 'API 地址必须使用 HTTP 或 HTTPS。' }
  try {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(12000),
    })
    if (!response.ok) return { ok: false, detail: `供应商模型列表接口返回 HTTP ${response.status}。请确认 API 地址、密钥及供应商是否提供 OpenAI 兼容的 /models 接口。` }
    const body = await response.json() as { data?: unknown[]; models?: unknown[]; result?: { data?: unknown[] } }
    const rows = Array.isArray(body?.data) ? body.data : Array.isArray(body?.models) ? body.models : Array.isArray(body?.result?.data) ? body.result.data : []
    const arkCodingPlan = url.hostname === 'ark.cn-beijing.volces.com' && url.pathname.replace(/\/+$/, '') === '/api/coding/v3/models'
    // Ark's generic /models catalog includes Embedding products unavailable to
    // Coding Plan. Its published integration maps doubao-embedding-vision to
    // version 251215; exposing other Ark Embedding IDs lets the user save a
    // model that will return 404 from /embeddings.
    const eligibleRows = target === 'embedding'
      ? rows.filter(isEmbeddingModel).filter((row) => !arkCodingPlan || ['doubao-embedding-vision', 'doubao-embedding-vision-251215'].includes(modelId(row)))
      : rows
    const models = [...new Set(eligibleRows.map(modelId).filter((id) => /^[\w./:-]{1,200}$/.test(id)))].sort((a, b) => a.localeCompare(b))
    if (!models.length && target === 'embedding' && rows.length) {
      return { ok: false, detail: arkCodingPlan
        ? '方舟 Coding Plan 当前仅支持 doubao-embedding-vision（对应版本 doubao-embedding-vision-251215）；普通方舟模型清单不能代表 Coding Plan 权限。请确认该模型已开通，或改用标准方舟 API Base URL。'
        : `接口返回了 ${rows.length} 个模型，但未识别到 Embedding 模型。列表会排除普通对话模型；如供应商使用特殊 ID，可在模型名处手动输入。` }
    }
    if (!models.length) return { ok: false, detail: '接口可访问，但没有返回可识别的模型 ID（预期为 OpenAI 兼容的 data[].id）。' }
    return { ok: true, models: models.slice(0, 500) }
  } catch (error) {
    return { ok: false, detail: error instanceof Error && error.name === 'TimeoutError' ? '获取模型列表超时（12 秒）。' : '无法连接供应商模型列表接口，请检查地址、网络与 TLS 配置。' }
  }
}

function safeConfig(value: unknown, key = ''): unknown {
  if (/(secret|password|token|api.?key|credential|private.?key)/i.test(key)) {
    return value ? '已配置（已隐藏）' : '未配置'
  }
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return value
  if (Array.isArray(value)) return value.map((item) => safeConfig(item))
  if (typeof value === 'object') {
    if ('__jsExpr' in value) return '动态配置（启动时求值）'
    return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [childKey, safeConfig(child, childKey)]))
  }
  return String(value)
}

function pluginStatus(entry: Entry): string {
  if (entry.disabled) return '配置停用'
  if (!entry.fiber) return '未加载'
  if (entry.fiber.state === 2) return '运行中'
  return '已加载，未就绪'
}

export function apply(ctx: Context) {
  ctx.webui.addEntry<Record<string, (...args: any[]) => unknown>>({
    baseUrl: import.meta.url,
    source: '../client/index.ts',
    manifest: '../dist/manifest.json',
    routes: ['/admin', '/admin/runtime', '/admin/models'],
  }, {
    async users(token: string) {
      if (!(await auth(ctx, token))) return null
      return ctx.users.listAll()
    },
    async plugins(token: string) {
      if (!(await auth(ctx, token))) return null
      return [...ctx.loader.entries()].map((entry) => ({
        id: entry.options.id,
        name: entry.options.name,
        status: pluginStatus(entry),
        config: safeConfig(entry.options.config ?? {}),
      })).sort((a, b) => a.id.localeCompare(b.id))
    },
    async createUser(token: string, input: { username: string; password: string; displayName?: string; teamRole: TeamRole }) {
      const admin = await auth(ctx, token)
      if (!admin) return null
      try {
        const user = await ctx.users.register(
          String(input.username ?? ''), String(input.password ?? ''),
          String(input.displayName ?? ''), input.teamRole,
        )
        audit(ctx, admin.id, 'create_team_user', `${user.id}:${user.teamRole ?? input.teamRole}`)
        return { ok: true, user }
      } catch (e) { return fail(e) }
    },
    async resetPassword(token: string, userId: string, password: string) {
      const admin = await auth(ctx, token)
      if (!admin) return null
      try { await ctx.users.resetPassword(String(userId), String(password)); audit(ctx, admin.id, 'reset_team_password', String(userId)); return { ok: true } }
      catch (e) { return fail(e) }
    },
    async getRegisterEnabled(token: string) {
      if (!(await auth(ctx, token))) return null
      return { enabled: ctx.settings.get<boolean>('auth.registerEnabled', true) }
    },
    async setRegisterEnabled(token: string, value: boolean) {
      const admin = await auth(ctx, token)
      if (!admin) return null
      ctx.settings.set('auth.registerEnabled', Boolean(value))
      audit(ctx, admin.id, 'set_registration', String(Boolean(value)))
      return { ok: true }
    },
    async removeUser(token: string, userId: string) {
      const admin = await auth(ctx, token)
      if (!admin) return null
      try { await ctx.users.removeUser(String(userId)); audit(ctx, admin.id, 'remove_team_user', String(userId)); return { ok: true } }
      catch (e) { return fail(e) }
    },
    async getApiConfig(token: string) {
      if (!(await auth(ctx, token))) return null
      const shape = (prefix: string) => {
        const key = ctx.settings.get<string>(`${prefix}.apiKey`, '')
        return { baseURL: ctx.settings.get<string>(`${prefix}.baseURL`, ''), model: ctx.settings.get<string>(`${prefix}.model`, ''), hasKey: Boolean(key), keyTail: key ? key.slice(-4) : '' }
      }
      return {
        text: { ...shape('llm'), timeoutMs: ctx.settings.get<number>('llm.timeoutMs', 60000) },
        textProfiles: (ctx.settings.get<Array<{ id: string; name: string }>>('llm.profiles', []) ?? []).map((profile) => {
          const key = ctx.settings.get<string>(`llm.profile.${profile.id}.apiKey`, '')
          return {
            id: profile.id, name: profile.name,
            baseURL: ctx.settings.get<string>(`llm.profile.${profile.id}.baseURL`, ''),
            model: ctx.settings.get<string>(`llm.profile.${profile.id}.model`, ''),
            maxOutputTokens: ctx.settings.get<number>(`llm.profile.${profile.id}.maxOutputTokens`, 0) || null,
            hasKey: Boolean(key), keyTail: key ? key.slice(-4) : '',
          }
        }),
        activeTextProfileRef: ctx.settings.get<string>('llm.activeProfileRef', ''),
        embedding: shape(ctx.settings.get<string>('embed.activeProfileRef', '') ? 'embed.profile.default' : 'embed'),
        embeddingProfiles: readServiceProfiles(ctx, 'embedding').map((profile) => profileShape(ctx, 'embedding', profile)),
        activeEmbeddingProfileRef: ctx.settings.get<string>('embed.activeProfileRef', ''),
        webSearch: { ...shape(ctx.settings.get<string>('search.activeProfileRef', '') ? 'search.profile.default' : 'search'), model: '' },
        webSearchProfiles: readServiceProfiles(ctx, 'webSearch').map((profile) => profileShape(ctx, 'webSearch', profile)),
        activeWebSearchProfileRef: ctx.settings.get<string>('search.activeProfileRef', ''),
        status: { text: ctx.llm.configured, embedding: ctx.embeddings.configured },
      }
    },
    async getEmbeddingIndexStatus(token: string) {
      if (!(await auth(ctx, token))) return null
      return ctx.kbIndex.status()
    },
    async retryEmbeddingIndex(token: string) {
      const admin = await auth(ctx, token)
      if (!admin) return null
      ctx.kbIndex.retry()
      audit(ctx, admin.id, 'retry_embedding_index', 'knowledge_base')
      return { ok: true }
    },
    async fetchTextModels(token: string, input: { target: 'text' | 'embedding' | 'profile' | 'embeddingProfile'; profileId?: string; baseURL?: string; apiKey?: string }) {
      if (!(await auth(ctx, token))) return null
      const target = input?.target
      if (!['text', 'embedding', 'profile', 'embeddingProfile'].includes(target)) return { ok: false, detail: '不支持的模型配置类型。' }
      const profileId = String(input.profileId ?? '').trim()
      if ((target === 'profile' || (target === 'embeddingProfile' && profileId)) && !/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(profileId)) return { ok: false, detail: '请先填写有效的配置 ID。' }
      const prefix = target === 'embedding' ? (ctx.settings.get<string>('embed.activeProfileRef', '') ? 'embed.profile.default' : 'embed') : target === 'embeddingProfile' ? `embed.profile.${profileId}`
        : target === 'profile' ? `llm.profile.${profileId}` : 'llm'
      const baseURL = String(input?.baseURL ?? '').trim() || ctx.settings.get<string>(`${prefix}.baseURL`, '')
      const enteredKey = String(input?.apiKey ?? '').trim()
      const storedKey = ctx.settings.get<string>(`${prefix}.apiKey`, '')
      const apiKey = enteredKey === '-' ? '' : enteredKey || storedKey
      const credentialSource = enteredKey === '-'
        ? '输入框为 -，本次请求未发送密钥'
        : enteredKey
          ? enteredKey === storedKey ? '输入框密钥（与已保存密钥一致）' : '输入框中的未保存密钥'
          : storedKey ? '已保存密钥（输入框留空）' : '未配置密钥'
      const result = await listProviderModels(baseURL, apiKey, target === 'embedding' || target === 'embeddingProfile' ? 'embedding' : 'text')
      const detail = !result.ok && result.detail.includes('HTTP 401')
        ? `${result.detail} 本次使用：${credentialSource}。输入框密钥未保存时，清空输入框可测试已保存密钥；更换密钥后请先保存，再测试。`
        : result.ok ? undefined : result.detail
      return { ...result, credentialSource, ...(detail ? { detail } : {}) }
    },
    async saveTextApi(token: string, cfg: { baseURL?: string; model?: string; apiKey?: string; timeoutMs?: number }) {
      const admin = await auth(ctx, token)
      if (!admin) return null
      saveApi(ctx, 'llm', cfg)
      if (typeof cfg.timeoutMs === 'number' && cfg.timeoutMs > 0) ctx.settings.set('llm.timeoutMs', Math.floor(cfg.timeoutMs))
      audit(ctx, admin.id, 'save_api_config', 'text')
      return { ok: true }
    },
    async saveTextProfile(token: string, cfg: { id?: string; name?: string; baseURL?: string; model?: string; apiKey?: string; maxOutputTokens?: number | null }) {
      const admin = await auth(ctx, token)
      if (!admin) return null
      const id = String(cfg.id ?? '').trim()
      const name = String(cfg.name ?? '').trim()
      const baseURL = String(cfg.baseURL ?? '').trim()
      const model = String(cfg.model ?? '').trim()
      if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(id) || !name || !baseURL || !model) {
        return { ok: false, error: 'invalid_input', detail: '配置 ID、名称、Base URL 和模型名均为必填项；ID 仅允许字母、数字、下划线和连字符。' }
      }
      if (cfg.maxOutputTokens !== undefined && cfg.maxOutputTokens !== null &&
        (!Number.isSafeInteger(cfg.maxOutputTokens) || cfg.maxOutputTokens < 1 || cfg.maxOutputTokens > 200_000)) {
        return { ok: false, error: 'invalid_input', detail: '最大输出 Token 必须是 1–200000 的整数；留空表示使用供应商默认值。' }
      }
      const profiles = ctx.settings.get<Array<{ id: string; name: string }>>('llm.profiles', []) ?? []
      const existing = profiles.some((profile) => profile.id === id)
      if (!existing && profiles.length >= 32) return { ok: false, error: 'limit', detail: '最多保存 32 组文字模型配置。' }
      ctx.settings.set('llm.profiles', existing
        ? profiles.map((profile) => profile.id === id ? { id, name } : profile)
        : [...profiles, { id, name }])
      ctx.settings.set(`llm.profile.${id}.baseURL`, baseURL)
      ctx.settings.set(`llm.profile.${id}.model`, model)
      if (cfg.maxOutputTokens !== undefined) {
        ctx.settings.set(`llm.profile.${id}.maxOutputTokens`, cfg.maxOutputTokens ?? undefined)
      }
      if (cfg.apiKey === '-') ctx.settings.set(`llm.profile.${id}.apiKey`, undefined)
      else if (typeof cfg.apiKey === 'string' && cfg.apiKey.trim()) ctx.settings.set(`llm.profile.${id}.apiKey`, cfg.apiKey.trim())
      audit(ctx, admin.id, 'save_text_model_profile', id)
      return { ok: true }
    },
    async removeTextProfile(token: string, idInput: string) {
      const admin = await auth(ctx, token)
      if (!admin) return null
      const id = String(idInput ?? '').trim()
      if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(id)) return { ok: false, error: 'invalid_input', detail: '配置 ID 格式无效。' }
      const profiles = ctx.settings.get<Array<{ id: string; name: string }>>('llm.profiles', []) ?? []
      if (!profiles.some((profile) => profile.id === id)) return { ok: false, error: 'not_found', detail: '文字模型配置不存在。' }
      const references = ctx.agentCatalog.list().filter((agent) => agent.llmProfileRef === id).length
      if (references > 0) return { ok: false, error: 'in_use', detail: `仍有 ${references} 个团队 Agent 使用此配置；请先更换它们的模型配置 ref。` }
      ctx.settings.set('llm.profiles', profiles.filter((profile) => profile.id !== id))
      for (const key of ['apiKey', 'baseURL', 'model', 'maxOutputTokens']) ctx.settings.set(`llm.profile.${id}.${key}`, undefined)
      if (ctx.settings.get<string>('llm.activeProfileRef', '') === id) ctx.settings.set('llm.activeProfileRef', '')
      audit(ctx, admin.id, 'remove_text_model_profile', id)
      return { ok: true }
    },
    async setDefaultTextProfile(token: string, idInput: string) {
      const admin = await auth(ctx, token)
      if (!admin) return null
      const id = String(idInput ?? '').trim()
      const profiles = ctx.settings.get<Array<{ id: string; name: string }>>('llm.profiles', []) ?? []
      if (id && !profiles.some((profile) => profile.id === id)) return { ok: false, error: 'not_found', detail: '文字模型配置不存在。' }
      ctx.settings.set('llm.activeProfileRef', id)
      audit(ctx, admin.id, 'set_default_text_model_profile', id || 'legacy')
      return { ok: true }
    },
    async saveServiceProfile(token: string, kind: ManagedService, input: { id?: string; name?: string; baseURL?: string; model?: string; apiKey?: string }) {
      const admin = await auth(ctx, token)
      if (!admin) return null
      if (!['embedding', 'webSearch'].includes(kind)) return { ok: false, error: 'invalid_input', detail: '不支持的服务类型。' }
      const id = String(input.id ?? '').trim()
      const name = String(input.name ?? '').trim()
      const baseURL = String(input.baseURL ?? '').trim()
      const model = String(input.model ?? '').trim()
      if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(id) || ['default', 'new'].includes(id) || !name || !baseURL || (kind === 'embedding' && !model)) {
        return { ok: false, error: 'invalid_input', detail: kind === 'embedding'
          ? '配置 ID、名称、Base URL 和模型 ID 均为必填项；ID 仅允许字母、数字、下划线和连字符。'
          : '配置 ID、名称和 Base URL 均为必填项；ID 仅允许字母、数字、下划线和连字符。' }
      }
      const profiles = readServiceProfiles(ctx, kind)
      const exists = profiles.some((profile) => profile.id === id)
      if (!exists && profiles.length >= 32) return { ok: false, error: 'limit', detail: '最多保存 32 组供应商配置。' }
      ctx.settings.set(serviceProfilesKey(kind), exists
        ? profiles.map((profile) => profile.id === id ? { id, name } : profile)
        : [...profiles, { id, name }])
      const prefix = serviceProfilePrefix(kind, id)
      ctx.settings.set(`${prefix}.baseURL`, baseURL)
      if (kind === 'embedding') ctx.settings.set(`${prefix}.model`, model)
      if (input.apiKey === '-') ctx.settings.set(`${prefix}.apiKey`, undefined)
      else if (typeof input.apiKey === 'string' && input.apiKey.trim()) ctx.settings.set(`${prefix}.apiKey`, input.apiKey.trim())
      if (ctx.settings.get<string>(serviceActiveKey(kind), '') === id) copyServiceProfile(ctx, kind, id)
      if (kind === 'embedding') ctx.emit('space/embedding-config-changed')
      audit(ctx, admin.id, 'save_service_profile', `${kind}:${id}`)
      return { ok: true }
    },
    async activateServiceProfile(token: string, kind: ManagedService, idInput: string) {
      const admin = await auth(ctx, token)
      if (!admin) return null
      if (!['embedding', 'webSearch'].includes(kind)) return { ok: false, error: 'invalid_input', detail: '不支持的服务类型。' }
      const id = String(idInput ?? '').trim()
      let profiles = readServiceProfiles(ctx, kind)
      if (id === 'default') {
        if (profiles.some((profile) => profile.id === 'default')) copyServiceProfile(ctx, kind, 'default')
        ctx.settings.set(serviceActiveKey(kind), '')
      } else {
        if (!profiles.some((profile) => profile.id === id)) return { ok: false, error: 'not_found', detail: '供应商配置不存在。' }
        if (!profiles.some((profile) => profile.id === 'default')) {
          const fallback = { id: 'default', name: '系统默认供应商' }
          const base = servicePrefix(kind)
          for (const key of serviceKeys(kind)) {
            const value = ctx.settings.get<string>(`${base}.${key}`, '')
            ctx.settings.set(`${serviceProfilePrefix(kind, 'default')}.${key}`, value || undefined)
          }
          profiles = [fallback, ...profiles]
          ctx.settings.set(serviceProfilesKey(kind), profiles)
        }
        copyServiceProfile(ctx, kind, id)
        ctx.settings.set(serviceActiveKey(kind), id)
      }
      audit(ctx, admin.id, 'activate_service_profile', `${kind}:${id}`)
      if (kind === 'embedding') ctx.emit('space/embedding-config-changed')
      return { ok: true }
    },
    async removeServiceProfile(token: string, kind: ManagedService, idInput: string) {
      const admin = await auth(ctx, token)
      if (!admin) return null
      if (!['embedding', 'webSearch'].includes(kind)) return { ok: false, error: 'invalid_input', detail: '不支持的服务类型。' }
      const id = String(idInput ?? '').trim()
      if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(id) || id === 'default') return { ok: false, error: 'invalid_input', detail: '系统默认配置不能删除。' }
      const profiles = readServiceProfiles(ctx, kind)
      if (!profiles.some((profile) => profile.id === id)) return { ok: false, error: 'not_found', detail: '供应商配置不存在。' }
      if (ctx.settings.get<string>(serviceActiveKey(kind), '') === id) {
        if (profiles.some((profile) => profile.id === 'default')) copyServiceProfile(ctx, kind, 'default')
        ctx.settings.set(serviceActiveKey(kind), '')
      }
      ctx.settings.set(serviceProfilesKey(kind), profiles.filter((profile) => profile.id !== id))
      for (const key of serviceKeys(kind)) ctx.settings.set(`${serviceProfilePrefix(kind, id)}.${key}`, undefined)
      audit(ctx, admin.id, 'remove_service_profile', `${kind}:${id}`)
      if (kind === 'embedding') ctx.emit('space/embedding-config-changed')
      return { ok: true }
    },
    async saveEmbeddingApi(token: string, cfg: { baseURL?: string; model?: string; apiKey?: string }) {
      const admin = await auth(ctx, token)
      if (!admin) return null
      saveApi(ctx, ctx.settings.get<string>('embed.activeProfileRef', '') ? 'embed.profile.default' : 'embed', cfg)
      if (!ctx.settings.get<string>('embed.activeProfileRef', '') && readServiceProfiles(ctx, 'embedding').some((profile) => profile.id === 'default')) {
        for (const key of serviceKeys('embedding')) {
          const value = ctx.settings.get<string>(`embed.${key}`, '')
          ctx.settings.set(`embed.profile.default.${key}`, value || undefined)
        }
      }
      audit(ctx, admin.id, 'save_api_config', 'embedding')
      ctx.emit('space/embedding-config-changed')
      return { ok: true }
    },
    async saveWebSearchApi(token: string, cfg: { baseURL?: string; apiKey?: string }) {
      const admin = await auth(ctx, token)
      if (!admin) return null
      saveApi(ctx, ctx.settings.get<string>('search.activeProfileRef', '') ? 'search.profile.default' : 'search', cfg)
      if (!ctx.settings.get<string>('search.activeProfileRef', '') && readServiceProfiles(ctx, 'webSearch').some((profile) => profile.id === 'default')) {
        for (const key of serviceKeys('webSearch')) {
          const value = ctx.settings.get<string>(`search.${key}`, '')
          ctx.settings.set(`search.profile.default.${key}`, value || undefined)
        }
      }
      audit(ctx, admin.id, 'save_api_config', 'web_search')
      return { ok: true }
    },
    async testTextApi(token: string) {
      if (!(await auth(ctx, token))) return null
      const started = Date.now()
      try {
        const answer = await ctx.llm.chat([{ role: 'user', content: 'ping，只回复 pong' }], { timeoutMs: 20000 })
        return { ok: true, detail: `连通正常（${Date.now() - started}ms）：${answer.slice(0, 80)}` }
      } catch (e) { return { ok: false, ...fail(e) } }
    },
    async testTextProfile(token: string, idInput: string) {
      if (!(await auth(ctx, token))) return null
      const started = Date.now()
      try {
        const answer = await ctx.llm.chat([{ role: 'user', content: 'ping，只回复 pong' }], {
          timeoutMs: 20000, profileRef: String(idInput ?? '').trim(),
        })
        return { ok: true, detail: `连通正常（${Date.now() - started}ms）：${answer.slice(0, 80)}` }
      } catch (e) { return { ok: false, ...fail(e) } }
    },
    async testTextProfileStream(token: string, idInput: string) {
      const admin = await auth(ctx, token)
      if (!admin) return null
      const started = Date.now()
      let firstDeltaMs: number | undefined
      let chunks = 0
      let characters = 0
      try {
        await ctx.llm.chat([{ role: 'user', content: '请只回复：流式测试成功' }], {
          timeoutMs: 30000,
          profileRef: String(idInput ?? '').trim(),
          onToken: (delta) => {
            if (firstDeltaMs === undefined) firstDeltaMs = Date.now() - started
            chunks += 1
            characters += Array.from(delta).length
          },
        })
        audit(ctx, admin.id, 'test_text_profile_stream', String(idInput ?? '').trim())
        return {
          ok: true,
          detail: `流式请求完成（${streamMetrics()}）`,
        }
      } catch (e) {
        audit(ctx, admin.id, 'test_text_profile_stream_failed', String(idInput ?? '').trim())
        const failure = fail(e)
        return { ok: false, ...failure, detail: `${failure.detail}（${streamMetrics()}）` }
      }

      function streamMetrics() {
        return `首段 ${firstDeltaMs === undefined ? '未收到' : `${firstDeltaMs}ms`}，${chunks} 段，${characters} 字符，总计 ${Date.now() - started}ms`
      }
    },
    async testEmbeddingApi(token: string, profileId?: string) {
      if (!(await auth(ctx, token))) return null
      const started = Date.now()
      try {
        const vector = await ctx.embeddings.embed(['连通测试'], { profileRef: profileId, signal: AbortSignal.timeout(20000) })
        return { ok: true, detail: `连通正常（${Date.now() - started}ms）：${vector[0]?.length ?? 0} 维` }
      } catch (e) { return { ok: false, ...fail(e) } }
    },
    async testWebSearchApi(token: string, profileId?: string) {
      if (!(await auth(ctx, token))) return null
      const useProfile = profileId && !(profileId === 'default' && !ctx.settings.get<string>('search.activeProfileRef', ''))
      if (useProfile && !readServiceProfiles(ctx, 'webSearch').some((profile) => profile.id === profileId)) {
        return { ok: false, error: 'not_found', detail: '网页搜索供应商配置不存在' }
      }
      const prefix = useProfile ? serviceProfilePrefix('webSearch', profileId!) : 'search'
      const baseURL = ctx.settings.get<string>(`${prefix}.baseURL`, '').trim().replace(/\/$/, '')
      const apiKey = ctx.settings.get<string>(`${prefix}.apiKey`, '').trim()
      if (!baseURL || !apiKey) return { ok: false, error: 'not_configured', detail: '请先保存网页搜索 API 地址和密钥' }
      try {
        const response = await fetch(`${baseURL}/search`, {
          method: 'POST', headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
          body: JSON.stringify({ query: 'Teamspace API connectivity check', max_results: 1 }),
          signal: AbortSignal.timeout(15000),
        })
        return response.ok
          ? { ok: true, detail: `网页搜索 API 连通正常（HTTP ${response.status}）` }
          : { ok: false, error: 'search_http_error', detail: `网页搜索 API 返回 HTTP ${response.status}` }
      } catch (e) { return { ok: false, error: 'search_unreachable', detail: e instanceof Error ? e.message : '请求失败' } }
    },
    async sandboxApprovals(token: string) {
      if (!(await auth(ctx, token))) return null
      return ctx.sandboxApproval.list()
    },
    async decideSandboxApproval(token: string, id: string, decision: 'approved' | 'rejected', note = '') {
      const admin = await auth(ctx, token)
      if (!admin) return null
      try {
        let resolved
        if (decision === 'approved') {
          const request = ctx.sandboxApproval.beginApproval(String(id), admin.id, String(note))
          const deliveryPath = (await ctx.sandboxApprovalDelivery.deliver(request)).relativePath
          resolved = ctx.sandboxApproval.decide(String(id), decision, admin.id, String(note), deliveryPath)
        } else {
          resolved = ctx.sandboxApproval.decide(String(id), decision, admin.id, String(note))
        }
        audit(ctx, admin.id, `sandbox_request_${decision}`, `${resolved.id}:${resolved.agentId}`)
        return { ok: true, request: resolved }
      } catch (e) { return fail(e) }
    },
  })
}
