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

export const name = 'space-client-ui-admin'
export const inject = ['webui', 'users', 'settings', 'adminAuth', 'sandboxApproval', 'sandboxApprovalDelivery', 'llm', 'embeddings', 'loader']

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
        const request = ctx.sandboxApproval.get(String(id))
        let deliveryPath: string | undefined
        if (decision === 'approved') deliveryPath = (await ctx.sandboxApprovalDelivery.deliver(request)).relativePath
        const resolved = ctx.sandboxApproval.decide(String(id), decision, admin.id, String(note), deliveryPath)
        audit(ctx, admin.id, `sandbox_request_${decision}`, `${resolved.id}:${resolved.agentId}`)
        return { ok: true, request: resolved }
      } catch (e) { return fail(e) }
    },
  })
}
