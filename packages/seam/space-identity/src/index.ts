// seam/space-identity —— 身份域能力缝（IM 化改造 2026-09-30）。
//
// 只有词汇：UserService 声明 + 数据形状 + 错误分类法。零实现、零 IO。
// 实现由 impl/space-store-sqlite/src/users.ts 提供（ctx.users）。
// 认证 token 经 plugins/space-auth 的 HttpOnly cookie 进出；本缝只管
// 「用户账目 + token 签发/校验」的存储语义，不懂 HTTP。
import { Service } from 'cordis'
import type { Context } from 'cordis'

declare module 'cordis' {
  interface Context {
    users: UserService
  }
}

// ── 数据形状 ──────────────────────────────────────────────────────────────

/** 一个身份（人类用户或系统内建的 agent 身份）。对应 users 表一行。 */
export interface User {
  id: string
  /** 登录名，全库唯一；agent 身份的 username = principal_id。 */
  username: string
  /** 永远不把 hash 吐给客户端 —— 本字段只在 impl 内部比较。 */
  passwordHash: string
  displayName: string
  kind: 'human' | 'agent'
  /** 管理员标记（账号管理 2026-10-01）。第一个注册的人类自动置位。 */
  isAdmin: boolean
  createdAt: string
}

/** 对外（API/RPC）可见的用户视图：绝无 passwordHash。 */
export interface PublicUser {
  id: string
  username: string
  displayName: string
  kind: 'human' | 'agent'
  /** 管理面要显示；不算敏感（能看出谁是管理员，但改不了）。 */
  isAdmin: boolean
  createdAt: string
}

/** 一次登录签发的 token。 */
export interface TokenGrant {
  token: string
  userId: string
  expiresAt: string
}

// ── 错误分类法（实现与策略不得自造错误串）────────────────────────────────

export type IdentityErrorCode =
  | 'username_taken'
  | 'unknown_user'
  | 'bad_credentials'
  | 'invalid_input'
  | 'forbidden_kind'
  /** 该身份仍被会话引用（session_members），不能删除。 */
  | 'in_use'
  | 'token_expired'
  | 'token_unknown'

export class IdentityError extends Error {
  constructor(
    public readonly code: IdentityErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'IdentityError'
  }
}

// ── 服务缝 ────────────────────────────────────────────────────────────────
// 实现层必须保证的语义：
//   · register：username 唯一（违者 username_taken）；密码弱校验由调用方做，
//     impl 只拒空白；id 取 "u_" 前缀；kind 固定 'human'。
//   · verify：只有 kind='human' 且 password_hash 可比较成功的行能签发 token
//     （agent 行 password_hash='!' 永不匹配，bad_credentials）。
//   · token：随机 ≥32 字节 hex；校验过期（token_expired）与存在性（token_unknown）。
//   · 时间戳一律 ISO 8601（UTC）。
export abstract class UserService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'users')
  }

  /** 注册人类用户。返回去敏视图。 */
  abstract register(username: string, password: string, displayName?: string): Promise<PublicUser>

  /** 注册一个 AI 成员身份（无凭据，不可登录 —— 供自定义 Agent 入会外键用）。 */
  abstract registerAgent(id: string, displayName: string): PublicUser

  /** 用户名+密码登录，成功签发 token。 */
  abstract login(username: string, password: string): Promise<TokenGrant>

  /** 按 token 换用户；无效/过期抛 IdentityError。 */
  abstract verifyToken(token: string): Promise<PublicUser>

  /** 注销（删除）一个 token。 */
  abstract logout(token: string): Promise<void>

  /** 去敏视图（内部把行转 PublicUser 用）。 */
  abstract byId(id: string): Promise<PublicUser | null>

  /** 全部人类用户（邀请成员用），按创建时间升序。 */
  abstract listHumans(): Promise<PublicUser[]>

  // ── 账号管理（admin 面，2026-10-01）──────────────────────────────────

  /** 全部身份（含 agent），按 kind + createdAt 排序 —— 管理面用户列表。 */
  abstract listAll(): Promise<PublicUser[]>

  /** 管理员重置某用户密码。agent 身份没有密码 → forbidden_kind。 */
  abstract resetPassword(id: string, password: string): Promise<void>

  /** 设置/取消管理员。agent 身份不可设管理员 → forbidden_kind。 */
  abstract setAdmin(id: string, v: boolean): Promise<void>

  /**
   * 删除用户（其 login_tokens 随之级联删除）。
   * agent 身份 → forbidden_kind；人类仍被 session_members 引用 → in_use
   * （错误消息说明原因：需先移出所有会话）。
   */
  abstract removeUser(id: string): Promise<void>
}
