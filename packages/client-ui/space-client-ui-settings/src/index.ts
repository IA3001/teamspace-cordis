// space-client-ui-settings —— 模型与接入设置页（2026-10-05 新增包）。
//
// 背景：cordis 面板的原生 schemastery 配置表单对本地 ts 插件渲染不出来
// （插件页显示「此插件尚未安装」、/config 404），模型接入必须有自己的
// 面板通道。本页与账号管理（space-client-ui-admin）同款方式入驻 5172：
//   · 入驻：挂 **5172 调试控制台**，routes ['/models']；不走 HTTP，
//     全部数据方法走 webui RPC。
//   · isolate 口径：不写 isolate（消费 debug-webui 的无名 webui 实例），
//     与 admin 包同一拍板（见 admin/src/index.ts 头注）。
//
// 权限口径：所有 data 方法首参独立 Admin token（localStorage 'admin_token'），
// 后台数据方法使用独立 Admin session；Team token 不可访问。
//
// 数据流：表单 → RPC save → ctx.settings（sqlite settings 表，0013 迁移）
// → space-llm-openai / space-embedding-openai 每次 resolve() 现读 ——
// **改完即生效，无需重启**。apiKey 只写不回显（ getConfig 返回 keyTail）。
import type { Context } from 'cordis'
import type {} from '@cordisjs/plugin-webui'
import { AdminAuthError } from 'space-admin-auth'
import { LlmError } from 'space-llm'

export const name = 'space-client-ui-settings'
// users（鉴权）+ settings（读写）+ llm/embeddings（连通测试用现配服务）。
export const inject = ['webui', 'settings', 'llm', 'embeddings', 'adminAuth']

/** token → Admin principal；无效返回 null（不抛，RPC 层零异常面）。 */
async function auth(ctx: Context, token: string) {
  try {
    return await ctx.adminAuth.verifyToken(String(token ?? ''))
  } catch {
    return null
  }
}

/** AdminAuthError/LlmError → { error, detail } 结构化失败（前端直接展示）。 */
function fail(e: unknown): { error: string; detail: string } {
  if (e instanceof AdminAuthError || e instanceof LlmError) {
    return { error: (e as { code?: string }).code ?? 'failed', detail: e.message }
  }
  return { error: 'internal', detail: e instanceof Error ? e.message : String(e) }
}

/** 设置键（与 space-llm-openai / space-embedding-openai 的 resolve() 逐字对齐）。 */
const LLM_KEYS = ['llm.apiKey', 'llm.baseURL', 'llm.model', 'llm.timeoutMs'] as const
const EMBED_KEYS = ['embed.apiKey', 'embed.baseURL', 'embed.model'] as const

export function apply(ctx: Context) {
  ctx.webui.addEntry(
    {
      baseUrl: import.meta.url,
      source: '../client/index.ts', // 开发态用 —— 我们不启用（A2 构建口径）
      manifest: '../dist/manifest.json', // 生产态用 —— 只走这条
      routes: ['/models'],
    },
    {
      /** 当前 Admin session。 */
      async me(token: string) {
        return auth(ctx, token)
      },

      /** 读当前设置。apiKey 不回显，只给 keyTail（后 4 位）与 hasKey。 */
      async getConfig(token: string) {
        const me = await auth(ctx, token)
        if (!me) return null
        const s = ctx.settings
        const shape = (prefix: string) => {
          const key = s.get<string>(`${prefix}.apiKey`, '')
          return {
            baseURL: s.get<string>(`${prefix}.baseURL`, ''),
            model: s.get<string>(`${prefix}.model`, ''),
            hasKey: Boolean(key),
            keyTail: key ? key.slice(-4) : '',
          }
        }
        return {
          llm: { ...shape('llm'), timeoutMs: s.get<number>('llm.timeoutMs', 60000) },
          embed: shape('embed'),
          env: {
            llmConfigured: ctx.llm.configured,
            embedConfigured: ctx.embeddings.configured,
          },
        }
      },

      /** 保存 LLM 设置。apiKey 传空 = 保留现值；传 '-' = 清除。 */
      async saveLlm(token: string, cfg: { baseURL?: string; model?: string; apiKey?: string; timeoutMs?: number }) {
        const me = await auth(ctx, token)
        if (!me) return null
        const s = ctx.settings
        if (typeof cfg.baseURL === 'string') s.set('llm.baseURL', cfg.baseURL.trim())
        if (typeof cfg.model === 'string') s.set('llm.model', cfg.model.trim())
        if (typeof cfg.timeoutMs === 'number' && cfg.timeoutMs > 0) s.set('llm.timeoutMs', Math.floor(cfg.timeoutMs))
        if (cfg.apiKey === '-') s.set('llm.apiKey', undefined)
        else if (typeof cfg.apiKey === 'string' && cfg.apiKey.trim()) s.set('llm.apiKey', cfg.apiKey.trim())
        return { ok: true }
      },

      /** 保存 Embedding 设置。apiKey 语义同上。 */
      async saveEmbed(token: string, cfg: { baseURL?: string; model?: string; apiKey?: string }) {
        const me = await auth(ctx, token)
        if (!me) return null
        const s = ctx.settings
        if (typeof cfg.baseURL === 'string') s.set('embed.baseURL', cfg.baseURL.trim())
        if (typeof cfg.model === 'string') s.set('embed.model', cfg.model.trim())
        if (cfg.apiKey === '-') s.set('embed.apiKey', undefined)
        else if (typeof cfg.apiKey === 'string' && cfg.apiKey.trim()) s.set('embed.apiKey', cfg.apiKey.trim())
        return { ok: true }
      },

      /** LLM 连通测试：直接用**当前已保存**配置打一次 /chat/completions。 */
      async testLlm(token: string) {
        const me = await auth(ctx, token)
        if (!me) return null
        const t0 = Date.now()
        try {
          const out = await ctx.llm.chat([{ role: 'user', content: 'ping，请只回复 pong' }], { timeoutMs: 20_000 })
          return { ok: true, detail: `连通正常（${Date.now() - t0}ms）：${out.slice(0, 80)}` }
        } catch (e) {
          return { ok: false, ...fail(e) }
        }
      },

      /** Embedding 连通测试：用当前已保存配置向量一条短文本。 */
      async testEmbed(token: string) {
        const me = await auth(ctx, token)
        if (!me) return null
        const t0 = Date.now()
        try {
          const v = await ctx.embeddings.embed(['连通测试'])
          return { ok: true, detail: `连通正常（${Date.now() - t0}ms）：返回 ${v[0]?.length ?? 0} 维向量` }
        } catch (e) {
          return { ok: false, ...fail(e) }
        }
      },
    },
  )
}

// 供类型检查的键存在性说明（不参与运行时）：LLM_KEYS / EMBED_KEYS 只在本
// 文档注释里约束命名 —— 真正的消费者是两个 impl 的 resolve()，改键名必须
// 两边同步（跨包字符串契约，非类型可查，故在此显式列出防漂移）。
void LLM_KEYS
void EMBED_KEYS
