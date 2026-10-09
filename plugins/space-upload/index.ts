// space-upload —— IM 文件消息的上传/下载面（最小可行版，2026-10-01）。
//
//   POST /api/upload?name=<文件名>   cookie 鉴权；body = 原始字节，上限 20MB；
//                                   落盘 data/uploads/<uuid>-<安全化文件名>，
//                                   返回 { url, name, size }。
//   GET  /api/uploads/:name          免鉴权（局域网协作定位）；防目录穿越
//                                   （name 含 / 或 .. 直接 404）；按扩展名猜
//                                   Content-Type，图片类 inline 展示。
//
// 文件不进事件新列：上传成功后前端把下载路径拼进消息文本（[文件] 开头），
// 复用现有消息全链路。
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, extname } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Context } from 'cordis'

export const name = 'space-upload'
// kb（2026-10-06 A3）：文本类附件自动灌入知识库（异步向量化）→ AI 检索
// 上下文能看到附件内容，而不只是 [文件] 链接。
export const inject = ['server', 'users', 'kb']

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
function readToken(req: Request): string {
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
  ctx.server.post('/api/upload', async (req) => {
    // cookie 鉴权：无效 → 401。
    try {
      await ctx.users.verifyToken(readToken(req))
    } catch {
      return Response.json({ error: 'unauthorized' }, { status: 401 })
    }
    const url = new URL(req.url, 'http://localhost')
    const rawName = url.searchParams.get('name') ?? 'file'
    const buf = await req.arrayBuffer()
    if (buf.byteLength > MAX_BYTES) {
      return Response.json({ error: 'too_large' }, { status: 413 })
    }
    // 落盘：<uuid>-<安全化文件名>，防同名互踩。
    mkdirSync(dir, { recursive: true })
    const stored = `${randomUUID()}-${sanitize(rawName)}`
    writeFileSync(join(dir, stored), Buffer.from(buf))

    // A3（2026-10-06）：文本类附件自动灌入知识库（异步向量化由 kb-embedder
    // 跟进）——AI 检索上下文可见附件内容。口径：≤256KB 的常见文本扩展名，
    // 解码后不含二元乱码特征（\u0000）；失败不影响上传本身（附件照常可用）。
    const TEXT_EXTS = new Set(['.md', '.txt', '.json', '.csv', '.ts', '.tsx', '.js', '.py', '.go', '.rs', '.java', '.yml', '.yaml', '.html', '.css', '.sql', '.log'])
    if (TEXT_EXTS.has(extname(rawName).toLowerCase()) && buf.byteLength <= 256 * 1024) {
      void (async () => {
        try {
          const text = Buffer.from(buf).toString('utf8')
          if (text.includes('\u0000')) return
          const doc = await ctx.kb.addDocument(`[附件] ${rawName}`, text, 'file')
          console.log(`[space-upload] 附件已入知识库：${doc.title}（${doc.chunkCount} 块）`)
        } catch (e) {
          console.error(`[space-upload] 附件入知识库失败（不影响上传）：${(e as Error).message}`)
        }
      })()
    }

    return Response.json({ url: `/api/uploads/${stored}`, name: rawName, size: buf.byteLength })
  })

  ctx.server.get('/api/uploads/:name', async (req) => {
    const name = String((req as { params?: { name?: string } }).params?.name ?? '')
    // 防目录穿越：含 / 或 .. 直接 404。
    if (!name || name.includes('/') || name.includes('..')) {
      return Response.json({ error: 'not_found' }, { status: 404 })
    }
    const path = join(dir, name)
    if (!existsSync(path)) {
      return Response.json({ error: 'not_found' }, { status: 404 })
    }
    const ext = extname(name).toLowerCase()
    const type = MIME[ext] ?? 'application/octet-stream'
    const body = readFileSync(path)
    return new Response(body, {
      headers: {
        'Content-Type': type,
        // 图片类 inline 展示（浏览器直接渲染），其余附件下载。
        'Content-Disposition': `${INLINE_EXT.has(ext) ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(name)}`,
      },
    })
  })
}
