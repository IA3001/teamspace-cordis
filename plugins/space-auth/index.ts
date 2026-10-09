// space-auth —— 身份域 HTTP 门面（IM 化改造 2026-09-30）。
//
// 职责只有一件：把 seam/space-identity 的 UserService 包成 HTTP。
//   POST /api/auth/register  注册（201 PublicUser；username_taken → 409）
//   POST /api/auth/login     登录 → 签发 HttpOnly cookie（space_token）
//   POST /api/auth/logout    注销当前 token + 清 cookie
//   GET  /api/auth/me        cookie 换当前用户（无效 → 401 unauthorized）
//
// 认证 token 只经 HttpOnly cookie 进出，前端 JS 永远摸不到 ——
// XSS 拿不到凭据。其余插件（如 staging-commands）用 readToken +
// requireUser 自取身份，不重复解析 cookie。
import type { Context } from 'cordis'
import { IdentityError } from 'space-identity'
import type { PublicUser } from 'space-identity'

export const name = 'space-auth'
// settings（2026-10-06 A4）：注册开关 settings 键 auth.registerEnabled
// （管理页 /admin 可改）> 启动 Config > 缺省开启。库空时永远放行（否则
// 第一个管理员都注册不出来）。
export const inject = ['server', 'users', 'settings']

// 与 Set-Cookie 的 Max-Age 严格一致（秒）：7 天。
export const TOKEN_MAX_AGE = 604800
const COOKIE_NAME = 'space_token'

/** 手工解析 Cookie 头，取 space_token 的值；没有就空串（本项目不引 cookie 库）。 */
export function readToken(req: Request): string {
  // 2026-10-02：除 cookie 外支持 Authorization: Bearer（浏览器页面与后端
  // 不同端口，fetch 需带头的场景：撤回/上传）。
  const bearer = req.headers.get('authorization')
  if (bearer?.startsWith('Bearer ')) return bearer.slice(7).trim()
  const header = req.headers.get('cookie')
  if (!header) return ''
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    if (part.slice(0, eq).trim() === COOKIE_NAME) {
      return decodeURIComponent(part.slice(eq + 1).trim())
    }
  }
  return ''
}

/**
 * 从 cookie 取身份；无效/过期抛 IdentityError，由调用方转 401。
 * （统一出口：所有需要登录态的路由都走这条，而不是各自 verifyToken。）
 */
export async function requireUser(ctx: Context, req: Request): Promise<PublicUser> {
  return ctx.users.verifyToken(readToken(req))
}

/** IdentityError.code → HTTP 状态码。只分两档：输入错 400，冲突 409。 */
function statusFor(e: IdentityError): number {
  return e.code === 'username_taken' ? 409 : 400
}

/**
 * 管理员守门（账号管理 2026-10-01）：verifyToken + isAdmin 校验。
 * 未登录 401；登录了但不是管理员 403。返回当前用户（路由要用 id 比对）。
 */
export async function requireAdmin(ctx: Context, req: Request): Promise<PublicUser> {
  const user = await ctx.users.verifyToken(readToken(req))
  if (!user.isAdmin) {
    throw new AdminForbidden('需要管理员权限')
  }
  return user
}

/** 非管理员——用独立错误类区分 403 与 401，不污染 IdentityError 分类法。 */
export class AdminForbidden extends Error {}

/** 管理路由的统一错误出口：IdentityError 走 statusFor，AdminForbidden → 403。 */
function adminError(e: unknown): Response | null {
  if (e instanceof AdminForbidden) {
    return Response.json({ error: 'forbidden', detail: e.message }, { status: 403 })
  }
  if (e instanceof IdentityError) {
    return Response.json({ error: e.code, detail: e.message }, { status: statusFor(e) })
  }
  return null
}

import z from 'schemastery'

/** 面板可配（5172 → 插件 → space-auth）：注册开关。 */
export interface Config { registerEnabled?: boolean }

export const Config = z.object({
  registerEnabled: z.boolean()
    .description('开放注册（关闭后仅管理员通过既有账号管理，页面注册将提示关闭）')
    .default(true),
})

export function apply(ctx: Context, config: Config = {}) {
  const registerEnabled = config.registerEnabled ?? true
  // ── 注册 ─────────────────────────────────────────────────────────────
  ctx.server.post('/api/auth/register', async (req) => {
    // 库空放行（首用户必须是管理员）；否则看开关：settings > Config > 开。
    const hasUsers = ctx.users.listAll().length > 0
    const enabled = ctx.settings.get<boolean>('auth.registerEnabled', registerEnabled)
    if (hasUsers && !enabled) {
      return Response.json(
        { error: 'register_disabled', detail: '本站已关闭开放注册（管理员可在 5172 面板重新开启）' },
        { status: 403 },
      )
    }
    const body = await req.json().catch(() => null as Record<string, unknown> | null)
    const username = typeof body?.username === 'string' ? body.username.trim() : ''
    const password = typeof body?.password === 'string' ? body.password : ''
    const displayName = typeof body?.displayName === 'string' ? body.displayName : undefined
    try {
      const user = await ctx.users.register(username, password, displayName)
      return Response.json(user, { status: 201 })
    } catch (e) {
      if (e instanceof IdentityError) {
        return Response.json({ error: e.code, detail: e.message }, { status: statusFor(e) })
      }
      throw e
    }
  })

  // ── 登录：签发 HttpOnly cookie，返回 PublicUser ──────────────────────
  // ── 登录限速（C5，2026-10-06）：进程内滑动窗口 ────────────────────────
  // 键 = 客户端 ip + 用户名；10 分钟窗口内 8 次失败后拒绝到窗口结束。
  // 进程内存即可（单机部署；重启清零是可接受的语义）。
  const loginFails = new Map<string, { count: number; resetAt: number }>()
  const WINDOW_MS = 10 * 60 * 1000
  const MAX_FAILS = 8
  const failKey = (req: Request, username: string) => {
    const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'local'
    return `${ip}|${username.toLowerCase()}`
  }
  const tooManyFails = (key: string): boolean => {
    const rec = loginFails.get(key)
    if (!rec) return false
    if (Date.now() > rec.resetAt) { loginFails.delete(key); return false }
    return rec.count >= MAX_FAILS
  }
  const recordFail = (key: string) => {
    const rec = loginFails.get(key)
    if (!rec || Date.now() > rec.resetAt) loginFails.set(key, { count: 1, resetAt: Date.now() + WINDOW_MS })
    else rec.count++
  }

  ctx.server.post('/api/auth/login', async (req) => {
    const body = await req.json().catch(() => null as Record<string, unknown> | null)
    const username = typeof body?.username === 'string' ? body.username.trim() : ''
    const password = typeof body?.password === 'string' ? body.password : ''
    const fkey = failKey(req, username)
    if (tooManyFails(fkey)) {
      return Response.json(
        { error: 'too_many_attempts', detail: '登录失败次数过多，请 10 分钟后再试' },
        { status: 429 },
      )
    }
    try {
      const grant = await ctx.users.login(username, password)
      // HttpOnly：前端 JS 不可读；SameSite=Lax：挡基本 CSRF；Path=/：全站有效。
      const setCookie =
        `${COOKIE_NAME}=${encodeURIComponent(grant.token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${TOKEN_MAX_AGE}`
      const user = await ctx.users.byId(grant.userId)
      return Response.json(user, { headers: { 'Set-Cookie': setCookie } })
    } catch (e) {
      if (e instanceof IdentityError) {
        recordFail(fkey)
        return Response.json({ error: e.code, detail: e.message }, { status: statusFor(e) })
      }
      throw e
    }
  })

  // ── 注销：删 token + 清 cookie（Max-Age=0 立即过期）───────────────────
  ctx.server.post('/api/auth/logout', async (req) => {
    const token = readToken(req)
    if (token) {
      try {
        await ctx.users.logout(token)
      } catch (e) {
        // token 已失效也视为注销成功 —— 幂等，别让登出变成报错页。
        if (!(e instanceof IdentityError)) throw e
      }
    }
    return Response.json(
      { ok: true },
      { headers: { 'Set-Cookie': `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0` } },
    )
  })

  // ── 当前身份：cookie 换 PublicUser ────────────────────────────────────
  ctx.server.get('/api/auth/me', async (req) => {
    try {
      return Response.json(await requireUser(ctx, req))
    } catch {
      return Response.json({ error: 'unauthorized' }, { status: 401 })
    }
  })

  // ── 管理面（全部 requireAdmin，2026-10-01）────────────────────────────
  // 注：register / login / me 的返回体是 PublicUser，isAdmin 已随缝一起带出，
  // 这里不用改。

  // 用户列表（含 agent 身份，管理面展示用）。
  ctx.server.get('/api/admin/users', async (req) => {
    try {
      await requireAdmin(ctx, req)
      return Response.json(await ctx.users.listAll())
    } catch (e) {
      return adminError(e) ?? Promise.reject(e)
    }
  })

  // 重置密码（agent 身份 impl 层抛 forbidden_kind → 400；这里顺带拦 body）。
  ctx.server.post('/api/admin/users/:id/reset-password', async (req, params: { id: string }) => {
    try {
      await requireAdmin(ctx, req)
      const body = await req.json().catch(() => null as Record<string, unknown> | null)
      const password = typeof body?.password === 'string' ? body.password : ''
      await ctx.users.resetPassword(params.id, password)
      return Response.json({ ok: true })
    } catch (e) {
      return adminError(e) ?? Promise.reject(e)
    }
  })

  // 设置/取消管理员。禁止把自己降级（否则可能造出无管理员系统）。
  ctx.server.post('/api/admin/users/:id/set-admin', async (req, params: { id: string }) => {
    try {
      const me = await requireAdmin(ctx, req)
      const body = await req.json().catch(() => null as Record<string, unknown> | null)
      const v = body?.isAdmin === true
      if (params.id === me.id && !v) {
        return Response.json({ error: 'forbidden', detail: '不能取消自己的管理员' }, { status: 403 })
      }
      await ctx.users.setAdmin(params.id, v)
      return Response.json({ ok: true })
    } catch (e) {
      return adminError(e) ?? Promise.reject(e)
    }
  })

  // 删除用户。同样禁止删自己；被会话引用 → in_use（impl 层抛，409）。
  ctx.server.delete('/api/admin/users/:id', async (req, params: { id: string }) => {
    try {
      const me = await requireAdmin(ctx, req)
      if (params.id === me.id) {
        return Response.json({ error: 'forbidden', detail: '不能删除自己' }, { status: 403 })
      }
      await ctx.users.removeUser(params.id)
      return Response.json({ ok: true })
    } catch (e) {
      return adminError(e) ?? Promise.reject(e)
    }
  })
}
