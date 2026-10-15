import { computed, defineComponent, h, onMounted, onUnmounted, ref, resolveComponent } from 'vue'
import type { VNodeChild } from 'vue'
import { useRoute, useRpc } from '@cordisjs/client'
import { ThemeStyle } from 'space-client-ui-shared/client/theme.ts'
import { ICONS } from 'space-client-ui-shared/client/console.ts'
import { renderMarkdown } from 'space-client-ui-shared/client/md.ts'
import { DEFAULT_AGENT_ICON, SvgIcon } from 'space-client-ui-shared/client/icon-library.ts'
import 'space-client-ui-shared/client/im.css'

type AgentRow = { id: string; title: string; status: string; iconId?: string; workdirAvailable: boolean }
type MemoryRow = { id: string; scope: string; kind: string; folderPath: string; text: string; weight: number; authorId: string | null; sourceEventIds: string[]; invalidatedAt: string | null; createdAt: string }
type MemoryFolderRow = { path: string; name: string; parentPath: string; itemCount: number }
type MemoryFolderNode = { path: string; name: string; itemCount: number; children: MemoryFolderNode[] }
type MemoryResult = { total: number; items: MemoryRow[] }
type FileRow = { name: string; path: string; kind: 'directory' | 'file'; size: number; modifiedAt: string; isLeaf?: boolean; virtual?: boolean }
type WorklogRow = { label: string; at: string; kind?: 'phase' | 'tool'; status?: 'running' | 'success' | 'failed'; detail?: string; toolId?: string; inputSummary?: string; resultSummary?: string; durationMs?: number }
type RunRow = { runId: string; sessionId: string; agentId: string; title: string; phase: string; toolTitle?: string; ok?: boolean; at: string; steps: WorklogRow[] }
type InboxExecution = {
  id: string; at: string; author: string; text: string; failed: boolean; worklog: WorklogRow[];
  modelTrace: Array<{
    index: number; model: string | null; profileRef?: string | null; startedAt: string; completedAt?: string; status: 'completed' | 'failed';
    request: Array<{ role: 'system' | 'user' | 'assistant'; source: string; content: string; sections?: Array<{ label: string; source: string; content: string }> }>;
    response?: string; responseTruncated?: boolean; toolCalls: Array<{
      toolId: string; args: string; status?: 'success' | 'failed'; result?: string; error?: string; durationMs?: number
    }>; error?: string
  }>;
  sourceEventIds: string[]; sourceEvents: Array<{ id: string; seq: number | null; at: string; author: string; text: string }>;
  citations: Array<{ source: string; id: string; title: string }>
}
type InboxTrace = {
  agentId: string; agentTitle: string; status: 'success' | 'failed'; startedAt: string; completedAt: string;
  steps: Array<{ label: string; detail: string; at: string; status: 'success' | 'failed' }>
  modelTrace: InboxExecution['modelTrace']
}
type InboxLiveExecution = { runId: string; title: string; phase: string; at: string; step?: WorklogRow; steps: WorklogRow[]; currentText: string }
type InboxMessage = { id: string; seq: number; at: string; kind: string; author: string; authorKind: string; text: string; mentions?: string[]; inboxTrace?: InboxTrace | null; executions?: InboxExecution[]; liveExecutions?: InboxLiveExecution[] }
type InboxDetail = { sessionId: string; sessionTitle: string; total: number; scannedTotal?: number; page: number; pageSize: number; cursor: number; latestSeq: number; active: boolean; items: InboxMessage[] }
type InboxSession = { sessionId: string; sessionTitle: string; count: number; processedCount: number; cursor: number; latestSeq: number; active: boolean }
type RecentMessage = { eventId: string; seq: number; sessionId: string; sessionTitle: string; text: string; at: string; status: string; result: string; historyPage: number }
type InboxRow = { agentId: string; pending: InboxSession[]; recent?: RecentMessage[] }
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
  transferWorkspaceFile(token: string, sourceAgentId: string, path: string, targetAgentId?: string): Promise<{ ok: true } | { error: string } | null>
  apiConfig(token: string): Promise<{ publicBaseUrl: string | null; port: number } | null>
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
  'advancing-cursor': '保存处理进度', failed: '处理失败，等待重试',
}

function sharedPage(title: string, subtitle: string, content: VNodeChild, pageClass = '') {
  const KLayout = resolveComponent('k-layout') as unknown as string
  const ElText = resolveComponent('el-text') as unknown as string
  const ElMain = resolveComponent('el-main') as unknown as string
  return h(KLayout, { main: 'page-teamspace-agent-operations', class: 'sp-team-layout sp-compact-header-layout' }, {
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
    const showArchivedAgents = ref(false)
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
    const toggleArchivedAgents = () => {
      showArchivedAgents.value = !showArchivedAgents.value
      if (!showArchivedAgents.value && agents.value.find((agent) => agent.id === selectedId.value)?.status === 'archived') {
        const activeAgent = agents.value.find((agent) => agent.status !== 'archived')
        if (activeAgent) void selectMemoryAgent(activeAgent.id)
        else {
          selectedId.value = ''; memories.value = { total: 0, items: [] }; folders.value = []; selected.value = null
        }
      }
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
      agents.value = result.map((agent: any) => ({ id: agent.id, title: agent.title, status: agent.status, iconId: agent.iconId, workdirAvailable: false }))
      if (!selectedId.value) selectedId.value = agents.value.find((agent) => agent.status !== 'archived')?.id ?? ''
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
      const activeAgents = agents.value.filter((agent) => agent.status !== 'archived')
      const archivedAgents = agents.value.filter((agent) => agent.status === 'archived')
      const renderAgentMenu = (items: AgentRow[]) => h(ElMenu, { defaultActive: selectedId.value, onSelect: (id: string) => { void selectMemoryAgent(id) } }, { default: () => items.map((agent) => h(ElMenuItem, { index: agent.id, key: agent.id }, {
        default: () => h('span', { class: 'sp-agent-menu-item' }, [h(SvgIcon, { name: agent.iconId ?? DEFAULT_AGENT_ICON }), h('span', agent.title)]),
      })) })
      const menu = h('div', { class: 'sp-agent-list-groups' }, [
        renderAgentMenu(activeAgents),
        archivedAgents.length ? h(ElButton, { text: true, class: 'sp-agent-archive-toggle', onClick: toggleArchivedAgents }, {
          default: () => `${showArchivedAgents.value ? '收起' : '展开'}已归档（${archivedAgents.length}）`,
        }) : null,
        showArchivedAgents.value && archivedAgents.length ? renderAgentMenu(archivedAgents) : null,
      ])
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
          h('span', { class: 'sp-explorer-tree-name' }, [h(SvgIcon, { name: context.data.path ? 'Folder' : 'FolderOpened' }), h('span', context.data.name)]),
          context.data.path ? h(ElText, { type: 'info', size: 'small' }, { default: () => String(context.data.itemCount) }) : null,
        ]),
      })
      const table = memories.value.items.length ? h(ElTable, {
        data: memories.value.items, rowKey: 'id', highlightCurrentRow: true, loading: loading.value, tableLayout: 'fixed',
        maxHeight: 'calc(100vh - 430px)',
        onRowClick: (row: MemoryRow) => { selected.value = row; moveTarget.value = row.folderPath; detailOpen.value = true },
      }, {
        default: () => [
          h(ElTableColumn, { prop: 'kind', label: '类型', width: 150, showOverflowTooltip: true }),
          h(ElTableColumn, { label: '记忆内容', minWidth: 200, showOverflowTooltip: true }, {
            default: ({ row }: { row: MemoryRow }) => row.text,
          }),
          h(ElTableColumn, { label: '重要性', width: 90 }, { default: ({ row }: { row: MemoryRow }) => `${Math.round(row.weight * 100)}%` }),
          h(ElTableColumn, { label: '创建时间', width: 130 }, { default: ({ row }: { row: MemoryRow }) => tableDateText(row.createdAt) }),
          includeInvalidated.value ? h(ElTableColumn, { label: '状态', width: 90 }, {
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
              h(ElScrollbar, { maxHeight: 'calc(100vh - 150px)' }, { default: () => [
                h(ElInput, { type: 'textarea', modelValue: selected.value!.text, readonly: true, autosize: true, 'aria-label': '记忆内容' }),
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
    const route = useRoute()
    const agents = ref([] as AgentRow[])
    const selectedId = ref('')
    const showArchivedAgents = ref(false)
    const scope = ref<'agent' | 'shared'>('agent')
    const inboxes = ref([] as InboxRow[])
    const inboxDialogOpen = ref(false)
    const inboxSession = ref(null as InboxRow['pending'][number] | null)
    const inboxDetail = ref(null as InboxDetail | null)
    const inboxPage = ref(1)
    const inboxMode = ref<'pending' | 'history'>('pending')
    const inboxLoading = ref(false)
    const inboxError = ref('')
    const inboxFocusId = ref('')
    const runs = ref([] as RunRow[])
    const processing = ref([] as ProcessingRow[])
    const files = ref([] as FileRow[])
    const selectedFile = ref(null as FileRow | null)
    const fileDrawerOpen = ref(false)
    const transferDialogOpen = ref(false)
    const transferTarget = ref('__shared__')
    const transferBusy = ref(false)
    const transferNotice = ref('')
    const transferError = ref(false)
    const fileActionNotice = ref('')
    const fileActionError = ref(false)
    const fileActionBusy = ref(false)
    const activeTab = ref('overview')
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
    let initialAgentQueryApplied = false
    let apiBase = ''

    const resolveApiBase = async () => {
      if (apiBase) return apiBase
      const config = await rpc.value.apiConfig(token())
      if (!config) throw new Error('无法读取 API 地址，请重新登录后重试')
      apiBase = config.publicBaseUrl || `${window.location.protocol}//${window.location.hostname}:${config.port}`
      return apiBase
    }

    const uploadFiles = async (picked: FileList | null) => {
      if (!picked?.length || fileActionBusy.value) return
      fileActionBusy.value = true
      fileActionNotice.value = ''
      let uploaded = 0
      const failures: string[] = []
      try {
        const base = await resolveApiBase()
        for (const file of Array.from(picked)) {
          const path = [currentPath.value === legacyFilesPath ? '' : currentPath.value, file.name].filter(Boolean).join('/')
          const query = new URLSearchParams({ scope: scope.value, path })
          if (scope.value === 'agent') query.set('agentId', selectedId.value)
          const response = await fetch(`${base}/api/workspace-files/upload?${query}`, {
            method: 'POST', headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/octet-stream' }, body: file,
          })
          if (response.ok) uploaded++
          else {
            const result = await response.json().catch(() => ({})) as { error?: string }
            failures.push(`${file.name}：${result.error ?? `HTTP ${response.status}`}`)
          }
        }
        fileActionError.value = failures.length > 0
        fileActionNotice.value = failures.length
          ? `上传 ${uploaded} 个，失败 ${failures.length} 个：${failures.slice(0, 3).join('；')}`
          : `已上传 ${uploaded} 个文件`
        if (uploaded) await loadFiles()
      } catch (error) {
        fileActionError.value = true
        fileActionNotice.value = (error as Error).message || '上传文件失败'
      } finally { fileActionBusy.value = false }
    }

    const downloadSelectedFile = async () => {
      const selected = selectedFile.value
      if (!selected || fileActionBusy.value) return
      fileActionBusy.value = true
      fileActionNotice.value = ''
      try {
        const base = await resolveApiBase()
        const query = new URLSearchParams({ scope: scope.value, path: selected.path })
        if (scope.value === 'agent') query.set('agentId', selectedId.value)
        const response = await fetch(`${base}/api/workspace-files/download?${query}`, { headers: { Authorization: `Bearer ${token()}` } })
        if (!response.ok) {
          const result = await response.json().catch(() => ({})) as { error?: string }
          throw new Error(result.error ?? `下载失败（HTTP ${response.status}）`)
        }
        const objectUrl = URL.createObjectURL(await response.blob())
        const anchor = document.createElement('a')
        anchor.href = objectUrl
        anchor.download = selected.name
        anchor.click()
        window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000)
        fileActionError.value = false
        fileActionNotice.value = `已开始下载「${selected.name}」`
      } catch (error) {
        fileActionError.value = true
        fileActionNotice.value = (error as Error).message || '下载文件失败'
      } finally { fileActionBusy.value = false }
    }

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
        const requestedAgent = typeof route.query.agent === 'string' ? route.query.agent : ''
        if (!initialAgentQueryApplied && requestedAgent && agents.value.some((agent) => agent.id === requestedAgent)) {
          selectedId.value = requestedAgent
          showArchivedAgents.value = agents.value.find((agent) => agent.id === requestedAgent)?.status === 'archived'
          initialAgentQueryApplied = true
        }
        const firstActiveAgent = agents.value.find((agent) => agent.status !== 'archived')
        if (!selectedId.value && firstActiveAgent) selectedId.value = firstActiveAgent.id
        if (selectedId.value && !agents.value.some((agent) => agent.id === selectedId.value)) selectedId.value = firstActiveAgent?.id ?? ''
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
    const openInbox = (item: InboxSession, mode: 'pending' | 'history', page = 1, focusId = '') => {
      inboxSession.value = item
      inboxFocusId.value = focusId
      inboxMode.value = mode
      inboxDetail.value = null
      inboxPage.value = page
      inboxDialogOpen.value = true
      void loadInboxPage(page)
    }
    const selectAgent = (id: string) => { selectedId.value = id; currentPath.value = ''; void loadFiles() }
    const toggleArchivedAgents = () => {
      showArchivedAgents.value = !showArchivedAgents.value
      if (!showArchivedAgents.value && agents.value.find((agent) => agent.id === selectedId.value)?.status === 'archived') {
        const activeAgent = agents.value.find((agent) => agent.status !== 'archived')
        selectedId.value = activeAgent?.id ?? ''
        currentPath.value = ''
        files.value = []; selectedFile.value = null; preview.value = ''; previewError.value = ''
        if (activeAgent) void loadFiles()
      }
    }
    const selectScope = (value: 'agent' | 'shared') => {
      scope.value = value; currentPath.value = ''; selectedFile.value = null; fileDrawerOpen.value = false; activeTab.value = value === 'agent' ? 'overview' : 'files'; void loadFiles()
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
    const transferSelectedFile = async () => {
      if (!selectedFile.value || (scope.value === 'agent' && !selectedId.value) || transferBusy.value) return
      transferBusy.value = true
      transferNotice.value = ''
      try {
        const targetAgentId = transferTarget.value === '__shared__' ? undefined : transferTarget.value
        const sourceAgentId = scope.value === 'agent' ? selectedId.value : ''
        const result = await rpc.value.transferWorkspaceFile(token(), sourceAgentId, selectedFile.value.path, targetAgentId)
        if (!result) { transferError.value = true; transferNotice.value = '无法转发文件，请重新登录后重试'; return }
        if ('error' in result) { transferError.value = true; transferNotice.value = result.error; return }
        transferError.value = false
        transferNotice.value = `已将「${selectedFile.value.name}」复制到${targetAgentId ? ` ${agents.value.find((agent) => agent.id === targetAgentId)?.title ?? '目标 Agent'} 工作区` : '公共工作区'}；源文件未更改`
        transferDialogOpen.value = false
        if (targetAgentId) void loadFiles()
      } catch (error) { notice.value = (error as Error).message }
      finally { transferBusy.value = false }
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
      const ElCollapse = resolveComponent('el-collapse') as unknown as string
      const ElCollapseItem = resolveComponent('el-collapse-item') as unknown as string
      const ElSelect = resolveComponent('el-select') as unknown as string
      const ElOption = resolveComponent('el-option') as unknown as string
      const Markdown = resolveComponent('k-markdown') as unknown as string
      const renderRichText = (text: string) => renderMarkdown(text, h, { Markdown, Button: ElButton })
      const auditDisplayText = (raw: string) => {
        const value = raw.trim()
        try {
          const parsed: unknown = JSON.parse(value)
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && 'toolCalls' in parsed && Array.isArray(parsed.toolCalls)) {
            const calls = parsed.toolCalls as Array<{ toolId?: unknown; args?: unknown }>
            return calls.map((call, index) => {
              const args = call.args && typeof call.args === 'object' && !Array.isArray(call.args)
                ? Object.entries(call.args as Record<string, unknown>) : [['参数', call.args] as [string, unknown]]
              return `### 工具调用 ${index + 1} · ${typeof call.toolId === 'string' ? call.toolId : '未知工具'}\n` + args.map(([key, item]) => {
                const language = key === 'code' ? 'javascript' : key === 'content' || key === 'text' ? '' : 'json'
                const body = typeof item === 'string' ? item : JSON.stringify(item, null, 2)
                return `**${key}**\n\`\`\`${language}\n${body}\n\`\`\``
              }).join('\n\n')
            }).join('\n\n')
          }
          if (parsed && typeof parsed === 'object') return `\`\`\`json\n${JSON.stringify(parsed, null, 2)}\n\`\`\``
          if (typeof parsed === 'string') return parsed
        } catch { /* Plain text or partial stream: retain it as text. */ }
        return raw.replace(/\\r\\n/g, '\n').replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\"/g, '"')
      }
      const renderAuditContent = (raw: string, id: string) => {
        const text = auditDisplayText(raw)
        if (text.length <= 1200) return renderRichText(text)
        return h('div', { class: 'sp-workspace-long-audit' }, [
          h(ElText, { type: 'info', size: 'small' }, { default: () => `长内容 · ${text.length.toLocaleString('zh-CN')} 字符` }),
          h(ElCollapse, {}, { default: () => [h(ElCollapseItem, {
            name: `full-${id}`, title: '展开完整内容',
          }, { default: () => h('div', { class: 'sp-workspace-audit-content' }, renderRichText(text)) })] }),
        ])
      }
      const activeRuns = runs.value.filter((run) => run.agentId === selectedId.value)
      const inbox = inboxes.value.find((item) => item.agentId === selectedId.value)?.pending ?? []
      const activeProcessing = processing.value.filter((item) => item.agentId === selectedId.value)
      const currentInbox = activeProcessing.filter((item) => item.phase !== 'failed')
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]
      const failedInbox = activeProcessing.filter((item) => item.phase === 'failed')
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]
      const file = selectedFile.value
      const activeAgents = agents.value.filter((agent) => agent.status !== 'archived')
      const archivedAgents = agents.value.filter((agent) => agent.status === 'archived')
      const renderAgentMenu = (items: AgentRow[]) => h(ElMenu, { defaultActive: selectedId.value, onSelect: selectAgent }, {
        default: () => items.map((agent) => {
          const run = runs.value.find((item) => item.agentId === agent.id)
          return h(ElMenuItem, { index: agent.id, key: agent.id }, {
            default: () => h('div', { class: 'sp-workspace-agent-row' }, [
              h('span', { class: 'sp-workspace-agent-title' }, [h(SvgIcon, { name: agent.iconId ?? DEFAULT_AGENT_ICON }), h('span', agent.title)]),
              h(ElTag, { size: 'small', type: agent.status === 'archived' ? 'info' : run || agent.status === 'working' ? 'warning' : 'info', effect: 'plain' }, {
                default: () => agent.status === 'archived' ? '已归档' : run ? phaseText[run.phase] ?? run.phase : agent.status === 'working' ? '处理中' : agent.status,
              }),
            ]),
          })
        }),
      })
      const agentMenu = h(ElScrollbar, { class: 'sp-workspace-agent-scroll', always: true, height: '100%' }, { default: () => h('div', { class: 'sp-agent-list-groups' }, [
        renderAgentMenu(activeAgents),
        archivedAgents.length ? h(ElButton, { text: true, class: 'sp-agent-archive-toggle', onClick: toggleArchivedAgents }, {
          default: () => `${showArchivedAgents.value ? '收起' : '展开'}已归档（${archivedAgents.length}）`,
        }) : null,
        showArchivedAgents.value && archivedAgents.length ? renderAgentMenu(archivedAgents) : null,
      ]) })
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
        h(ElButton, { type: 'primary', plain: true, loading: fileActionBusy.value, disabled: currentPath.value === legacyFilesPath, onClick: () => {
          const input = document.createElement('input')
          input.type = 'file'
          input.multiple = true
          input.onchange = () => { void uploadFiles(input.files); input.value = '' }
          input.click()
        } }, { default: () => '上传文件' }),
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
          h(ElTableColumn, { label: '名称', minWidth: 280, showOverflowTooltip: true }, { default: ({ row }: { row: FileRow }) => h('span', { class: 'sp-workspace-file-name' }, [
            h(SvgIcon, { name: row.kind === 'directory' ? 'Folder' : 'Document' }), h('span', row.name),
          ]) }),
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
          h('span', { class: 'sp-explorer-tree-name' }, [h(SvgIcon, { name: context.data.kind === 'directory' ? 'Folder' : 'Document' }), h('span', context.data.name)]),
        ]),
      }) })
      const renderModelInteraction = (parentId: string, call: InboxExecution['modelTrace'][number]) => h(ElCollapseItem, {
        key: `${parentId}-model-${call.index}`, name: `model-${parentId}-${call.index}`,
        title: `第 ${call.index} 次模型请求 · ${call.model ?? '模型未报告'}${call.profileRef ? ` · 配置 ${call.profileRef}` : ''} · ${call.status === 'completed' ? '已返回' : '失败'} · ${tableDateText(call.startedAt)}`,
      }, { default: () => [
        h('div', { class: 'sp-workspace-audit-label' }, '模型实际收到的内容 · 按发送顺序'),
        ...call.request.map((message, messageIndex) => h('article', { class: ['sp-workspace-source-event', `is-${message.role}`], key: `${call.index}-${messageIndex}` }, [
          h('div', { class: 'sp-workspace-audit-head' }, [h('strong', message.role.toUpperCase()), h(ElTag, { size: 'small', effect: 'plain' }, { default: () => message.source })]),
          message.sections?.length ? h(ElCollapse, {}, { default: () => message.sections!.map((section, sectionIndex) => h(ElCollapseItem, {
            key: `${call.index}-${messageIndex}-section-${sectionIndex}`,
            name: `section-${parentId}-${call.index}-${messageIndex}-${sectionIndex}`,
            title: `${section.label} · ${section.source}`,
          }, { default: () => h('div', { class: 'sp-workspace-audit-content' }, renderAuditContent(section.content, `${parentId}-${call.index}-${messageIndex}-${sectionIndex}`)) })) })
            : h('div', { class: 'sp-workspace-audit-content' }, renderAuditContent(message.content, `${parentId}-${call.index}-${messageIndex}`)),
        ])),
        h('div', { class: 'sp-workspace-audit-label' }, '模型原始响应'),
        call.response ? h('div', { class: 'sp-workspace-audit-content is-response' }, renderAuditContent(call.response, `${parentId}-${call.index}-response`)) : h(ElText, { type: 'warning' }, { default: () => call.error ?? '该请求没有收到模型响应。' }),
        call.responseTruncated ? h(ElText, { type: 'warning' }, { default: () => '响应超过审计记录上限，已截断；记录明确标记为不完整。' }) : null,
        call.toolCalls.length ? h('section', {}, [
          h('strong', '解析出的工具调用与执行结果'),
          ...call.toolCalls.map((tool, toolIndex) => h('article', { class: 'sp-workspace-source-event', key: `${call.index}-tool-${toolIndex}` }, [
            h('strong', `${tool.toolId} · ${tool.status === 'success' ? '成功' : tool.status === 'failed' ? '失败' : '未执行'}`),
            h('div', { class: 'sp-workspace-audit-label' }, '参数'),
            h('div', { class: 'sp-workspace-audit-content' }, renderAuditContent(tool.args, `${parentId}-${call.index}-tool-${toolIndex}-args`)),
            tool.result ? h('div', {}, [h('div', { class: 'sp-workspace-audit-label' }, '结果'), h('div', { class: 'sp-workspace-audit-content' }, renderAuditContent(tool.result, `${parentId}-${call.index}-tool-${toolIndex}-result`))]) : null,
            tool.error ? h('div', { class: 'sp-workspace-audit-content is-error' }, tool.error) : null,
            tool.durationMs !== undefined ? h(ElText, { type: 'info' }, { default: () => `耗时 ${tool.durationMs} ms` }) : null,
          ])),
        ]) : null,
      ] })

      const renderExecution = (execution: InboxExecution, sourceEventId: string) => {
        const isOwnMessage = execution.id === sourceEventId
        return h(ElCollapseItem, {
        name: execution.id, key: execution.id,
        title: `${isOwnMessage ? '本条 Agent 消息的处理记录' : `Agent 答复 · ${execution.author}`} · ${execution.failed ? '失败' : '完成'} · ${execution.worklog.length} 步 · ${tableDateText(execution.at)}`,
      }, { default: () => [
        isOwnMessage ? h('div', { class: 'sp-workspace-audit-label' }, '上方消息就是本次 Agent 发言；此处只列处理记录') : null,
        !isOwnMessage ? h('div', { class: 'sp-workspace-audit-label' }, '执行步骤') : null,
        execution.worklog.length ? h(ElTimeline, {}, { default: () => execution.worklog.map((step, index) => h(ElTimelineItem, {
          key: `${execution.id}-${index}`, timestamp: tableDateText(step.at), type: step.status === 'failed' ? 'danger' : 'primary',
        }, { default: () => [h('strong', step.label), step.detail ? h('div', step.detail) : null,
          step.inputSummary ? h('div', `工具输入摘要：${step.inputSummary}`) : null,
          step.resultSummary ? h('div', `工具结果：${step.resultSummary}`) : null,
          step.durationMs !== undefined ? h('div', `耗时 ${step.durationMs} ms`) : null] })) })
          : h(ElText, { type: 'info' }, { default: () => '此答复没有保存阶段或工具记录。' }),
        execution.modelTrace.length ? h(ElCollapse, { class: 'sp-workspace-model-trace' }, { default: () => execution.modelTrace.map((call) => renderModelInteraction(execution.id, call)) })
          : h(ElText, { type: 'info' }, { default: () => '没有模型请求记录' }),
        execution.citations.length || execution.sourceEventIds.length ? h('div', { class: 'sp-workspace-execution-sources' }, [
          h('strong', '使用的来源'),
          ...execution.citations.map((citation, index) => h(ElTag, { key: `${citation.source}-${citation.id}-${index}`, size: 'small', effect: 'plain' }, {
            default: () => `${citation.source} · ${citation.title} (${citation.id})`,
          })),
          ...execution.sourceEventIds.filter((id) => !execution.citations.some((citation) => citation.id === id)).map((id) =>
            h(ElTag, { key: `event-${id}`, size: 'small', effect: 'plain' }, { default: () => `上下文事件 · ${id}` })),
          execution.sourceEvents.length ? h(ElCollapse, { class: 'sp-workspace-source-events' }, { default: () => [h(ElCollapseItem, {
            name: `context-${execution.id}`, title: `展开 ${execution.sourceEvents.length} 条上下文消息`,
          }, { default: () => execution.sourceEvents.map((source) => h('article', { class: 'sp-workspace-source-event', key: source.id }, [
            h(ElText, { type: 'info' }, { default: () => `${source.author}${source.seq === null ? '' : ` · #${source.seq}`} · ${source.at ? tableDateText(source.at) : ''}` }),
            source.text ? h('p', { class: 'sp-workspace-queue-event-text' }, source.text) : null,
          ])) })] }) : null,
        ]) : null,
        !isOwnMessage ? h('div', { class: 'sp-workspace-audit-label' }, 'Agent 答复内容') : null,
        !isOwnMessage ? h('div', { class: 'sp-workspace-audit-content is-response' }, renderAuditContent(execution.text, `reply-${execution.id}`)) : null,
      ] })
      }
      const filePane = h(ElRow, { gutter: 18, class: 'sp-workspace-file-pane' }, { default: () => [
        h(ElCol, { span: 6, class: 'sp-workspace-tree-column' }, h(ElCard, { shadow: 'never', class: 'sp-workspace-folder-card' }, {
          header: () => h('strong', '文件夹'),
          default: () => directoryTree,
        })),
        h(ElCol, { span: 18, class: 'sp-workspace-file-column' }, [pathToolbar, fileTable,
          fileActionNotice.value ? h(ElAlert, { type: fileActionError.value ? 'error' : 'success', title: fileActionNotice.value, closable: true, onClose: () => { fileActionNotice.value = '' } }) : null,
          notice.value ? h(ElText, { type: 'danger' }, { default: () => notice.value }) : null,
        ]),
      ] })
      const recent = inboxes.value.find((row) => row.agentId === selectedId.value)?.recent ?? []
      const teamQueue = inboxes.value.flatMap((row) => row.pending.filter((session) => session.count > 0).map((session) => ({
        ...session, agentId: row.agentId, agentTitle: agents.value.find((agent) => agent.id === row.agentId)?.title ?? row.agentId,
        processing: processing.value.find((item) => item.agentId === row.agentId && item.sessionId === session.sessionId),
      }))).sort((a, b) => Number(Boolean(b.processing)) - Number(Boolean(a.processing)) || b.count - a.count)
      const statusLabels: Record<string, string> = { replied: '已答复', failed: '失败', blocked: '发言受限', scanned: '后台已扫描', legacy: '旧记录 · 详情缺失' }
      const overviewPane = h(ElSpace, { direction: 'vertical', fill: true, class: 'sp-workspace-queue-sessions' }, { default: () => [
        h(ElSpace, { wrap: true }, { default: () => [
          h(ElTag, { type: teamQueue.length ? 'warning' : 'success' }, { default: () => `全队待处理 ${teamQueue.reduce((sum, item) => sum + item.count, 0)} 条` }),
          h(ElTag, { effect: 'plain' }, { default: () => `当前 Agent 待处理 ${inbox.reduce((sum, item) => sum + item.count, 0)} 条` }),
          h(ElButton, { text: true, onClick: () => void loadOverview() }, { default: () => '刷新状态' }),
        ] }),
        h('strong', '最近处理的消息 · 当前 Agent'),
        h(ElText, { type: 'info', size: 'small' }, { default: () => '按记录时间倒序。后台扫描与实际答复分别标识；点击查看原消息、处理步骤、答复和工具结果。' }),
        h(ElTable, { data: recent, size: 'small', emptyText: '暂无处理记录', rowKey: 'eventId' }, { default: () => [
          h(ElTableColumn, { label: '时间', width: 110 }, { default: ({ row }: { row: RecentMessage }) => tableDateText(row.at) }),
          h(ElTableColumn, { prop: 'sessionTitle', label: '会话', minWidth: 110, showOverflowTooltip: true }),
          h(ElTableColumn, { prop: 'text', label: '原消息', minWidth: 180, showOverflowTooltip: true }),
          h(ElTableColumn, { label: '结果', width: 145 }, { default: ({ row }: { row: RecentMessage }) => h(ElTag, { size: 'small', type: row.status === 'failed' ? 'danger' : row.status === 'replied' ? 'success' : 'info', effect: 'plain' }, { default: () => statusLabels[row.status] ?? row.status }) }),
          h(ElTableColumn, { prop: 'result', label: '处理结果摘要', minWidth: 180, showOverflowTooltip: true }),
          h(ElTableColumn, { label: '详情', width: 100 }, { default: ({ row }: { row: RecentMessage }) => h(ElButton, { text: true, type: 'primary', onClick: () => {
            const session = inbox.find((item) => item.sessionId === row.sessionId)
            if (session) openInbox(session, 'history', row.historyPage, row.eventId)
          } }, { default: () => `查看 #${row.seq}` }) }),
        ] }),
        h('strong', '全队消息队列'),
        h(ElText, { type: 'info', size: 'small' }, { default: () => '跨 Agent、跨会话汇总待处理投递。同一消息分给多个 Agent 时分别计数；零待处理会话不占用列表。' }),
        h(ElTable, { data: teamQueue, size: 'small', emptyText: '全队已追上最新消息，没有待处理投递' }, { default: () => [
          h(ElTableColumn, { prop: 'agentTitle', label: 'Agent', minWidth: 130 }),
          h(ElTableColumn, { prop: 'sessionTitle', label: '会话', minWidth: 150, showOverflowTooltip: true }),
          h(ElTableColumn, { prop: 'count', label: '待处理', width: 90 }),
          h(ElTableColumn, { label: '状态 / 当前步骤', minWidth: 200 }, { default: ({ row }: { row: typeof teamQueue[number] }) => row.processing
            ? `${inboxPhaseText[row.processing.phase] ?? row.processing.phase} · #${row.processing.seq}` : row.active ? '即将处理' : '等待处理' }),
          h(ElTableColumn, { label: '操作', width: 110 }, { default: ({ row }: { row: typeof teamQueue[number] }) => h(ElButton, { text: true, type: 'primary', onClick: () => {
            selectAgent(row.agentId); openInbox(row, 'pending')
          } }, { default: () => '查看消息' }) }),
        ] }),
      ] })
      const workspaceCard = h(ElCard, { shadow: 'never', loading: loading.value }, {
        header: () => h('strong', scope.value === 'shared' ? '团队公共工作区 · Agent 只读' : '个人工作区'),
        default: () => [currentWorkCard, h(ElTabs, { class: 'sp-workspace-tabs', modelValue: activeTab.value, 'onUpdate:modelValue': (value: string) => { activeTab.value = value } }, { default: () => [
          scope.value === 'agent' ? h(ElTabPane, { label: '消息概览', name: 'overview' }, { default: () => overviewPane }) : null,
          h(ElTabPane, { label: '文件', name: 'files' }, { default: () => filePane }),
          scope.value === 'agent' ? h(ElTabPane, { label: '运行记录', name: 'runs' }, { default: () => activity.length ? h(ElTimeline, {}, { default: () => activity.map((step) => h(ElTimelineItem, {
            timestamp: dateText(step.at), placement: 'top', type: 'primary',
          }, { default: () => [h('strong', step.title), h('div', step.label), step.detail ? h('div', step.detail) : null,
            step.inputSummary ? h('div', `工具输入摘要：${step.inputSummary}`) : null,
            step.resultSummary ? h('div', `工具结果：${step.resultSummary}`) : null,
            step.durationMs !== undefined ? h('div', `耗时 ${step.durationMs} ms`) : null] })) })
            : h(ElEmpty, { description: 'Agent 当前没有运行记录' }) }) : null,
          scope.value === 'agent' ? h(ElTabPane, { label: `消息队列 (${inbox.reduce((sum, item) => sum + item.count, 0)})`, name: 'queue' }, { default: () => inbox.some((item) => item.count > 0) ? h('div', { class: 'sp-workspace-queue-sessions' }, inbox.filter((item) => item.count > 0).map((item) => {
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
      const codeFence = '`'.repeat(Math.max(3, ...[...preview.value.matchAll(/`+/g)].map((match) => match[0].length + 1)))
      const fileLanguage = file?.name.match(/\.([^.]+)$/)?.[1]?.toLowerCase() ?? ''
      const fileCode = `${codeFence}${fileLanguage}\n${preview.value}\n${codeFence}`
      const fileDrawer = h(ElDrawer, { modelValue: fileDrawerOpen.value, title: file?.name ?? '文件预览', size: 'min(720px, 60vw)', direction: 'rtl',
        'onUpdate:modelValue': (value: boolean) => { fileDrawerOpen.value = value } }, {
        default: () => file ? [
          h(ElText, { type: 'info' }, { default: () => `${file.path} · ${dateText(file.modifiedAt)}` }),
          transferNotice.value ? h(ElAlert, { type: transferError.value ? 'error' : 'success', title: transferNotice.value, closable: true, onClose: () => { transferNotice.value = '' } }) : null,
          fileActionNotice.value ? h(ElAlert, { type: fileActionError.value ? 'error' : 'success', title: fileActionNotice.value, closable: true, onClose: () => { fileActionNotice.value = '' } }) : null,
          previewError.value ? h(ElEmpty, { description: previewError.value }) : h(ElScrollbar, { maxHeight: '75vh' }, { default: () => renderMarkdown(fileCode, h, { Markdown, Button: ElButton }) }),
          h(ElButton, { type: 'primary', loading: fileActionBusy.value, onClick: () => void downloadSelectedFile() }, { default: () => '下载原文件' }),
          h(ElButton, { plain: true, onClick: () => {
            transferTarget.value = scope.value === 'agent' ? '__shared__' : (agents.value[0]?.id ?? '')
            transferDialogOpen.value = true
          } }, { default: () => '复制到其他工作区' }),
        ] : h(ElEmpty, { description: '选择文件查看受限文本预览' }),
      })
      const transferDialog = h(ElDialog, {
        modelValue: transferDialogOpen.value,
        'onUpdate:modelValue': (value: boolean) => { transferDialogOpen.value = value },
        title: '复制文件到工作区', width: 'min(480px, 90vw)', appendToBody: true,
      }, {
        default: () => [
          h(ElText, { type: 'info' }, { default: () => `复制「${file?.name ?? ''}」到选定工作区根目录。目标已存在同名文件时会拒绝覆盖，源文件保留。` }),
          h(ElSelect, { modelValue: transferTarget.value, 'onUpdate:modelValue': (value: string) => { transferTarget.value = value }, placeholder: '选择目标工作区' }, {
            default: () => [
              ...(scope.value === 'agent' ? [h(ElOption, { label: '团队公共工作区', value: '__shared__' })] : []),
              ...agents.value.filter((agent) => scope.value === 'shared' || agent.id !== selectedId.value).map((agent) => h(ElOption, { key: agent.id, label: `${agent.title} 的工作区`, value: agent.id })),
            ],
          }),
        ],
        footer: () => h(ElSpace, {}, { default: () => [
          h(ElButton, { onClick: () => { transferDialogOpen.value = false } }, { default: () => '取消' }),
          h(ElButton, { type: 'primary', loading: transferBusy.value, disabled: !file || !transferTarget.value, onClick: () => void transferSelectedFile() }, { default: () => '确认复制' }),
        ] }),
      })
      const inboxDialog = h(ElDialog, {
        modelValue: inboxDialogOpen.value,
        'onUpdate:modelValue': (value: boolean) => { inboxDialogOpen.value = value },
        title: inboxSession.value ? `${inboxMode.value === 'history' ? '历史处理记录' : '待处理消息'} · ${inboxSession.value.sessionTitle}` : '消息记录',
        width: 'min(1040px, 84vw)', appendToBody: true,
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
              h(ElText, { type: 'info' }, { default: () => `${inboxMode.value === 'history'
                ? `${inboxDetail.value!.scannedTotal ?? inboxDetail.value!.total} 条已扫描 · ${inboxDetail.value!.total} 组触发消息`
                : `${inboxDetail.value!.total} 条待消化消息`} · 后台游标 #${inboxDetail.value!.cursor} / 最新消息 #${inboxDetail.value!.latestSeq}` }),
              h(ElButton, { text: true, onClick: () => window.location.assign(`/teamspace?session=${encodeURIComponent(inboxDetail.value!.sessionId)}`) }, {
                default: () => '打开原会话',
              }),
            ]),
            inboxDetail.value.items.length ? h('div', { class: 'sp-workspace-queue-events sp-workspace-queue-events-scroll' }, inboxDetail.value.items.map((event) => h('article', {
              class: ['sp-workspace-queue-event', event.authorKind === 'agent' ? 'is-agent-message' : 'is-trigger-message', event.id === inboxFocusId.value ? 'is-focused' : ''], key: event.id,
            }, [
              h('div', { class: 'sp-workspace-queue-event-head' }, [
                h(ElTag, { size: 'small', type: event.authorKind === 'agent' ? 'success' : 'primary', effect: 'plain' }, { default: () => event.authorKind === 'agent' ? 'Agent 发言' : '触发消息' }),
                h('strong', event.author),
                h('span', `消息 #${event.seq} · ${tableDateText(event.at)}`),
              ]),
              h('div', { class: 'sp-workspace-audit-content' }, renderAuditContent(event.text, `event-${event.id}`)),
              inboxMode.value === 'history' ? h(ElCollapse, { class: 'sp-workspace-inbox-trace-collapse' }, { default: () => [h(ElCollapseItem, {
                name: `scan-${event.id}`,
                title: `${event.inboxTrace?.status === 'failed' ? '后台扫描失败' : '后台扫描完成'} · ${event.inboxTrace?.agentTitle ?? 'Agent'} · ${event.inboxTrace?.steps.length ?? 0} 步`,
              }, { default: () => h('section', { class: 'sp-workspace-inbox-trace' }, [
                event.inboxTrace ? [
                  h(ElText, { type: 'info', size: 'small' }, { default: () => `${tableDateText(event.inboxTrace!.startedAt)} → ${tableDateText(event.inboxTrace!.completedAt)}` }),
                  event.inboxTrace.steps.length ? h(ElTimeline, { class: 'sp-workspace-audit-timeline' }, { default: () => event.inboxTrace!.steps.map((step, index) => h(ElTimelineItem, {
                    key: `${event.id}-inbox-${index}`, timestamp: tableDateText(step.at), type: step.status === 'failed' ? 'danger' : 'primary',
                  }, { default: () => [h('strong', step.label), h('div', step.detail)] })) }) : null,
                  event.inboxTrace.modelTrace.length ? h(ElCollapse, { class: 'sp-workspace-model-trace' }, { default: () => event.inboxTrace!.modelTrace.map((call) => renderModelInteraction(`${event.id}-inbox`, call)) })
                    : h(ElText, { type: 'info', size: 'small' }, { default: () => '无模型请求记录' }),
                ] : h(ElText, { type: 'info', size: 'small' }, { default: () => '旧记录：当时未保存扫描步骤' }),
              ]) })] }) : null,
              ...(event.liveExecutions ?? []).map((execution) => h('section', { class: 'sp-workspace-queue-live', key: execution.runId }, [
                h('strong', `${execution.title} · ${phaseText[execution.phase] ?? execution.phase}（实时）`),
                execution.step?.detail ? h('p', execution.step.detail) : null,
                execution.currentText ? h('p', { class: 'sp-workspace-queue-event-text' }, execution.currentText) : null,
                execution.steps.length ? h(ElTimeline, {}, { default: () => execution.steps.map((step, index) => h(ElTimelineItem, {
                  key: `${execution.runId}-${index}`, timestamp: tableDateText(step.at), type: step.status === 'failed' ? 'danger' : 'primary',
                }, { default: () => [h('strong', step.label), step.detail ? h('div', step.detail) : null,
                  step.inputSummary ? h('div', `工具输入摘要：${step.inputSummary}`) : null,
                  step.resultSummary ? h('div', `工具结果：${step.resultSummary}`) : null,
                  step.durationMs !== undefined ? h('div', `耗时 ${step.durationMs} ms`) : null] })) }) : null,
              ])),
              event.executions?.length ? h(ElCollapse, { class: 'sp-workspace-event-executions' }, { default: () => event.executions!.map((execution) => renderExecution(execution, event.id)) })
                : h(ElText, { type: 'info', class: 'sp-workspace-no-execution' }, { default: () => inboxMode.value === 'history'
                ? event.mentions?.length
                  ? '没有找到关联的 Agent 答复'
                  : '本条没有 Agent 答复'
                : '该消息尚无关联的 Agent 答复记录。' }),
            ]))) : h(ElEmpty, { description: inboxMode.value === 'history' ? '还没有已完成的历史处理记录' : '该 Agent 已追上最新消息，队列刚刚处理完成。' }),
            inboxDetail.value.total > inboxDetail.value.pageSize ? h(ElPagination, {
              currentPage: inboxDetail.value.page, pageSize: inboxDetail.value.pageSize,
              total: inboxDetail.value.total, layout: 'prev, pager, next, total',
              disabled: inboxLoading.value,
              onCurrentChange: (page: number) => {
                inboxFocusId.value = ''
                inboxPage.value = page
                void loadInboxPage(page).then(() => {
                  const dialogClass = inboxMode.value === 'history' ? 'sp-workspace-history-dialog' : 'sp-workspace-queue-dialog'
                  document.querySelector<HTMLElement>(`.${dialogClass} .sp-workspace-queue-events-scroll`)?.scrollTo({ top: 0 })
                })
              },
            }) : null,
          ]) : null,
        ],
        footer: () => h(ElButton, { onClick: () => { inboxDialogOpen.value = false } }, { default: () => '关闭' }),
      })
      const scopeToggle = h(ElRadioGroup, { modelValue: scope.value, onChange: selectScope }, { default: () => [
        h(ElRadioButton, { label: 'agent' }, { default: () => 'Agent 工作区' }),
        h(ElRadioButton, { label: 'shared' }, { default: () => '公共工作区' }),
      ] })
      const content = h('div', {}, [
        scopeToggle,
        h(ElRow, { gutter: 18, class: 'sp-agent-explorer' }, { default: () => [
          scope.value === 'agent' ? h(ElCol, { span: 5, class: 'sp-workspace-agent-column' }, h(ElCard, { class: 'sp-workspace-agent-card', shadow: 'never' }, {
            header: () => h('strong', '团队 Agent'), default: () => agentMenu,
          })) : null,
        h(ElCol, { span: scope.value === 'agent' ? 19 : 24, class: 'sp-workspace-content-column' }, [workspaceCard, fileDrawer, transferDialog, inboxDialog]),
        ] }),
      ])
      return sharedPage('Agent 工作区', '查看 Agent 当前阶段、消息处理记录与工作区文件。', content, 'sp-workspace-page')
    }
  },
})

export const MEMORY_PAGE_ICON = ICONS.kb
export const WORKSPACE_PAGE_ICON = ICONS.agents
