// space-upload —— IM 文件消息的上传/下载面（最小可行版，2026-10-01）。
//
//   POST /api/upload?sessionId=<id>&name=<文件名> 人类会话成员鉴权；body = 原始字节，上限 20MB；
//                                   落盘 data/uploads/<uuid>-<安全化文件名>，
//                                   元数据绑定会话，返回带 sessionId 的 URL。
//   GET  /api/uploads/:name          仅允许会话成员读取；防目录穿越并核对元数据，
//                                   按原始扩展名猜 Content-Type，图片类 inline 展示。
//
// 文件不进事件新列：上传成功后前端把带会话 ID 的下载路径拼进消息文本（[文件] 开头），
// 复用现有消息全链路。附件默认只在所属会话可读；成员可以显式导入团队知识库。
import { mkdirSync, readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs'
import { join, extname } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Context } from 'cordis'

export const name = 'space-upload'
export const inject = ['server', 'users', 'session', 'database', 'kb', 'eventLog']

import z from 'schemastery'

/** 面板可配（5172 → 插件 → space-upload）：存储目录与大小上限。 */
export interface Config { dir?: string; maxMb?: number }

export const Config = z.object({
  dir: z.string().description('上传文件存储目录（相对 cwd）').default('data/uploads'),
  maxMb: z.number().min(1).max(1024).description('单文件大小上限（MB）').default(20),
})


// 插件间裸名解析不到（plugins/space-auth 的导出在别处不可 import），
// 照 staging-commands 的惯例在本文件自实现同口径 readToken。
const COOKIE_NAME = 'space_token'
type HeaderRequest = { headers: { get(name: string): string | null } }
function readToken(req: HeaderRequest): string {
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

/** 文件名安全化：只留 [A-Za-z0-9._-中文]，其余替换 '_'；空了兜底 'file'。 */
function sanitize(name: string): string {
  const out = name.replace(/[^A-Za-z0-9._\-\u4e00-\u9fa5]/g, '_')
  return out || 'file'
}

// 常见扩展名 → Content-Type（其余 application/octet-stream）。
const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
}
const INLINE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']) // 图片类 inline 展示

export function apply(ctx: Context, config: Config = {}) {
  const MAX_BYTES = (config.maxMb ?? 20) * 1024 * 1024
  const dir = config.dir?.startsWith('/') || config.dir?.startsWith('./') ? config.dir : `${process.cwd()}/${config.dir ?? 'data/uploads'}`
  const pendingImports = new Map<string, Promise<{ id: string; title: string }>>()
  ctx.server.post('/api/upload', async (req) => {
    // Uploads belong to a session; no detached public file URLs are created.
    let user: { id: string; kind?: string }
    try {
      user = await ctx.users.verifyToken(readToken(req))
    } catch {
      return Response.json({ error: 'unauthorized' }, { status: 401 })
    }
    if (user.kind !== 'human') return Response.json({ error: 'unauthorized' }, { status: 401 })
    const url = new URL(req.url, 'http://localhost')
    const sessionId = url.searchParams.get('sessionId')?.trim() ?? ''
    if (!sessionId || !ctx.session.getSession(sessionId) ||
      !ctx.session.listMembers(sessionId, true).some((member) => member.principalId === user.id)) {
      return Response.json({ error: 'not_found' }, { status: 404 })
    }
    const rawName = url.searchParams.get('name') ?? 'file'
    const buf = await req.arrayBuffer()
    if (buf.byteLength > MAX_BYTES) {
      return Response.json({ error: 'too_large' }, { status: 413 })
    }
    // 落盘：<uuid>-<安全化文件名>，防同名互踩。
    mkdirSync(dir, { recursive: true })
    const stored = `${randomUUID()}-${sanitize(rawName)}`
    writeFileSync(join(dir, stored), Buffer.from(buf))
    try {
      await ctx.database.create('file_attachments', {
        stored_name: stored, session_id: sessionId, uploader_id: user.id,
        original_name: rawName, size_bytes: buf.byteLength, created_at: new Date().toISOString(),
      })
    } catch (error) {
      unlinkSync(join(dir, stored))
      console.error(`[space-upload] 附件元数据保存失败（${(error as Error).message}）`)
      return Response.json({ error: 'upload_failed' }, { status: 500 })
    }
    return Response.json({
      url: `/api/uploads/${encodeURIComponent(stored)}?sessionId=${encodeURIComponent(sessionId)}`,
      name: rawName, size: buf.byteLength,
    })
  })

  ctx.server.get('/api/uploads/:name', async (req) => {
    const name = String((req as { params?: { name?: string } }).params?.name ?? '')
    let user: { id: string; kind?: string }
    try { user = await ctx.users.verifyToken(readToken(req)) }
    catch { return Response.json({ error: 'unauthorized' }, { status: 401 }) }
    if (user.kind !== 'human') return Response.json({ error: 'unauthorized' }, { status: 401 })
    const url = new URL(req.url, 'http://localhost')
    const sessionId = url.searchParams.get('sessionId')?.trim() ?? ''
    if (!sessionId || !ctx.session.getSession(sessionId) ||
      !ctx.session.listMembers(sessionId, true).some((member) => member.principalId === user.id)) {
      return Response.json({ error: 'not_found' }, { status: 404 })
    }
    // Defense in depth: path validation, metadata-to-session binding, then file lookup.
    if (!name || name.includes('/') || name.includes('..')) {
      return Response.json({ error: 'not_found' }, { status: 404 })
    }
    const rows = await ctx.database.get('file_attachments', { stored_name: name })
    const attachment = rows[0]
    if (!attachment || attachment.session_id !== sessionId) {
      return Response.json({ error: 'not_found' }, { status: 404 })
    }
    const path = join(dir, name)
    if (!existsSync(path)) {
      return Response.json({ error: 'not_found' }, { status: 404 })
    }
    const ext = extname(attachment.original_name).toLowerCase()
    const type = MIME[ext] ?? 'application/octet-stream'
    const body = readFileSync(path)
    return new Response(body, {
      headers: {
        'Content-Type': type,
        // 图片类 inline 展示（浏览器直接渲染），其余附件下载。
        'Content-Disposition': `${INLINE_EXT.has(ext) ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(attachment.original_name)}`,
      },
    })
  })

  ctx.server.post('/api/uploads/:name/import', async (req) => {
    let user: { id: string; kind?: string }
    try { user = await ctx.users.verifyToken(readToken(req)) }
    catch { return Response.json({ error: 'unauthorized' }, { status: 401 }) }
    if (user.kind !== 'human') return Response.json({ error: 'unauthorized' }, { status: 401 })
    const url = new URL(req.url, 'http://localhost')
    const sessionId = url.searchParams.get('sessionId')?.trim() ?? ''
    if (!sessionId || !ctx.session.getSession(sessionId) ||
      !ctx.session.listMembers(sessionId, true).some((member) => member.principalId === user.id)) {
      return Response.json({ error: 'not_found' }, { status: 404 })
    }
    const name = String((req as { params?: { name?: string } }).params?.name ?? '')
    if (!name || name.includes('/') || name.includes('..')) return Response.json({ error: 'not_found' }, { status: 404 })
    const attachment = (await ctx.database.get('file_attachments', { stored_name: name }))[0]
    if (!attachment || attachment.session_id !== sessionId) return Response.json({ error: 'not_found' }, { status: 404 })
    const textExtensions = new Set(['.md', '.txt', '.json', '.csv', '.ts', '.tsx', '.js', '.py', '.go', '.rs', '.java', '.yml', '.yaml', '.html', '.css', '.sql', '.log'])
    if (!textExtensions.has(extname(attachment.original_name).toLowerCase()) || attachment.size_bytes > 256 * 1024) {
      return Response.json({ error: 'unsupported_file', detail: '仅支持 256KB 以内的文本附件导入' }, { status: 415 })
    }
    const path = join(dir, name)
    if (!existsSync(path)) return Response.json({ error: 'not_found' }, { status: 404 })
    const text = readFileSync(path).toString('utf8')
    if (text.includes('\u0000')) return Response.json({ error: 'unsupported_file', detail: '附件不是有效文本' }, { status: 415 })
    const title = `聊天附件：${attachment.original_name}`
    try {
      const source = `attachment:${sessionId}:${name}`
      const existing = (await ctx.kb.listDocuments()).find((document) => document.source === source)
      if (existing) return Response.json({ ok: true, alreadyImported: true, documentId: existing.id, title: existing.title })
      let importing = pendingImports.get(source)
      const alreadyImporting = Boolean(importing)
      if (!importing) {
        importing = ctx.kb.addDocument(title, text, source)
        pendingImports.set(source, importing)
      }
      try {
        const document = await importing
        if (pendingImports.get(source) === importing) pendingImports.delete(source)
        if (!alreadyImporting) {
          ctx.eventLog.append({
            id: randomUUID(), sessionId, authorId: null, phaseId: null,
            authorKind: 'system', kind: 'system',
            text: `成员 ${user.id} 将附件「${attachment.original_name}」导入团队知识库（全团队与 Agent 可检索）。`,
            mentions: [], toolCalls: [], replyMode: '',
          })
        }
        return Response.json({ ok: true, alreadyImported: alreadyImporting, documentId: document.id, title: document.title })
      } catch (error) {
        if (pendingImports.get(source) === importing) pendingImports.delete(source)
        throw error
      }
    } catch (error) {
      console.error(`[space-upload] 附件导入团队知识库失败（${(error as Error).message}）`)
      return Response.json({ error: 'import_failed' }, { status: 500 })
    }
  })
}
