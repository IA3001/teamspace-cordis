// space-client-ui-kb —— 知识库管理页（2026-10-01 新增包）。
//
// 入驻：独立页面 /kb（routes: ['/kb']）。data 方法全部 token 首参
// （localStorage 'space_token'），verifyToken 鉴权 —— 无效统一返回 null，
// 由前端静默跳登录（与 space-client-ui-sessions 同口径）。
// 知识库服务来自 seam space-kb（ctx.kb）；embeddings 状态取
// ctx.embeddings.configured（配置代理按契约提供，若缺失 catch 兜底 false）。
import type { Context } from 'cordis'
import type {} from '@cordisjs/plugin-webui'
import { vectorRerank } from 'space-kb'
import { selectRelevantSearchHits } from './search.ts'

export const name = 'space-client-ui-kb'
// users 也在鉴权里摸到（cordis 严格注入，P4 教训：摸到的服务都要进 inject）。
export const inject = ['webui', 'kb', 'embeddings', 'users', 'kbIndex']

/** token → 用户；无效返回 null（不抛，RPC 层零异常面）。 */
async function auth(ctx: Context, token: string) {
  try {
    return await ctx.users.verifyToken(String(token ?? ''))
  } catch {
    return null
  }
}

export function apply(ctx: Context) {
  ctx.webui.addEntry<Record<string, Function>>(
    {
      baseUrl: import.meta.url,
      source: '../client/index.ts', // 开发态用 —— 我们不启用（A2 构建口径）
      manifest: '../dist/manifest.json', // 生产态用 —— 只走这条
      routes: ['/kb'],
    },
    {
      /** 全部知识库文档；无效 token 返回 null。 */
      async docs(token: string) {
        if (!(await auth(ctx, token))) return null
        return ctx.kb.listDocuments()
      },

      async folders(token: string) {
        if (!(await auth(ctx, token))) return null
        return ctx.kb.listFolders()
      },

      async getDoc(token: string, id: string) {
        if (!(await auth(ctx, token))) return null
        try { return await ctx.kb.getDocument(String(id ?? '')) }
        catch { return { error: 'document-unavailable' } }
      },

      async createFolder(token: string, name: string, parentPath = '') {
        if (!(await auth(ctx, token))) return null
        try { return await ctx.kb.createFolder(String(name ?? ''), String(parentPath ?? '')) }
        catch (e) { return { error: 'folder-create-failed', detail: (e as Error).message } }
      },

      /** 新增文档（来源标记 'manual'）。拒空交给 seam 抛错，catch 后把
       *  detail 返回给前端显示（不往上炸）。 */
      async addDoc(token: string, title: string, text: string, folderPath = '') {
        if (!(await auth(ctx, token))) return null
        try {
          return await ctx.kb.addDocument(String(title ?? ''), String(text ?? ''), 'manual', String(folderPath ?? ''))
        } catch (e) {
          const obj = e as { detail?: string; message?: string }
          return { error: 'add-failed', detail: obj?.detail ?? obj?.message ?? String(e) }
        }
      },

      async updateDoc(token: string, id: string, title: string, text: string, folderPath = '') {
        if (!(await auth(ctx, token))) return null
        try {
          return await ctx.kb.updateDocument(String(id ?? ''), String(title ?? ''), String(text ?? ''), String(folderPath ?? ''))
        } catch (e) {
          const obj = e as { message?: string }
          return { error: 'update-failed', detail: obj?.message ?? String(e) }
        }
      },

      /** 删除文档；无效 token / 失败返回 null。 */
      async removeDoc(token: string, id: string) {
        if (!(await auth(ctx, token))) return null
        try {
          return await ctx.kb.removeDocument(String(id ?? ''))
        } catch {
          return { error: 'remove-failed' }
        }
      },

      /** 检索：topK 固定 8；关键词粗排 + 向量重排（A2）；无效 token 返回 null。 */
      async searchKb(token: string, query: string) {
        if (!(await auth(ctx, token))) return null
        try {
          const q = String(query ?? '')
          const keyword = await ctx.kb.search(q, { topK: 8 })
          if (!ctx.embeddings.configured) return keyword
          const titles = new Map<string, string>(
            (await ctx.kb.listDocuments()).map((d) => [d.id, d.title]),
          )
          const identity = ctx.embeddings.identity
          const reranked = await vectorRerank(q, keyword, {
            modelIdentity: identity,
            currentModelIdentity: () => ctx.embeddings.identity,
            chunks: await ctx.kb.allChunks(),
            embed: (texts) => ctx.embeddings.embed(texts, { expectedIdentity: identity }),
            topK: 8,
            titles,
          })
          return selectRelevantSearchHits(q, keyword, reranked, 8)
        } catch {
          return { error: 'search-failed' }
        }
      },

      /** 向量检索是否已启用（embeddings 服务 configured 契约）；服务缺失
       *  一律兜底 false —— 前端显示「未启用（关键词检索兜底）」。 */
      async embeddingsStatus(token: string) {
        if (!(await auth(ctx, token))) return null
        try {
          return ctx.embeddings.configured && (await ctx.kbIndex.status()).state === 'ready'
        } catch {
          return false
        }
      },
    },
  )
}
