// 知识库管理页（客户端）—— 2026-10-01 新增。
//
// 结构：顶部（标题「知识库管理」+ 向量检索状态 el-tag + 搜索框）→ 新增文档
// 卡片（标题 + 正文 textarea + 添加按钮，失败 el-alert 显示 detail）→ 文档
// 列表 el-table（删除带 el-popconfirm）→ 搜索命中列表（el-card 每条）→
// 末尾说明 el-alert（info）。
//
// 鉴权：RPC 首参 token（localStorage 'space_token'）；me(token) 探测 ——
// null = 未登录跳 /login（与 /login 页、sessions 栏共用口径）。
//
// 铁律 1：只用外壳全局注册的 el-* / k-*（resolveComponent），零 import
// element-plus、零手写样式、零内联 style。
import { defineComponent, h, onMounted, ref, resolveComponent } from 'vue'
import { useRouter, useRpc } from '@cordisjs/client'
import { ThemeStyle } from 'space-client-ui-shared/client/theme.ts'
import { pageHead, status, section, field, actionsRow, note } from 'space-client-ui-shared/client/console.ts'

/** 知识库文档视图（KbDocument 契约子集）。 */
interface DocRow {
  id: string
  title: string
  source: string
  size: number
  chunkCount: number
  createdAt: string
}

/** 检索命中（chunk：所属文档标题 + 命中文本；形状宽松处理）。 */
interface HitRow {
  documentId?: string
  documentTitle?: string
  title?: string
  text?: string
  content?: string
  score?: number
}

/** 登录 token 的 localStorage 键（/login 页与各 RPC 共用）。 */
const TOKEN_KEY = 'space_token'
const getToken = () => localStorage.getItem(TOKEN_KEY) ?? ''

const KbPage = defineComponent({
  name: 'SpaceKbPage',
  setup() {
    const router = useRouter()
    const rpc = useRpc<{
      docs(token: string): Promise<DocRow[] | null>
      addDoc(token: string, title: string, text: string): Promise<DocRow | { error: string; detail: string } | null>
      removeDoc(token: string, id: string): Promise<unknown>
      searchKb(token: string, query: string): Promise<HitRow[] | null>
      embeddingsStatus(token: string): Promise<boolean | null>
    }>()

    const me = ref(null) as { value: { displayName?: string } | null }
    void me // 保留引用位：后续「当前身份」展示用
    const docs = ref([]) as { value: DocRow[] }
    const embOn = ref(false)
    const loaded = ref(false)

    // ── 新增表单 ────────────────────────────────────────────────────────
    const newTitle = ref('')
    const newText = ref('')
    const addBusy = ref(false)
    const addErr = ref('')

    // ── 搜索 ────────────────────────────────────────────────────────────
    const query = ref('')
    const searchBusy = ref(false)
    const hits = ref<HitRow[] | null>(null) // null = 还没搜过

    /** 拉文档列表。 */
    async function refresh() {
      const list = await rpc.value.docs(getToken())
      if (list === null) {
        // 无效 token → 静默跳登录（既有惯例）。
        void router.replace('/login')
        return
      }
      docs.value = list
      loaded.value = true
    }

    onMounted(async () => {
      // 列表 + 向量检索状态两路并发；token 无效（null）统一跳 /login。
      const [emb, list] = await Promise.all([
        rpc.value.embeddingsStatus(getToken()),
        rpc.value.docs(getToken()),
      ])
      if (list === null) {
        void router.replace('/login')
        return
      }
      embOn.value = emb === true
      docs.value = list ?? []
      loaded.value = true
    })

    /** 添加文档：成功清空并刷新；失败把 detail 放 addErr 显示。 */
    async function doAdd() {
      addBusy.value = true
      addErr.value = ''
      try {
        const res = await rpc.value.addDoc(getToken(), newTitle.value, newText.value)
        if (res === null) {
          void router.replace('/login')
          return
        }
        if ((res as { error?: string }).error) {
          addErr.value = (res as { detail?: string }).detail ?? '添加失败'
          return
        }
        newTitle.value = ''
        newText.value = ''
        await refresh()
      } finally {
        addBusy.value = false
      }
    }

    /** 删除文档（popconfirm 确认后调用）。 */
    async function doRemove(id: string) {
      await rpc.value.removeDoc(getToken(), id)
      await refresh()
    }

    /** 检索：结果进 hits；null（未登录）跳 /login。 */
    async function doSearch() {
      if (!query.value.trim()) return
      searchBusy.value = true
      try {
        const res = await rpc.value.searchKb(getToken(), query.value)
        if (res === null) {
          void router.replace('/login')
          return
        }
        hits.value = res
      } finally {
        searchBusy.value = false
      }
    }

    /** 命中条目归一化：标题 / 文本字段名做宽松兼容。 */
    function hitTitle(hit: HitRow) {
      // 服务端 search 返回的字段名是 doc_title（kb.ts 的 SQL 别名）——
      // 三种命名都认，杜绝「（未知文档）」兜底露脸（2026-10-05）。
      const any = hit as Record<string, unknown>
      return (hit.documentTitle ?? any.doc_title ?? hit.title ?? any.docTitle ?? hit.documentId ?? '（未知文档）') as string
    }
    function hitText(hit: HitRow) {
      return hit.text ?? hit.content ?? ''
    }

    return () => {
      const ElButton = resolveComponent('el-button') as unknown as string
      const ElEmpty = resolveComponent('el-empty') as unknown as string
      const ElInput = resolveComponent('el-input') as unknown as string
      const ElPopconfirm = resolveComponent('el-popconfirm') as unknown as string
      const ElTable = resolveComponent('el-table') as unknown as string
      const ElTableColumn = resolveComponent('el-table-column') as unknown as string

      // ── 页头 + 三个分区卡（console.ts 设计语言，2026-10-05）─────────────
      return h('div', { class: 'k-content sp-admin-wrap' }, [
        h(ThemeStyle),
        pageHead('知识库',
          '灌入的文档进入 AI 的检索上下文（优先级：会话历史 > 知识库 > 记忆）；向量检索未启用时自动用关键词检索兜底。',
          {
            statuses: [
              { text: embOn.value ? '向量检索已启用' : '向量检索未启用（关键词兜底）',
                level: embOn.value ? 'ok' : 'warn' },
              { text: `文档 ${docs.value.length} 篇`, level: 'idle' },
            ],
            actions: [
              { label: '← 团队空间', onClick: () => { location.href = '/teamspace' } },
            ],
          }),
        addErr.value ? note(addErr.value, false) : null,

        // ── 检索 ──────────────────────────────────────────────────────
        section('检索', '跨全部已灌入文档做相关性检索；结果按命中块返回。',
          [
            actionsRow([
              h(ElInput, {
                modelValue: query.value,
                'onUpdate:modelValue': (v: string) => { query.value = v },
                placeholder: '搜索知识库…',
                clearable: true,
                style: 'flex:1',
                onKeydown: (e: KeyboardEvent) => { if (e.key === 'Enter') void doSearch() },
              }),
              h(ElButton, {
                type: 'primary', loading: searchBusy.value, onClick: () => void doSearch(),
              }, { default: () => '搜索' }),
            ]),
            hits.value === null
              ? null
              : (hits.value.length
                  ? h('div', { class: 'sp-hint', style: 'margin-top:12px' },
                      `命中 ${hits.value.length} 块：`)
                  : h('div', { class: 'sp-hint', style: 'margin-top:12px' }, '没有命中。')),
            ...(hits.value ?? []).map((hit, i) => h('div', {
              key: i, class: 'sp-section',
              style: 'margin:10px 0 0;box-shadow:none;background:var(--el-fill-color-light)',
            }, [
              h('div', { class: 'sp-section-title', style: 'font-size:13.5px' }, hitTitle(hit)),
              h('div', { class: 'sp-hint', style: 'margin-top:6px' }, hitText(hit)),
            ])),
          ]),

        // ── 新增文档 ──────────────────────────────────────────────────
        section('新增文档', '正文会自动分块入库；标题用于检索结果展示。',
          [
            h('div', { class: 'sp-grid' }, [
              field('标题', h(ElInput, {
                modelValue: newTitle.value,
                'onUpdate:modelValue': (v: string) => { newTitle.value = v },
                placeholder: '文档标题',
              }), undefined, true),
              field('正文', h(ElInput, {
                modelValue: newText.value,
                'onUpdate:modelValue': (v: string) => { newText.value = v },
                type: 'textarea', rows: 6,
                placeholder: '文档正文…',
              }), undefined, true),
            ]),
            actionsRow([
              h(ElButton, {
                type: 'primary', loading: addBusy.value, onClick: () => void doAdd(),
              }, { default: () => '添加到知识库' }),
            ]),
          ]),

        // ── 文档列表 ──────────────────────────────────────────────────
        section('文档', '删除会连带全部分块；不可恢复。',
          [
            loaded.value
              ? h(ElTable, { data: docs.value, size: 'small' }, {
                  default: () => [
                    h(ElTableColumn, { prop: 'title', label: '标题', minWidth: 200 }),
                    h(ElTableColumn, { prop: 'source', label: '来源', width: 100 }),
                    h(ElTableColumn, { label: '大小(字符)', width: 110 }, {
                      default: (scope: { row: DocRow }) => String(scope.row.size ?? 0),
                    }),
                    h(ElTableColumn, { prop: 'chunkCount', label: '分块数', width: 90 }),
                    h(ElTableColumn, { label: '创建时间', width: 180 }, {
                      default: (scope: { row: DocRow }) => {
                        try { return new Date(scope.row.createdAt).toLocaleString('zh-CN') } catch { return scope.row.createdAt }
                      },
                    }),
                    h(ElTableColumn, { label: '操作', width: 100 }, {
                      default: (scope: { row: DocRow }) => h(ElPopconfirm, {
                        title: '确认删除该文档？',
                        onConfirm: () => void doRemove(scope.row.id),
                      }, {
                        reference: () => h(ElButton, { type: 'danger', size: 'small', link: true }, { default: () => '删除' }),
                      }),
                    }),
                  ],
                })
              : h(ElEmpty, { description: '正在加载…' }),
          ]),
      ])
    }
  },
})

// ── 页面注册（官方约定，仿 auth 页）──────────────────────────────────────
interface PageCtx {
  client: {
    router: {
      page(options: { path: string; name: string; order?: number; component: unknown }): void
    }
  }
}

export default function main(ctx: PageCtx) {
  ctx.client.router.page({
    path: '/kb',
    name: '知识库',
    order: 100,
    icon: ICONS.kb, component: KbPage,
  })
}
