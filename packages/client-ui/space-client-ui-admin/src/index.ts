// 后台入口：独立 Admin session；所有 RPC 首参必须是 admin token。
import type { Context } from 'cordis'
import type {} from '@cordisjs/plugin-webui'
import type {} from '@cordisjs/plugin-loader'
import type { Entry } from '@cordisjs/plugin-loader'
import { IdentityError } from 'space-identity'
import type { TeamRole } from 'space-identity'
import { AdminAuthError } from 'space-admin-auth'
import type { AdminPrincipal } from 'space-admin-auth'
import type {} from 'space-sandbox-approval'
import type {} from 'space-agent-catalog'

export const name = 'space-client-ui-admin'
export const inject = ['webui', 'users', 'settings', 'adminAuth', 'sandboxApproval', 'sandboxApprovalDelivery', 'llm', 'embeddings', 'loader', 'agentCatalog']

async function auth(ctx: Context, token: string): Promise<AdminPrincipal | null> {
  try { return await ctx.adminAuth.verifyToken(String(token ?? '')) }
  catch { return null }
}
function fail(e: unknown): { error: string; detail: string } {
  if (e instanceof IdentityError || e instanceof AdminAuthError) return { error: e.code, detail: e.message }
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
    routes: ['/admin'],
  }, {
    async me(token: string) { return auth(ctx, token) },
    async login(username: string, password: string) {
      try {
        const grant = await ctx.adminAuth.login(username, password)
        return { user: await ctx.adminAuth.verifyToken(grant.token), token: grant.token }
      } catch (e) { return fail(e) }
    },
    async logout(token: string) { try { await ctx.adminAuth.logout(token) } catch { /* idempotent */ } return { ok: true } },
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
        embedding: shape('embed'),
        webSearch: { ...shape('search'), model: '' },
        status: { text: ctx.llm.configured, embedding: ctx.embeddings.configured },
      }
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
    async saveEmbeddingApi(token: string, cfg: { baseURL?: string; model?: string; apiKey?: string }) {
      const admin = await auth(ctx, token)
      if (!admin) return null
      saveApi(ctx, 'embed', cfg)
      audit(ctx, admin.id, 'save_api_config', 'embedding')
      return { ok: true }
    },
    async saveWebSearchApi(token: string, cfg: { baseURL?: string; apiKey?: string }) {
      const admin = await auth(ctx, token)
      if (!admin) return null
      saveApi(ctx, 'search', cfg)
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
    async testEmbeddingApi(token: string) {
      if (!(await auth(ctx, token))) return null
      const started = Date.now()
      try {
        const vector = await ctx.embeddings.embed(['连通测试'])
        return { ok: true, detail: `连通正常（${Date.now() - started}ms）：${vector[0]?.length ?? 0} 维` }
      } catch (e) { return { ok: false, ...fail(e) } }
    },
    async testWebSearchApi(token: string) {
      if (!(await auth(ctx, token))) return null
      const baseURL = ctx.settings.get<string>('search.baseURL', '').trim().replace(/\/$/, '')
      const apiKey = ctx.settings.get<string>('search.apiKey', '').trim()
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
