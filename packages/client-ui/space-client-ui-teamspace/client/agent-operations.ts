import { computed, defineComponent, h, onMounted, onUnmounted, ref, resolveComponent } from 'vue'
import type { VNodeChild } from 'vue'
import { useRpc } from '@cordisjs/client'
import { ThemeStyle } from 'space-client-ui-shared/client/theme.ts'
import { ICONS } from 'space-client-ui-shared/client/console.ts'
import 'space-client-ui-shared/client/im.css'

type AgentRow = { id: string; title: string; status: string; workdirAvailable: boolean }
type MemoryRow = { id: string; scope: string; kind: string; folderPath: string; text: string; weight: number; authorId: string | null; sourceEventIds: string[]; invalidatedAt: string | null; createdAt: string }
type MemoryFolderRow = { path: string; name: string; parentPath: string; itemCount: number }
type MemoryFolderNode = { path: string; name: string; itemCount: number; children: MemoryFolderNode[] }
type MemoryResult = { total: number; items: MemoryRow[] }
type FileRow = { name: string; path: string; kind: 'directory' | 'file'; size: number; modifiedAt: string; isLeaf?: boolean; virtual?: boolean }
type WorklogRow = { label: string; at: string; kind?: 'phase' | 'tool'; status?: 'running' | 'success' | 'failed'; detail?: string; toolId?: string; inputSummary?: string; resultSummary?: string; durationMs?: number }
type RunRow = { runId: string; sessionId: string; agentId: string; title: string; phase: string; toolTitle?: string; ok?: boolean; at: string; steps: WorklogRow[] }
type InboxMessage = { id: string; seq: number; at: string; kind: string; author: string; authorKind: string; text: string }
type InboxDetail = { sessionId: string; sessionTitle: string; total: number; page: number; pageSize: number; cursor: number; latestSeq: number; active: boolean; items: InboxMessage[] }
type InboxSession = { sessionId: string; sessionTitle: string; count: number; processedCount: number; cursor: number; latestSeq: number; active: boolean }
type InboxRow = { agentId: string; pending: InboxSession[] }
type ProcessingRow = { agentId: string; sessionId: string; seq: number; eventId: string; phase: string; detail: string; startedAt: string; updatedAt: string }
type WorkspaceOverview = { agents: AgentRow[]; progress: RunRow[]; inboxes: InboxRow[]; processing: ProcessingRow[] }
type AgentOperationsRpc = {
  agentMemories(token: string, agentId: string, offset?: number, includeInvalidated?: boolean, limit?: number, folderPath?: string): Promise<MemoryResult | null>
  agentMemoryFolders(token: string, agentId: string): Promise<MemoryFolderRow[] | null>
  agentMemoryCreateFolder(token: string, agentId: string, name: string, parentPath?: string): Promise<MemoryFolderRow | { error: string } | null>
  agentMemoryMove(token: string, agentId: string, memoryId: string, folderPath: string): Promise<{ id: string; folderPath: string } | { error: string } | null>
  agentMemoryCatalog(token: string): Promise<AgentRow[] | null>
  agentWorkspaceOverview(token: string): Promise<WorkspaceOverview | null>
  agentWorkspaceInbox(token: string, agentId: string, sessionId: string, page?: number, pageSize?: number): Promise<InboxDetail | null>
  agentWorkspaceHistory(token: string, agentId: string, sessionId: string, page?: number, pageSize?: number): Promise<InboxDetail | null>
  agentWorkspaceBrowse(token: string, agentId: string, path?: string): Promise<{ exists: boolean; entries?: FileRow[]; error?: string } | null>
  agentWorkspaceRead(token: string, agentId: string, path: string): Promise<{ text?: string; error?: string } | null>
  sharedWorkspaceBrowse(token: string, path?: string): Promise<{ exists: boolean; entries?: FileRow[]; error?: string } | null>
  sharedWorkspaceRead(token: string, path: string): Promise<{ text?: string; error?: string } | null>
}

const token = () => localStorage.getItem('space_token') ?? ''
const dateText = (value: string) => {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}
const tableDateText = (value: string) => {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  })
}
const elapsedText = (value: string) => {
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 1000))
  return seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`
}
const legacyFilesPath = '__legacy_root_files__'
const phaseText: Record<string, string> = {
  started: '已接收任务', preparing: '准备工作区', 'assembling-context': '整理上下文',
  'waiting-model': '等待模型响应', processing: '处理任务', 'tool-start': '调用工具',
  'tool-finish': '工具调用完成', 'text-delta': '生成回复', finalizing: '整理答复',
  completed: '已完成', failed: '执行失败', cancelled: '已取消',
}
const inboxPhaseText: Record<string, string> = {
  'reviewing-decision': '复核团队决策', 'extracting-memory': '提取长期记忆',
  'onboarding-history': '分析加入前的历史消息', 'advancing-cursor': '保存处理进度', failed: '处理失败，等待重试',
}

function sharedPage(title: string, subtitle: string, content: VNodeChild, pageClass = '') {
  const KLayout = resolveComponent('k-layout') as unknown as string
  const ElText = resolveComponent('el-text') as unknown as string
  const ElButton = resolveComponent('el-button') as unknown as string
  const ElSpace = resolveComponent('el-space') as unknown as string
  const ElMain = resolveComponent('el-main') as unknown as string
  return h(KLayout, { main: 'page-teamspace-agent-operations', class: 'sp-team-layout' }, {
    header: () => h(ElSpace, { size: 16 }, { default: () => [
      h(ElText, { tag: 'strong' }, { default: () => '团队空间' }),
      h(ElButton, { text: true, onClick: () => window.location.assign('/teamspace') }, { default: () => '返回会话' }),
    ] }),
    default: () => [
      h(ThemeStyle),
      h(ElMain, { class: ['sp-agent-page', pageClass] }, { default: () => h('div', { class: 'sp-agent-page-inner' }, [
        h('header', { class: 'sp-agent-page-head' }, [
          h('div', [
            h(ElText, { tag: 'h1' }, { default: () => title }),
            h(ElText, { type: 'info' }, { default: () => subtitle }),
          ]),
        ]),
        h('div', { class: 'sp-agent-page-content' }, [content]),
      ]) }),
    ],
  })
}

export const AgentMemoryPage = defineComponent({
  name: 'AgentMemoryPage',
  setup() {
    const rpc = useRpc<AgentOperationsRpc>()
    const agents = ref([] as AgentRow[])
    const selectedId = ref('')
    const memories = ref({ total: 0, items: [] } as MemoryResult)
    const folders = ref([] as MemoryFolderRow[])
    const selectedFolderPath = ref('')
    const selected = ref(null as MemoryRow | null)
    const detailOpen = ref(false)
    const offset = ref(0)
    const pageSize = ref(20)
    const includeInvalidated = ref(false)
    const loading = ref(false)
    const notice = ref('')
    const folderDialogOpen = ref(false)
    const folderName = ref('')
    const folderBusy = ref(false)
    const moveTarget = ref('')
    const totalPages = computed(() => Math.max(1, Math.ceil(memories.value.total / pageSize.value)))

    const loadMemories = async () => {
      if (!selectedId.value) return
      loading.value = true
      try {
        const result = await rpc.value.agentMemories(token(), selectedId.value, offset.value, includeInvalidated.value, pageSize.value, selectedFolderPath.value)
        if (!result) { notice.value = '无法读取记忆，请重新登录后重试'; return }
        memories.value = result
        selected.value = result.items.find((item) => item.id === selected.value?.id) ?? result.items[0] ?? null
        notice.value = ''
      } catch (error) { notice.value = (error as Error).message }
      finally { loading.value = false }
    }
    const loadFolders = async () => {
      if (!selectedId.value) return
      try {
        const result = await rpc.value.agentMemoryFolders(token(), selectedId.value)
        if (!result) { notice.value = '无法读取记忆文件夹'; return }
        folders.value = result
      } catch (error) { notice.value = (error as Error).message }
    }
    const selectMemoryAgent = async (id: string) => {
      selectedId.value = id; selectedFolderPath.value = ''; offset.value = 0; selected.value = null; detailOpen.value = false
      await Promise.all([loadFolders(), loadMemories()])
    }
    const createMemoryFolder = async () => {
      if (!selectedId.value || !folderName.value.trim()) return
      folderBusy.value = true
      try {
        const result = await rpc.value.agentMemoryCreateFolder(token(), selectedId.value, folderName.value.trim(), selectedFolderPath.value)
        if (!result) { notice.value = '无法创建文件夹'; return }
        if ('error' in result) { notice.value = result.error; return }
        folderName.value = ''; folderDialogOpen.value = false; notice.value = ''
        await loadFolders()
        selectedFolderPath.value = result.path
        offset.value = 0
        await loadMemories()
      } catch (error) { notice.value = (error as Error).message }
      finally { folderBusy.value = false }
    }
    const moveSelectedMemory = async () => {
      if (!selectedId.value || !selected.value) return
      try {
        const result = await rpc.value.agentMemoryMove(token(), selectedId.value, selected.value.id, moveTarget.value)
        if (!result) { notice.value = '无法移动记忆'; return }
        if ('error' in result) { notice.value = result.error; return }
        detailOpen.value = false
        await Promise.all([loadFolders(), loadMemories()])
      } catch (error) { notice.value = (error as Error).message }
    }
    const loadAgents = async () => {
      const result = await rpc.value.agentMemoryCatalog(token())
      if (!result) { notice.value = '无法读取 Agent 目录，请重新登录后重试'; return }
      agents.value = result.map((agent: any) => ({ id: agent.id, title: agent.title, status: agent.status, workdirAvailable: false }))
      if (!selectedId.value && agents.value.length) selectedId.value = agents.value[0]!.id
      await Promise.all([loadFolders(), loadMemories()])
    }
    onMounted(() => void loadAgents())

    return () => {
      const ElRow = resolveComponent('el-row') as unknown as string
      const ElCol = resolveComponent('el-col') as unknown as string
      const ElCard = resolveComponent('el-card') as unknown as string
      const ElMenu = resolveComponent('el-menu') as unknown as string
      const ElMenuItem = resolveComponent('el-menu-item') as unknown as string
      const ElTable = resolveComponent('el-table') as unknown as string
      const ElTableColumn = resolveComponent('el-table-column') as unknown as string
      const ElButton = resolveComponent('el-button') as unknown as string
      const ElTag = resolveComponent('el-tag') as unknown as string
      const ElText = resolveComponent('el-text') as unknown as string
      const ElEmpty = resolveComponent('el-empty') as unknown as string
      const ElCheckbox = resolveComponent('el-checkbox') as unknown as string
      const ElPagination = resolveComponent('el-pagination') as unknown as string
      const ElDescriptions = resolveComponent('el-descriptions') as unknown as string
      const ElDescriptionsItem = resolveComponent('el-descriptions-item') as unknown as string
      const ElScrollbar = resolveComponent('el-scrollbar') as unknown as string
      const ElDrawer = resolveComponent('el-drawer') as unknown as string
      const ElSpace = resolveComponent('el-space') as unknown as string
      const ElTree = resolveComponent('el-tree') as unknown as string
      const ElInput = resolveComponent('el-input') as unknown as string
      const ElDialog = resolveComponent('el-dialog') as unknown as string
      const menu = h(ElMenu, { defaultActive: selectedId.value, onSelect: (id: string) => { void selectMemoryAgent(id) } }, { default: () => agents.value.map((agent) => h(ElMenuItem, { index: agent.id, key: agent.id }, {
        default: () => h('span', agent.title),
      })) })
      const folderNodes = computed(() => {
        const root: MemoryFolderNode = { path: '', name: '全部记忆', itemCount: 0, children: [] }
        const byPath = new Map<string, MemoryFolderNode>([['', root]])
        for (const folder of [...folders.value].sort((a, b) => a.path.localeCompare(b.path, 'zh-CN'))) {
          const node: MemoryFolderNode = { path: folder.path, name: folder.name, itemCount: folder.itemCount, children: [] }
          byPath.set(folder.path, node)
          ;(byPath.get(folder.parentPath) ?? root).children.push(node)
        }
        return [root]
      })
      const folderTree = h(ElTree, {
        data: folderNodes.value, nodeKey: 'path', highlightCurrent: true, defaultExpandAll: true,
        currentNodeKey: selectedFolderPath.value, props: { label: 'name', children: 'children' },
        onNodeClick: (node: MemoryFolderNode) => {
          selectedFolderPath.value = node.path; offset.value = 0; detailOpen.value = false; void loadMemories()
        },
        renderAfterExpand: false,
        renderContent: (_render: unknown, context: { data: MemoryFolderNode }) => h('span', { class: 'sp-explorer-tree-node' }, [
          h('span', context.data.name), context.data.path ? h(ElText, { type: 'info', size: 'small' }, { default: () => String(context.data.itemCount) }) : null,
        ]),
      })
      const table = memories.value.items.length ? h(ElTable, {
        data: memories.value.items, rowKey: 'id', highlightCurrentRow: true, loading: loading.value, tableLayout: 'fixed',
        height: 'calc(100vh - 390px)',
        onRowClick: (row: MemoryRow) => { selected.value = row; moveTarget.value = row.folderPath; detailOpen.value = true },
      }, {
        default: () => [
          h(ElTableColumn, { prop: 'kind', label: '类型', width: 190, showOverflowTooltip: true }),
          h(ElTableColumn, { label: '记忆内容', minWidth: 360, showOverflowTooltip: true }, {
            default: ({ row }: { row: MemoryRow }) => row.text,
          }),
          h(ElTableColumn, { label: '重要性', width: 100 }, { default: ({ row }: { row: MemoryRow }) => `${Math.round(row.weight * 100)}%` }),
          h(ElTableColumn, { label: '创建时间', width: 130 }, { default: ({ row }: { row: MemoryRow }) => tableDateText(row.createdAt) }),
          includeInvalidated.value ? h(ElTableColumn, { label: '状态', width: 110 }, {
            default: ({ row }: { row: MemoryRow }) => row.invalidatedAt
              ? h(ElTag, { type: 'warning' }, { default: () => '已失效' }) : h(ElTag, { type: 'success' }, { default: () => '有效' }),
          }) : null,
        ],
      }) : h(ElEmpty, { description: loading.value ? '正在读取 Agent 记忆…' : '这个 Agent 还没有持久记忆' })
      const content = h(ElRow, { gutter: 18, class: 'sp-agent-explorer' }, {
        default: () => [
          h(ElCol, { span: 4 }, h(ElCard, { shadow: 'never', class: 'sp-memory-agent-card' }, {
            header: () => h('strong', 'Agent'), default: () => h(ElScrollbar, { class: 'sp-memory-agent-scroll', always: true, height: '100%' }, { default: () => menu }),
          })),
          h(ElCol, { span: 5 }, h(ElCard, { shadow: 'never', class: 'sp-memory-folder-card' }, {
            header: () => h(ElSpace, { class: 'sp-memory-folder-toolbar', alignment: 'center' }, { default: () => [
              h('strong', '文件夹'),
              h(ElButton, { text: true, type: 'primary', onClick: () => { folderName.value = ''; folderDialogOpen.value = true } }, { default: () => '新建' }),
            ] }),
            default: () => h(ElScrollbar, { class: 'sp-memory-folder-scroll', always: true, height: '100%' }, { default: () => folderTree }),
          })),
          h(ElCol, { span: 15 }, h(ElCard, { shadow: 'never', class: 'sp-memory-list-card' }, {
            header: () => h(ElSpace, { class: 'sp-memory-toolbar', size: 12, alignment: 'center', wrap: true }, { default: () => [
              h('strong', selectedFolderPath.value || '全部记忆'),
              h(ElText, { type: 'info' }, { default: () => `${memories.value.total} 条` }),
              h(ElSpace, { size: 8 }, { default: () => [
                h(ElCheckbox, { modelValue: includeInvalidated.value, 'onUpdate:modelValue': (value: boolean) => {
                  includeInvalidated.value = value; offset.value = 0; void loadMemories()
                } }, { default: () => '显示已失效' }),
              ] }),
            ] }),
            default: () => [
              table,
              h(ElPagination, { class: 'sp-memory-pagination', background: true, layout: 'sizes, prev, pager, next, total',
                currentPage: offset.value / pageSize.value + 1, pageSize: pageSize.value,
                pageSizes: [10, 20, 50], pageCount: totalPages.value, total: memories.value.total,
                onSizeChange: (size: number) => { pageSize.value = size; offset.value = 0; void loadMemories() },
                onCurrentChange: (page: number) => { offset.value = (page - 1) * pageSize.value; void loadMemories() } }),
            ],
          })),
          h(ElDrawer, { modelValue: detailOpen.value, title: '记忆详情', size: '480px', direction: 'rtl',
            'onUpdate:modelValue': (value: boolean) => { detailOpen.value = value } }, {
            default: () => selected.value ? [
              h(ElScrollbar, { maxHeight: '52vh' }, { default: () => h('pre', { class: 'sp-memory-preview' }, selected.value!.text) }),
              h(ElDescriptions, { column: 1, border: true, size: 'small' }, { default: () => [
                h(ElDescriptionsItem, { label: '类型' }, { default: () => selected.value!.kind }),
                h(ElDescriptionsItem, { label: '文件夹' }, { default: () => selected.value!.folderPath || '根目录' }),
                h(ElDescriptionsItem, { label: '重要性' }, { default: () => `${Math.round(selected.value!.weight * 100)}%` }),
                h(ElDescriptionsItem, { label: '创建时间' }, { default: () => dateText(selected.value!.createdAt) }),
                h(ElDescriptionsItem, { label: '来源事件' }, { default: () => selected.value!.sourceEventIds.join(', ') || '无可追溯事件' }),
                selected.value!.invalidatedAt ? h(ElDescriptionsItem, { label: '失效时间' }, { default: () => dateText(selected.value!.invalidatedAt!) }) : null,
              ] }),
              h(ElSpace, { class: 'sp-memory-move', alignment: 'center' }, { default: () => [
                h(resolveComponent('el-select') as unknown as string, { modelValue: moveTarget.value, 'onUpdate:modelValue': (value: string) => { moveTarget.value = value }, placeholder: '移动到文件夹', clearable: true }, {
                  default: () => folders.value.map((folder) => h(resolveComponent('el-option') as unknown as string, { key: folder.path, label: folder.path, value: folder.path })),
                }),
                h(ElButton, { type: 'primary', onClick: () => void moveSelectedMemory() }, { default: () => '移动' }),
              ] }),
            ] : h(ElEmpty, { description: '选择一条记忆查看完整内容与来源' }),
          }),
          h(ElDialog, { modelValue: folderDialogOpen.value, title: '新建记忆文件夹', width: '420px',
            'onUpdate:modelValue': (value: boolean) => { folderDialogOpen.value = value } }, {
            default: () => [
              h(ElText, { type: 'info' }, { default: () => selectedFolderPath.value ? `将在「${selectedFolderPath.value}」下创建子文件夹` : '将在记忆库根目录创建文件夹' }),
              h(ElInput, { modelValue: folderName.value, 'onUpdate:modelValue': (value: string) => { folderName.value = value }, maxlength: 80, showWordLimit: true, placeholder: '文件夹名称' }),
            ],
            footer: () => h(ElSpace, {}, { default: () => [
              h(ElButton, { onClick: () => { folderDialogOpen.value = false } }, { default: () => '取消' }),
              h(ElButton, { type: 'primary', loading: folderBusy.value, disabled: !folderName.value.trim(), onClick: () => void createMemoryFolder() }, { default: () => '创建文件夹' }),
            ] }),
          }),
          notice.value ? h(ElCol, { span: 24 }, h(ElText, { type: 'danger' }, { default: () => notice.value })) : null,
        ],
      })
      return sharedPage('记忆库', '浏览团队共享 Agent 各自沉淀的长期记忆、来源和有效状态。内容按 Agent 隔离保存。', content, 'sp-memory-page')
    }
  },
})

export const AgentWorkspacePage = defineComponent({
  name: 'AgentWorkspacePage',
  setup() {
    const rpc = useRpc<AgentOperationsRpc>()
    const agents = ref([] as AgentRow[])
    const selectedId = ref('')
    const scope = ref<'agent' | 'shared'>('agent')
    const inboxes = ref([] as InboxRow[])
    const inboxDialogOpen = ref(false)
    const inboxSession = ref(null as InboxRow['pending'][number] | null)
    const inboxDetail = ref(null as InboxDetail | null)
    const inboxPage = ref(1)
    const inboxMode = ref<'pending' | 'history'>('pending')
    const inboxLoading = ref(false)
    const inboxError = ref('')
    const runs = ref([] as RunRow[])
    const processing = ref([] as ProcessingRow[])
    const files = ref([] as FileRow[])
    const selectedFile = ref(null as FileRow | null)
    const fileDrawerOpen = ref(false)
    const activeTab = ref('files')
    const currentPath = ref('')
    const treeRootData = computed(() => [{
      name: scope.value === 'shared' ? '公共工作区' : '个人工作区',
      path: '__workspace_root__', kind: 'directory' as const, isLeaf: false,
    }])
    const preview = ref('')
    const previewError = ref('')
    const notice = ref('')
    const loading = ref(false)
    let poller: ReturnType<typeof setInterval> | undefined
    let overviewLoading = false

    const loadFiles = async () => {
      if (scope.value === 'agent' && !selectedId.value) return
      loading.value = true
      try {
        const apiPath = currentPath.value === legacyFilesPath ? '' : currentPath.value
        const result = scope.value === 'shared'
          ? await rpc.value.sharedWorkspaceBrowse(token(), apiPath)
          : selectedId.value ? await rpc.value.agentWorkspaceBrowse(token(), selectedId.value, apiPath) : null
        if (!result) { notice.value = '无法读取工作区，请重新登录后重试'; return }
        if (result.error) { notice.value = result.error; return }
        files.value = result.entries ?? []
        if (scope.value === 'agent') {
          agents.value = agents.value.map((agent) => agent.id === selectedId.value ? { ...agent, workdirAvailable: result.exists } : agent)
        }
        selectedFile.value = null; preview.value = ''; previewError.value = ''; notice.value = ''
      } catch (error) { notice.value = (error as Error).message }
      finally { loading.value = false }
    }
    const loadOverview = async (loadWorkspace = false) => {
      if (overviewLoading) return
      overviewLoading = true
      try {
        const result = await rpc.value.agentWorkspaceOverview(token())
        if (!result) { notice.value = '无法读取工作区状态，请重新登录后重试'; return }
        agents.value = result.agents
        runs.value = result.progress
        inboxes.value = result.inboxes
        processing.value = result.processing ?? []
        if (!selectedId.value && agents.value.length) selectedId.value = agents.value[0]!.id
        if (selectedId.value && !agents.value.some((agent) => agent.id === selectedId.value)) selectedId.value = agents.value[0]?.id ?? ''
        if (loadWorkspace && selectedId.value) await loadFiles()
        if (inboxDialogOpen.value && inboxSession.value) void loadInboxPage(inboxPage.value)
      } catch (error) { notice.value = (error as Error).message }
      finally { overviewLoading = false }
    }
    const loadInboxPage = async (page: number) => {
      if (!inboxSession.value || !selectedId.value || inboxLoading.value) return
      inboxLoading.value = true
      inboxError.value = ''
      try {
        const result = inboxMode.value === 'history'
          ? await rpc.value.agentWorkspaceHistory(token(), selectedId.value, inboxSession.value.sessionId, page, 20)
          : await rpc.value.agentWorkspaceInbox(token(), selectedId.value, inboxSession.value.sessionId, page, 20)
        if (!result) { inboxError.value = '无法读取待处理消息，请重新登录后重试'; return }
        inboxDetail.value = result
        inboxPage.value = result.page
      } catch (error) { inboxError.value = (error as Error).message || '读取待处理消息失败' }
      finally { inboxLoading.value = false }
    }
    const openInbox = (item: InboxSession, mode: 'pending' | 'history') => {
      inboxSession.value = item
      inboxMode.value = mode
      inboxDetail.value = null
      inboxPage.value = 1
      inboxDialogOpen.value = true
      void loadInboxPage(1)
    }
    const selectAgent = (id: string) => { selectedId.value = id; currentPath.value = ''; void loadFiles() }
    const selectScope = (value: 'agent' | 'shared') => {
      scope.value = value; currentPath.value = ''; selectedFile.value = null; fileDrawerOpen.value = false; activeTab.value = 'files'; void loadFiles()
    }
    const openFile = async (row: FileRow) => {
      if (row.path === legacyFilesPath) { currentPath.value = legacyFilesPath; await loadFiles(); return }
      if (row.kind === 'directory') { currentPath.value = row.path; await loadFiles(); return }
      selectedFile.value = row
      preview.value = ''; previewError.value = ''
      try {
        const result = scope.value === 'shared'
          ? await rpc.value.sharedWorkspaceRead(token(), row.path)
          : await rpc.value.agentWorkspaceRead(token(), selectedId.value, row.path)
        preview.value = result?.text ?? ''
        previewError.value = result?.error ?? (!result ? '无法读取文件预览' : '')
      } catch (error) { previewError.value = (error as Error).message }
    }
    const parentPath = () => {
      currentPath.value = currentPath.value === legacyFilesPath ? '' : currentPath.value.split('/').slice(0, -1).join('/')
      void loadFiles()
    }
    onMounted(() => { void loadOverview(true); poller = setInterval(() => void loadOverview(), 5000) })
    onUnmounted(() => { if (poller) clearInterval(poller) })

    return () => {
      const ElRow = resolveComponent('el-row') as unknown as string
      const ElCol = resolveComponent('el-col') as unknown as string
      const ElCard = resolveComponent('el-card') as unknown as string
      const ElMenu = resolveComponent('el-menu') as unknown as string
      const ElMenuItem = resolveComponent('el-menu-item') as unknown as string
      const ElTable = resolveComponent('el-table') as unknown as string
      const ElTableColumn = resolveComponent('el-table-column') as unknown as string
      const ElButton = resolveComponent('el-button') as unknown as string
      const ElTag = resolveComponent('el-tag') as unknown as string
      const ElText = resolveComponent('el-text') as unknown as string
      const ElEmpty = resolveComponent('el-empty') as unknown as string
      const ElTimeline = resolveComponent('el-timeline') as unknown as string
      const ElTimelineItem = resolveComponent('el-timeline-item') as unknown as string
      const ElScrollbar = resolveComponent('el-scrollbar') as unknown as string
      const ElDrawer = resolveComponent('el-drawer') as unknown as string
      const ElTabs = resolveComponent('el-tabs') as unknown as string
      const ElTabPane = resolveComponent('el-tab-pane') as unknown as string
      const ElTree = resolveComponent('el-tree') as unknown as string
      const ElBreadcrumb = resolveComponent('el-breadcrumb') as unknown as string
      const ElBreadcrumbItem = resolveComponent('el-breadcrumb-item') as unknown as string
      const ElRadioGroup = resolveComponent('el-radio-group') as unknown as string
      const ElRadioButton = resolveComponent('el-radio-button') as unknown as string
      const ElAlert = resolveComponent('el-alert') as unknown as string
      const ElSpace = resolveComponent('el-space') as unknown as string
      const ElDialog = resolveComponent('el-dialog') as unknown as string
      const ElPagination = resolveComponent('el-pagination') as unknown as string
      const activeRuns = runs.value.filter((run) => run.agentId === selectedId.value)
      const inbox = inboxes.value.find((item) => item.agentId === selectedId.value)?.pending ?? []
      const activeProcessing = processing.value.filter((item) => item.agentId === selectedId.value)
      const currentInbox = activeProcessing.filter((item) => item.phase !== 'failed')
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]
      const failedInbox = activeProcessing.filter((item) => item.phase === 'failed')
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]
      const file = selectedFile.value
      const agentMenu = h(ElScrollbar, { class: 'sp-workspace-agent-scroll', always: true, height: '100%' }, { default: () => h(ElMenu, { defaultActive: selectedId.value, onSelect: selectAgent }, {
        default: () => agents.value.map((agent) => {
          const run = runs.value.find((item) => item.agentId === agent.id)
          return h(ElMenuItem, { index: agent.id, key: agent.id }, {
            default: () => h('div', { class: 'sp-workspace-agent-row' }, [
              h('span', agent.title),
              h(ElTag, { size: 'small', type: run || agent.status === 'working' ? 'warning' : 'info', effect: 'plain' }, {
                default: () => run ? phaseText[run.phase] ?? run.phase : agent.status === 'working' ? '处理中' : agent.status,
              }),
            ]),
          })
        }),
      }) })
      const pathToolbar = h(ElSpace, { alignment: 'center', wrap: true, class: 'sp-workspace-path' }, { default: () => [
        h(ElButton, { text: true, disabled: !currentPath.value, onClick: parentPath }, { default: () => '上一级' }),
        h(ElBreadcrumb, {}, { default: () => [
          h(ElBreadcrumbItem, {}, { default: () => h(ElButton, { text: true, onClick: () => { currentPath.value = ''; void loadFiles() } }, {
            default: () => scope.value === 'shared' ? '公共工作区' : `个人工作区 · ${agents.value.find((agent) => agent.id === selectedId.value)?.title ?? ''}`,
          }) }),
          ...currentPath.value.split('/').filter(Boolean).map((part, index, parts) => {
            const path = parts.slice(0, index + 1).join('/')
            const label = part === legacyFilesPath ? '旧版根目录文件' : part
            return h(ElBreadcrumbItem, {}, { default: () => h(ElButton, { text: true, onClick: () => { currentPath.value = path; void loadFiles() } }, { default: () => label }) })
          }),
        ] }),
        h(ElButton, { text: true, loading: loading.value, onClick: () => void loadFiles() }, { default: () => '刷新' }),
      ] })
      const visibleFiles = currentPath.value === legacyFilesPath
        ? files.value.filter((entry) => entry.kind === 'file')
        : scope.value === 'agent' && !currentPath.value
          ? [...files.value.filter((entry) => entry.kind === 'directory'), ...(files.value.some((entry) => entry.kind === 'file') ? [{
            name: `旧版根目录文件 (${files.value.filter((entry) => entry.kind === 'file').length})`, path: legacyFilesPath,
            kind: 'directory' as const, size: 0, modifiedAt: '', virtual: true,
          }] : [])]
          : files.value
      const fileTable = visibleFiles.length ? h(ElTable, { data: visibleFiles, rowKey: 'path', height: '100%', highlightCurrentRow: true, tableLayout: 'fixed', onRowClick: (row: FileRow) => {
        void openFile(row)
        if (row.kind === 'file') fileDrawerOpen.value = true
      } }, {
        default: () => [
          h(ElTableColumn, { label: '名称', minWidth: 280, showOverflowTooltip: true }, { default: ({ row }: { row: FileRow }) => `${row.kind === 'directory' ? '▸ ' : ''}${row.name}` }),
          h(ElTableColumn, { label: '修改时间', width: 150 }, { default: ({ row }: { row: FileRow }) => tableDateText(row.modifiedAt) }),
          h(ElTableColumn, { label: '大小', width: 110 }, { default: ({ row }: { row: FileRow }) => row.kind === 'directory' ? '—' : `${Math.max(1, Math.round(row.size / 1024))} KB` }),
        ],
      }) : h(ElEmpty, { description: scope.value === 'shared' ? '公共工作区当前为空' : agents.value.find((agent) => agent.id === selectedId.value)?.workdirAvailable ? '此目录为空' : 'Agent 尚未创建工作区' })
      const activity = activeRuns.length
        ? activeRuns.flatMap((run) => run.steps.map((step) => ({ ...step, runId: run.runId, title: run.title })))
          .sort((a, b) => b.at.localeCompare(a.at)).slice(0, 20)
        : []
      const currentRun = [...activeRuns].sort((a, b) => b.at.localeCompare(a.at))[0]
      const currentStep = currentRun?.steps.at(-1)
      const currentWorkCard = scope.value === 'agent' && (currentRun || (!currentInbox && !failedInbox)) ? h(ElAlert, {
        title: currentRun ? `${currentRun.title} · ${phaseText[currentRun.phase] ?? currentRun.phase}`
          : currentInbox ? `${agents.value.find((agent) => agent.id === selectedId.value)?.title ?? 'Agent'} · ${inboxPhaseText[currentInbox.phase] ?? currentInbox.phase}`
            : failedInbox ? `${agents.value.find((agent) => agent.id === selectedId.value)?.title ?? 'Agent'} · 消息处理失败，等待重试`
            : `${agents.value.find((agent) => agent.id === selectedId.value)?.title ?? 'Agent'} · 当前空闲`,
        type: currentRun || currentInbox ? 'success' : failedInbox ? 'error' : 'info', showIcon: true, closable: false,
        description: currentRun
          ? [currentStep?.detail, currentStep?.inputSummary ? `工具输入摘要：${currentStep.inputSummary}` : '', currentStep?.resultSummary ? `工具输出摘要：${currentStep.resultSummary}` : '', currentStep?.durationMs !== undefined ? `耗时 ${currentStep.durationMs} ms` : ''].filter(Boolean).join(' · ') || currentStep?.label || '正在执行任务'
          : currentInbox ? `${currentInbox.detail} · 会话 ${inboxes.value.find((item) => item.agentId === selectedId.value)?.pending.find((item) => item.sessionId === currentInbox.sessionId)?.sessionTitle ?? currentInbox.sessionId} · 消息序号 #${currentInbox.seq} · 已处理 ${elapsedText(currentInbox.startedAt)}`
            : failedInbox ? `${failedInbox.detail} · 会话 ${inboxes.value.find((item) => item.agentId === selectedId.value)?.pending.find((item) => item.sessionId === failedInbox.sessionId)?.sessionTitle ?? failedInbox.sessionId} · 消息序号 #${failedInbox.seq}`
            : `消息队列 ${inbox.reduce((sum, item) => sum + item.count, 0)} 条待处理 · 已记录 ${inbox.reduce((sum, item) => sum + item.processedCount, 0)} 条历史消化记录`,
      }) : null
      const loadTreeChildren = async (node: { level: number; data?: { path?: string } }, resolve: (rows: Array<Record<string, unknown>>) => void) => {
        const requestedPath = String(node.data?.path ?? '')
        const path = requestedPath === legacyFilesPath || requestedPath === '__workspace_root__' ? '' : requestedPath
        const result = scope.value === 'shared'
          ? await rpc.value.sharedWorkspaceBrowse(token(), path)
          : selectedId.value ? await rpc.value.agentWorkspaceBrowse(token(), selectedId.value, path) : null
        const entries = result?.entries ?? []
        if (requestedPath === legacyFilesPath) {
          resolve(entries.filter((entry) => entry.kind === 'file').map((entry) => ({ ...entry, isLeaf: true })))
          return
        }
        const directories = entries.filter((entry) => entry.kind === 'directory')
        const rootFiles = entries.filter((entry) => entry.kind === 'file')
        resolve([
          ...directories.map((entry) => ({ ...entry, isLeaf: false })),
          ...(scope.value === 'agent' && !path && rootFiles.length ? [{
            name: `旧版根目录文件 (${rootFiles.length})`, path: legacyFilesPath, kind: 'directory', isLeaf: true, virtual: true,
          }] : []),
        ])
      }
      const directoryTree = h(ElScrollbar, { class: 'sp-workspace-tree-scroll', always: true, height: '100%' }, { default: () => h(ElTree, {
        key: `${scope.value}:${selectedId.value}`, data: treeRootData.value,
        nodeKey: 'path', lazy: true, load: loadTreeChildren, defaultExpandedKeys: ['__workspace_root__'],
        currentNodeKey: currentPath.value || '__workspace_root__',
        props: { label: 'name', isLeaf: 'isLeaf' }, highlightCurrent: true,
        onNodeClick: (node: FileRow) => {
          if (node.kind === 'directory') { currentPath.value = node.path === '__workspace_root__' ? '' : node.path; void loadFiles() }
        },
        renderContent: (_render: unknown, context: { data: FileRow }) => h('span', { class: 'sp-explorer-tree-node' }, [
          h('span', { class: 'sp-explorer-tree-name' }, context.data.name),
        ]),
      }) })
      const filePane = h(ElRow, { gutter: 18, class: 'sp-workspace-file-pane' }, { default: () => [
        h(ElCol, { span: 6, class: 'sp-workspace-tree-column' }, h(ElCard, { shadow: 'never', class: 'sp-workspace-folder-card' }, {
          header: () => h('strong', '文件夹'),
          default: () => directoryTree,
        })),
        h(ElCol, { span: 18, class: 'sp-workspace-file-column' }, [pathToolbar, fileTable,
          scope.value === 'agent' && !currentPath.value ? h(ElAlert, {
            title: '工作区目录规范', type: 'info', showIcon: true, closable: false,
            description: '任务记录按轮次归入 tasks/；项目按 projects/<名称>/src、tests、docs 组织；脚本放 scripts/，笔记放 notes/。公共工作区对 Agent 只读。',
          }) : null,
          notice.value ? h(ElText, { type: 'danger' }, { default: () => notice.value }) : null,
        ]),
      ] })
      const workspaceCard = h(ElCard, { shadow: 'never', loading: loading.value }, {
        header: () => h('strong', scope.value === 'shared' ? '团队公共工作区 · Agent 只读' : '个人工作区'),
        default: () => [currentWorkCard, h(ElTabs, { class: 'sp-workspace-tabs', modelValue: activeTab.value, 'onUpdate:modelValue': (value: string) => { activeTab.value = value } }, { default: () => [
          h(ElTabPane, { label: '文件', name: 'files' }, { default: () => filePane }),
          scope.value === 'agent' ? h(ElTabPane, { label: '运行记录', name: 'runs' }, { default: () => activity.length ? h(ElTimeline, {}, { default: () => activity.map((step) => h(ElTimelineItem, {
            timestamp: dateText(step.at), placement: 'top', type: 'primary',
          }, { default: () => [h('strong', step.title), h('div', step.label), step.detail ? h('div', step.detail) : null,
            step.inputSummary ? h('div', `工具输入摘要：${step.inputSummary}`) : null,
            step.resultSummary ? h('div', `工具结果：${step.resultSummary}`) : null,
            step.durationMs !== undefined ? h('div', `耗时 ${step.durationMs} ms`) : null] })) })
            : h(ElEmpty, { description: 'Agent 当前没有运行记录' }) }) : null,
          scope.value === 'agent' ? h(ElTabPane, { label: `消息队列 (${inbox.reduce((sum, item) => sum + item.count, 0)})`, name: 'queue' }, { default: () => inbox.length ? h('div', { class: 'sp-workspace-queue-sessions' }, inbox.map((item) => {
            const sessionProcessing = activeProcessing.find((processingItem) => processingItem.sessionId === item.sessionId)
            const isProcessing = Boolean(sessionProcessing && sessionProcessing.phase !== 'failed')
            const isFailed = sessionProcessing?.phase === 'failed'
            return h('article', { class: ['sp-workspace-queue-session', isProcessing && 'is-processing', isFailed && 'is-failed'], key: item.sessionId }, [
            h('div', { class: 'sp-workspace-queue-session-head' }, [
              h('strong', item.sessionTitle),
              h(ElTag, { size: 'small', type: isFailed ? 'danger' : isProcessing ? 'success' : item.active ? 'success' : 'warning', effect: 'plain' }, {
                default: () => isFailed ? `${item.count} 条 · 处理失败，等待重试` : isProcessing ? `${item.count} 条 · 正在处理` : item.active ? `${item.count} 条 · 即将处理` : `${item.count} 条 · 等待处理`,
              }),
            ]),
            sessionProcessing ? h('div', { class: ['sp-workspace-queue-live', isFailed && 'is-failed'] }, [
              h('strong', isFailed ? '最近处理未完成' : `${inboxPhaseText[sessionProcessing.phase] ?? sessionProcessing.phase} · 消息 #${sessionProcessing.seq}`),
              h('span', isFailed ? sessionProcessing.detail : `${sessionProcessing.detail} · 已处理 ${elapsedText(sessionProcessing.startedAt)} · 最近更新 ${tableDateText(sessionProcessing.updatedAt)}`),
            ]) : h(ElText, { type: 'info' }, { default: () => item.active
              ? 'Agent 已取得该会话，正在准备处理队列消息。'
              : '显示该 Agent 尚未消化的会话消息；普通消息也会进入后台记忆处理。' }),
            h(ElButton, { type: 'primary', plain: true, disabled: !item.count, onClick: () => openInbox(item, 'pending') }, { default: () => '查看待处理消息' }),
          ])
          })) : h(ElEmpty, { description: '没有待处理消息' }) }) : null,
          scope.value === 'agent' ? h(ElTabPane, { label: `处理历史 (${inbox.reduce((sum, item) => sum + item.processedCount, 0)})`, name: 'history' }, { default: () => inbox.some((item) => item.processedCount) ? h('div', { class: 'sp-workspace-queue-sessions' }, inbox.filter((item) => item.processedCount).map((item) => h('article', { class: 'sp-workspace-queue-session', key: item.sessionId }, [
            h('div', { class: 'sp-workspace-queue-session-head' }, [h('strong', item.sessionTitle), h(ElTag, { size: 'small', type: 'success', effect: 'plain' }, { default: () => `${item.processedCount} 条已处理` })]),
            h(ElText, { type: 'info' }, { default: () => `处理游标 #${item.cursor} / 最新消息 #${item.latestSeq}` }),
            h(ElButton, { plain: true, onClick: () => openInbox(item, 'history') }, { default: () => '查看历史处理记录' }),
          ]))) : h(ElEmpty, { description: '还没有已处理的消息记录' }) }) : null,
        ] })],
      })
      const fileDrawer = h(ElDrawer, { modelValue: fileDrawerOpen.value, title: file?.name ?? '文件预览', size: 'min(720px, 60vw)', direction: 'rtl',
        'onUpdate:modelValue': (value: boolean) => { fileDrawerOpen.value = value } }, {
        default: () => file ? [
          h(ElText, { type: 'info' }, { default: () => `${file.path} · ${dateText(file.modifiedAt)}` }),
          previewError.value ? h(ElEmpty, { description: previewError.value }) : h(ElScrollbar, { maxHeight: '75vh' }, { default: () => h('pre', { class: 'sp-workspace-preview' }, preview.value) }),
        ] : h(ElEmpty, { description: '选择文件查看受限文本预览' }),
      })
      const inboxDialog = h(ElDialog, {
        modelValue: inboxDialogOpen.value,
        'onUpdate:modelValue': (value: boolean) => { inboxDialogOpen.value = value },
        title: inboxSession.value ? `${inboxMode.value === 'history' ? '历史处理记录' : '待处理消息'} · ${inboxSession.value.sessionTitle}` : '消息记录',
        width: 'min(680px, 72vw)', appendToBody: true,
        class: inboxMode.value === 'history' ? 'sp-workspace-history-dialog' : 'sp-workspace-queue-dialog',
      }, {
        default: () => [
          inboxError.value ? h(ElAlert, { type: 'error', title: inboxError.value, closable: false }) : null,
          inboxLoading.value && !inboxDetail.value ? h(ElEmpty, { description: '正在读取队列消息…' }) : null,
          inboxDetail.value ? h('div', { class: 'sp-workspace-queue-detail' }, [
            h('div', { class: 'sp-workspace-queue-summary' }, [
              h(ElTag, { type: inboxMode.value === 'history' ? 'success' : inboxDetail.value.active ? 'success' : 'warning', effect: 'plain' }, {
                default: () => inboxMode.value === 'history' ? '已消化历史' : inboxDetail.value!.active ? 'Agent 正在处理该会话' : 'Agent 等待处理该会话',
              }),
              h(ElText, { type: 'info' }, { default: () => `${inboxDetail.value!.total} 条${inboxMode.value === 'history' ? '历史记录' : '待消化消息'} · 已处理到序号 ${inboxDetail.value!.cursor} · 当前最新序号 ${inboxDetail.value!.latestSeq}` }),
              h(ElButton, { text: true, onClick: () => window.location.assign(`/teamspace?session=${encodeURIComponent(inboxDetail.value!.sessionId)}`) }, {
                default: () => '打开原会话',
              }),
            ]),
            inboxDetail.value.items.length ? h('div', { class: 'sp-workspace-queue-events sp-workspace-queue-events-scroll' }, inboxDetail.value.items.map((event) => h('article', { class: 'sp-workspace-queue-event', key: event.id }, [
              h('div', { class: 'sp-workspace-queue-event-head' }, [
                h('strong', event.author),
                h(ElTag, { size: 'small', effect: 'plain' }, { default: () => event.kind === 'decision' ? '决策复核' : event.authorKind === 'agent' ? 'Agent 消息' : '团队消息' }),
                h('span', `#${event.seq} · ${tableDateText(event.at)}`),
              ]),
              h('p', { class: 'sp-workspace-queue-event-text' }, event.text),
            ]))) : h(ElEmpty, { description: inboxMode.value === 'history' ? '还没有已完成的历史处理记录' : '该 Agent 已追上最新消息，队列刚刚处理完成。' }),
            inboxDetail.value.total > inboxDetail.value.pageSize ? h(ElPagination, {
              currentPage: inboxDetail.value.page, pageSize: inboxDetail.value.pageSize,
              total: inboxDetail.value.total, layout: 'prev, pager, next, total',
              onCurrentChange: (page: number) => { inboxPage.value = page; void loadInboxPage(page) },
            }) : null,
          ]) : null,
        ],
        footer: () => h(ElButton, { onClick: () => { inboxDialogOpen.value = false } }, { default: () => '关闭' }),
      })
      const scopeToggle = h(ElRadioGroup, { modelValue: scope.value, onChange: selectScope, size: 'large' }, { default: () => [
        h(ElRadioButton, { label: 'agent' }, { default: () => 'Agent 工作区' }),
        h(ElRadioButton, { label: 'shared' }, { default: () => '公共工作区' }),
      ] })
      const content = h('div', {}, [
        scopeToggle,
        h(ElRow, { gutter: 18, class: 'sp-agent-explorer' }, { default: () => [
          scope.value === 'agent' ? h(ElCol, { span: 5, class: 'sp-workspace-agent-column' }, h(ElCard, { class: 'sp-workspace-agent-card', shadow: 'never' }, {
            header: () => h('strong', '团队 Agent'), default: () => agentMenu,
          })) : null,
          h(ElCol, { span: scope.value === 'agent' ? 19 : 24, class: 'sp-workspace-content-column' }, [workspaceCard, fileDrawer, inboxDialog]),
        ] }),
      ])
      return sharedPage('Agent 工作区', '实时查看共享 Agent 的工作阶段、待处理消息、工具执行与个人工作区文件。只显示可审计执行记录，不展示隐藏思维链。', content, 'sp-workspace-page')
    }
  },
})

export const MEMORY_PAGE_ICON = ICONS.kb
export const WORKSPACE_PAGE_ICON = ICONS.agents
