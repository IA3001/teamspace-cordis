// 知识库管理页（客户端）—— 2026-10-01 新增。
//
// 结构：页头显示向量检索状态与文档数量；「文档管理」负责录入和维护共享
// 资料，「检索验证」独立展示 Agent 可检索到的命中片段。慢提交和请求失败
// 都在对应操作区反馈，不把录入与测试混在一个长页面里。
//
// 鉴权：RPC 首参 token（localStorage 'space_token'）；me(token) 探测 ——
// null = 未登录跳 /login（与 /login 页、sessions 栏共用口径）。
//
// 铁律 1：只用外壳全局注册的 el-* / k-*（resolveComponent），零 import
// element-plus、零手写样式、零内联 style。
import { defineComponent, h, onMounted, ref, resolveComponent } from 'vue'
import type { Component } from 'vue'
import { useRouter, useRpc } from '@cordisjs/client'
import { ThemeStyle } from 'space-client-ui-shared/client/theme.ts'
import { pageHead, section, field, actionsRow, note, ICONS } from 'space-client-ui-shared/client/console.ts'
import { userFacingFailure } from 'space-client-ui-shared/client/errors.ts'
import { resolveLoadView } from 'space-client-ui-shared/client/load-state.ts'
import type { KbDocument, KbDocumentDetail, KbFolder, KbHit } from 'space-kb'
import { renderMarkdown } from 'space-client-ui-shared/client/md.ts'
import { SvgIcon } from 'space-client-ui-shared/client/icon-library.ts'

/** 知识库文档视图（KbDocument 契约子集）。 */
type DocRow = KbDocument

/** 检索命中视图，与 knowledge seam 的 KbHit 保持一致。 */
type HitRow = KbHit
type KbFolderNode = KbFolder & { children: KbFolderNode[] }

/** 登录 token 的 localStorage 键（/login 页与各 RPC 共用）。 */
const TOKEN_KEY = 'space_token'
const getToken = () => localStorage.getItem(TOKEN_KEY) ?? ''

const KbPage = defineComponent({
  name: 'SpaceKbPage',
  setup() {
    const router = useRouter()
    const rpc = useRpc<{
      docs(token: string): Promise<DocRow[] | null>
      folders(token: string): Promise<KbFolder[] | null>
      getDoc(token: string, id: string): Promise<KbDocumentDetail | { error: string } | null>
      createFolder(token: string, name: string, parentPath?: string): Promise<KbFolder | { error: string; detail: string } | null>
      addDoc(token: string, title: string, text: string, folderPath?: string): Promise<DocRow | { error: string; detail: string } | null>
      updateDoc(token: string, id: string, title: string, text: string, folderPath?: string): Promise<KbDocumentDetail | { error: string; detail: string } | null>
      removeDoc(token: string, id: string): Promise<void | { error: string } | null>
      searchKb(token: string, query: string): Promise<HitRow[] | { error: string; detail?: string } | null>
      embeddingsStatus(token: string): Promise<boolean | null>
    }>()

    const me = ref(null) as { value: { displayName?: string } | null }
    void me // 保留引用位：后续「当前身份」展示用
    const docs = ref([]) as { value: DocRow[] }
    const folders = ref([]) as { value: KbFolder[] }
    const selectedDocId = ref('')
    const selectedFolderPath = ref('')
    const selectedDetail = ref(null) as { value: KbDocumentDetail | null }
    const detailLoading = ref(false)
    const folderDialogOpen = ref(false)
    const folderName = ref('')
    const folderBusy = ref(false)
    const folderErr = ref('')
    const editMode = ref(false)
    const addDialogOpen = ref(false)
    const embOn = ref(false)
    const docsLoading = ref(true)
    const docsFailed = ref(false)
    const docsError = ref('')

    // ── 新增表单 ────────────────────────────────────────────────────────
    const newTitle = ref('')
    const newText = ref('')
    const newFolderPath = ref('')
    const addBusy = ref(false)
    const addErr = ref('')
    const addNotice = ref('')
    const addReady = () => Boolean(newTitle.value.trim() && newText.value.trim())
    const removeErr = ref('')
    const removingId = ref('')

    // ── 搜索 ────────────────────────────────────────────────────────────
    const query = ref('')
    const searchBusy = ref(false)
    const searchErr = ref('')
    const searchedQuery = ref('')
    const hits = ref<HitRow[] | null>(null) // null = 还没搜过
    const activeWorkspace = ref('documents')

    /** 拉文档列表。 */
    async function refresh() {
      docsLoading.value = true
      docsFailed.value = false
      docsError.value = ''
      try {
        const [emb, list, folderList] = await Promise.all([
          rpc.value.embeddingsStatus(getToken()),
          rpc.value.docs(getToken()),
          rpc.value.folders(getToken()),
        ])
        if (list === null || emb === null || folderList === null) {
          void router.replace({ path: '/login' })
          return
        }
        docs.value = list
        folders.value = folderList
        if (!list.some((doc) => doc.id === selectedDocId.value)) selectedDocId.value = list[0]?.id ?? ''
        if (selectedDocId.value) void loadSelectedDoc(selectedDocId.value)
        embOn.value = emb === true
      } catch {
        docsFailed.value = true
        docsError.value = userFacingFailure('加载知识库')
      } finally {
        docsLoading.value = false
      }
    }

    onMounted(() => { void refresh() })

    async function loadSelectedDoc(id: string) {
      if (!id) { selectedDetail.value = null; return }
      detailLoading.value = true
      try {
        const result = await rpc.value.getDoc(getToken(), id)
        if (result === null) { void router.replace({ path: '/login' }); return }
        if ('error' in result) { selectedDetail.value = null; return }
        selectedDetail.value = result
      } catch { selectedDetail.value = null }
      finally { detailLoading.value = false }
    }

    async function selectDoc(id: string) {
      selectedDocId.value = id
      editMode.value = false
      await loadSelectedDoc(id)
    }

    function beginEdit() {
      if (!selectedDetail.value) return
      newTitle.value = selectedDetail.value.title
      newText.value = selectedDetail.value.content
      newFolderPath.value = selectedDetail.value.folderPath
      addErr.value = ''
      editMode.value = true
      addDialogOpen.value = true
    }

    /** 添加文档：成功清空并刷新；失败把 detail 放 addErr 显示。 */
    async function doAdd() {
      if (addBusy.value) return
      if (!addReady()) {
        addErr.value = '请填写文档标题和正文。'
        return
      }
      addBusy.value = true
      addErr.value = ''
      addNotice.value = ''
      try {
        const res = editMode.value && selectedDocId.value
          ? await rpc.value.updateDoc(getToken(), selectedDocId.value, newTitle.value, newText.value, newFolderPath.value)
          : await rpc.value.addDoc(getToken(), newTitle.value, newText.value, newFolderPath.value)
        if (res === null) {
          void router.replace({ path: '/login' })
          return
        }
        if ((res as { error?: string }).error) {
          addErr.value = (res as { detail?: string }).detail ?? '添加失败'
          return
        }
        const createdDoc = res as DocRow
        selectedDocId.value = createdDoc.id
        selectedFolderPath.value = createdDoc.folderPath
        newTitle.value = ''
        newText.value = ''
        newFolderPath.value = ''
        addDialogOpen.value = false
        editMode.value = false
        addNotice.value = '文档已保存，检索索引正在更新。'
        await refresh()
        await loadSelectedDoc(createdDoc.id)
      } catch {
        addErr.value = userFacingFailure('添加文档')
      } finally {
        addBusy.value = false
      }
    }

    async function doCreateFolder() {
      if (folderBusy.value || !folderName.value.trim()) return
      folderBusy.value = true
      folderErr.value = ''
      try {
        const result = await rpc.value.createFolder(getToken(), folderName.value, selectedFolderPath.value)
        if (result === null) { void router.replace({ path: '/login' }); return }
        if ('error' in result) { folderErr.value = result.detail || '创建文件夹失败'; return }
        folders.value = [...folders.value, result].sort((a, b) => a.path.localeCompare(b.path, 'zh-CN'))
        selectedFolderPath.value = result.path
        selectedDocId.value = ''
        selectedDetail.value = null
        folderName.value = ''
        folderDialogOpen.value = false
      } catch { folderErr.value = userFacingFailure('创建文件夹') }
      finally { folderBusy.value = false }
    }

    /** 删除文档（popconfirm 确认后调用）。 */
    async function doRemove(id: string) {
      if (removingId.value) return
      removingId.value = id
      removeErr.value = ''
      try {
        const result = await rpc.value.removeDoc(getToken(), id)
        if (result === null) {
          void router.replace({ path: '/login' })
          return
        }
        if (result && 'error' in result) {
          removeErr.value = userFacingFailure('删除文档')
          return
        }
        if (selectedDocId.value === id) selectedDocId.value = ''
        selectedDetail.value = null
        await refresh()
      } catch {
        removeErr.value = userFacingFailure('删除文档')
      } finally {
        removingId.value = ''
      }
    }

    /** 检索：结果进 hits；null（未登录）跳 /login。 */
    async function doSearch() {
      if (searchBusy.value || !query.value.trim()) return
      const submittedQuery = query.value.trim()
      searchBusy.value = true
      searchErr.value = ''
      searchedQuery.value = submittedQuery
      hits.value = null
      try {
        const res = await rpc.value.searchKb(getToken(), submittedQuery)
        if (res === null) {
          void router.replace({ path: '/login' })
          return
        }
        if (!Array.isArray(res)) {
          searchErr.value = userFacingFailure('搜索知识库')
          return
        }
        hits.value = res
      } catch {
        searchErr.value = userFacingFailure('搜索知识库')
      } finally {
        searchBusy.value = false
      }
    }

    /** 命中条目归一化：标题 / 文本字段名做宽松兼容。 */
    function hitTitle(hit: HitRow) {
      return hit.docTitle
    }
    function hitText(hit: HitRow) {
      return hit.text
    }

    return () => {
      const ElButton = resolveComponent('el-button') as unknown as string
      const ElCard = resolveComponent('el-card') as unknown as string
      const ElCol = resolveComponent('el-col') as unknown as string
      const ElDescriptions = resolveComponent('el-descriptions') as unknown as string
      const ElDescriptionsItem = resolveComponent('el-descriptions-item') as unknown as string
      const ElDialog = resolveComponent('el-dialog') as unknown as string
      const ElEmpty = resolveComponent('el-empty') as unknown as string
      const ElInput = resolveComponent('el-input') as unknown as string
      const ElScrollbar = resolveComponent('el-scrollbar') as unknown as string
      const ElTree = resolveComponent('el-tree') as unknown as string
      const ElPopconfirm = resolveComponent('el-popconfirm') as unknown as string
      const ElRow = resolveComponent('el-row') as unknown as string
      const ElSpace = resolveComponent('el-space') as unknown as string
      const ElSelect = resolveComponent('el-select') as unknown as string
      const ElOption = resolveComponent('el-option') as unknown as string
      const ElTable = resolveComponent('el-table') as unknown as string
      const ElTableColumn = resolveComponent('el-table-column') as unknown as string
      const ElTabs = resolveComponent('el-tabs') as unknown as string
      const ElTabPane = resolveComponent('el-tab-pane') as unknown as string
      const ElText = resolveComponent('el-text') as unknown as string
      const Markdown = resolveComponent('k-markdown') as unknown as string
      const removeDocButton = (doc: DocRow) => h(ElPopconfirm, {
        title: '确认删除该文档？',
        onConfirm: () => void doRemove(doc.id),
      }, {
        reference: () => h(ElButton, {
          type: 'danger', size: 'small', link: true,
          loading: removingId.value === doc.id,
          disabled: Boolean(removingId.value && removingId.value !== doc.id),
        }, { default: () => '删除' }),
      })
      const docDate = (doc: DocRow) => {
        try { return new Date(doc.createdAt).toLocaleString('zh-CN') } catch { return doc.createdAt }
      }
      const folderNodes = (() => {
        const root: KbFolderNode = { path: '', name: '全部资料', parentPath: '', documentCount: docs.value.length, children: [] }
        const byPath = new Map<string, KbFolderNode>([['', root]])
        for (const folder of [...folders.value].sort((a, b) => a.path.localeCompare(b.path, 'zh-CN'))) {
          const node: KbFolderNode = { ...folder, children: [] }
          byPath.set(folder.path, node)
          ;(byPath.get(folder.parentPath) ?? root).children.push(node)
        }
        return [root]
      })()

      // Keep ingestion and retrieval as separate workspaces: one edits the corpus,
      // the other checks what the Agent can retrieve from it.
      return h('div', { class: 'k-content sp-admin-wrap sp-kb-wrap' }, [
        h(ThemeStyle),
        pageHead('知识库',
          '管理团队资料，供 Agent 检索使用。',
          {
            statuses: [
              { text: embOn.value ? '向量检索已启用' : '向量检索未启用（关键词兜底）',
                level: embOn.value ? 'ok' : 'warn' },
              { text: `文档 ${docs.value.length} 篇`, level: 'idle' },
            ],
          }),
        h(ElTabs, {
          class: 'sp-kb-tabs sp-page-tabs', modelValue: activeWorkspace.value,
          'onUpdate:modelValue': (value: string) => { activeWorkspace.value = value },
        }, { default: () => [
        h(ElTabPane, { label: '文档管理', name: 'documents' }, { default: () => [
          addNotice.value ? note(addNotice.value, true) : null,
          removeErr.value ? note(removeErr.value, false) : null,
          h(ElRow, { gutter: 16, align: 'top', class: 'sp-kb-master-detail' }, [
            h(ElCol, { span: 4, class: 'sp-kb-folder-column' }, [
              h(ElCard, { shadow: 'never', class: 'sp-kb-folder-card' }, {
                header: () => h(ElRow, { justify: 'space-between', align: 'middle' }, [
                  h(ElText, { tag: 'strong' }, { default: () => '文件夹' }),
                  h(ElButton, { text: true, type: 'primary', onClick: () => { folderErr.value = ''; folderDialogOpen.value = true } }, {
                    default: () => '新建',
                  }),
                ]),
                default: () => h(ElScrollbar, { class: 'sp-kb-folder-scroll', always: true, height: '100%' }, { default: () => h(ElTree, {
                  data: folderNodes, nodeKey: 'path', highlightCurrent: true,
                  currentNodeKey: selectedFolderPath.value, defaultExpandAll: true,
                  props: { label: 'name', children: 'children' }, renderAfterExpand: false,
                  onNodeClick: (node: KbFolderNode) => {
                    selectedFolderPath.value = node.path
                    editMode.value = false
                    const first = docs.value.find((doc) => !node.path || doc.folderPath === node.path)
                    selectedDocId.value = first?.id ?? ''
                    void loadSelectedDoc(selectedDocId.value)
                  },
                  renderContent: (_render: unknown, context: { data: KbFolderNode }) => h('span', { class: 'sp-explorer-tree-node' }, [
                    h('span', { class: 'sp-explorer-tree-name' }, [h(SvgIcon, { name: 'Folder' }), h('span', context.data.name)]),
                    h(ElText, { type: 'info', size: 'small' }, { default: () => String(context.data.documentCount) }),
                  ]),
                }) }),
              }),
            ]),
            h(ElCol, { span: 8, class: 'sp-kb-document-list-column' }, [
              h(ElCard, { shadow: 'never' }, {
                header: () => h(ElRow, { justify: 'space-between', align: 'middle' }, [
                  h(ElText, { tag: 'strong' }, { default: () => `资料 · ${docs.value.filter((doc) => !selectedFolderPath.value || doc.folderPath === selectedFolderPath.value).length}` }),
                  h(ElButton, { type: 'primary', onClick: () => {
                    editMode.value = false; addErr.value = ''; newTitle.value = ''; newText.value = ''
                    newFolderPath.value = selectedFolderPath.value; addDialogOpen.value = true
                  } }, { default: () => '添加资料' }),
                ]),
                default: () => {
                  const visibleDocs = docs.value.filter((doc) => !selectedFolderPath.value || doc.folderPath === selectedFolderPath.value)
                  const view = resolveLoadView(docsLoading.value, docsFailed.value, visibleDocs.length > 0)
                  if (view === 'loading') return h(ElEmpty, { description: '正在加载资料…' })
                  if (view === 'error') return h('div', [h(ElEmpty, { description: docsError.value || '资料暂时无法加载' }), h(ElButton, { onClick: () => void refresh() }, { default: () => '重试' })])
                  if (!visibleDocs.length) return h(ElEmpty, { description: selectedFolderPath.value ? '这个文件夹还没有资料' : '知识库还没有资料' })
                  return h(ElTable, {
                    data: visibleDocs,
                    rowKey: 'id',
                    currentRowKey: selectedDocId.value,
                    highlightCurrentRow: true,
                    onRowClick: (doc: DocRow) => { void selectDoc(doc.id) },
                  }, { default: () => [
                    h(ElTableColumn, { prop: 'title', label: '资料名称', minWidth: 140, showOverflowTooltip: true }, {
                      default: ({ row }: { row: DocRow }) => h('span', { class: 'sp-workspace-file-name' }, [h(SvgIcon, { name: 'Document' }), h('span', row.title)]),
                    }),
                    h(ElTableColumn, { prop: 'chunkCount', label: '检索块', width: 82 }),
                  ] })
                },
              }),
            ]),
            h(ElCol, { span: 12, class: 'sp-kb-document-detail-column' }, [
              (() => {
                const selected = selectedDetail.value ?? docs.value.find((doc) => doc.id === selectedDocId.value)
                if (!selected) return h(ElCard, { shadow: 'never' }, {
                  default: () => h(ElEmpty, { description: docs.value.length ? '选择一份资料以阅读和编辑正文' : '添加资料后，可在这里阅读和维护' }),
                })
                return h(ElCard, { shadow: 'never' }, {
                  header: () => h(ElRow, { justify: 'space-between', align: 'middle' }, [
                    h(ElText, { tag: 'strong' }, { default: () => selected.title }),
                    h(ElSpace, null, { default: () => [
                      h(ElButton, { disabled: !selectedDetail.value || detailLoading.value, onClick: beginEdit }, { default: () => '编辑资料' }),
                      h(ElButton, { onClick: () => { query.value = selected.title; activeWorkspace.value = 'search'; void doSearch() } }, {
                        default: () => '验证检索',
                      }),
                      removeDocButton(selected),
                    ] }),
                  ]),
                  default: () => [
                    detailLoading.value ? h(ElText, { type: 'info', role: 'status' }, { default: () => '正在读取文档正文…' }) : null,
                    h(ElDescriptions, { column: 2, border: true, size: 'small' }, { default: () => [
                      h(ElDescriptionsItem, { label: '来源' }, { default: () => selected.source || '手动添加' }),
                      h(ElDescriptionsItem, { label: '字符数' }, { default: () => String(selected.size ?? 0) }),
                      h(ElDescriptionsItem, { label: '检索片段' }, { default: () => String(selected.chunkCount ?? 0) }),
                      h(ElDescriptionsItem, { label: '文件夹' }, { default: () => selected.folderPath || '全部资料' }),
                      h(ElDescriptionsItem, { label: '加入时间' }, { default: () => docDate(selected) }),
                    ] }),
                    selectedDetail.value
                      ? h('div', renderMarkdown(selectedDetail.value.content, h, { Markdown, Button: ElButton }))
                      : h(ElEmpty, { description: detailLoading.value ? '正在读取…' : '正文读取失败，请重新选择文档。' }),
                    h(ElText, { type: 'info', size: 'small' }, { default: () => '修改正文后会重建检索片段，并重新提交向量索引。' }),
                  ],
                })
              })(),
            ]),
          ]),
        ] }),
        h(ElTabPane, { label: '检索验证', name: 'search' }, { default: () => [
        section('检索验证', '模拟 Agent 查找共享资料并查看命中片段。会话历史优先于知识库；向量检索关闭时使用关键词匹配。',
          [
            actionsRow([
              h(ElInput, {
                modelValue: query.value,
                'onUpdate:modelValue': (v: string) => { query.value = v },
                placeholder: '搜索知识库…',
                clearable: true,
                onKeydown: (e: KeyboardEvent) => { if (e.key === 'Enter') void doSearch() },
              }),
              h(ElButton, {
                type: 'primary', loading: searchBusy.value, disabled: !query.value.trim(), onClick: () => void doSearch(),
              }, { default: () => '搜索' }),
            ]),
            hits.value === null && !searchBusy.value && !query.value.trim()
              ? h(ElRow, { gutter: 24, align: 'middle' }, [
                  h(ElCol, { span: 10 }, [
                    h(ElSpace, { direction: 'vertical', alignment: 'start', size: 4 }, { default: () => [
                      h(ElText, { tag: 'strong' }, { default: () => docs.value.length ? '快速验证检索' : '暂无可检索文档' }),
                      h(ElText, { type: 'info' }, { default: () => docs.value.length
                        ? '选择一份已收录资料，查看 Agent 能检索到的内容片段。'
                        : '先添加团队资料，再回来验证检索结果。' }),
                    ] }),
                  ]),
                  h(ElCol, { span: 14 }, [
                    docs.value.length
                      ? h(ElSpace, { wrap: true, size: 8 }, { default: () => docs.value.slice(0, 4).map((doc) => h(ElButton, {
                          key: doc.id, plain: true, round: true, type: 'primary', size: 'small',
                          onClick: () => { query.value = doc.title; void doSearch() },
                        }, { default: () => doc.title })) })
                      : h(ElButton, { text: true, type: 'primary', size: 'small', onClick: () => { activeWorkspace.value = 'documents' } }, {
                          default: () => '前往文档管理',
                        }),
                  ]),
                ])
              : null,
            searchErr.value ? note(searchErr.value, false) : null,
            searchBusy.value ? h('div', { class: 'sp-hint', role: 'status' },
              `正在检索「${searchedQuery.value}」的相关文档…`) : null,
            hits.value === null
              ? null
              : (hits.value.length
                  ? h('div', { class: 'sp-hint' },
                      `检索「${searchedQuery.value}」命中 ${hits.value.length} 块：`)
                  : h('div', { class: 'sp-hint' }, `没有命中「${searchedQuery.value}」。`)),
            hits.value?.length
              ? h('div', { class: 'sp-kb-hit-rows' }, hits.value.map((hit, i) => h('article', {
                  key: i, class: 'sp-kb-hit-row',
                }, [
                  h('div', { class: 'sp-kb-hit-title' }, hitTitle(hit)),
                  h('div', { class: 'sp-kb-hit-text' }, hitText(hit)),
                ])))
              : null,
          ]),

        ] }),
        ] }),
        h(ElDialog, {
          modelValue: addDialogOpen.value,
          'onUpdate:modelValue': (value: boolean) => { if (!addBusy.value) { addDialogOpen.value = value; if (!value) editMode.value = false } },
          title: editMode.value ? '编辑团队资料' : '添加团队资料', width: '640px', closeOnClickModal: false,
        }, {
          default: () => [
            h(ElText, { type: 'info' }, { default: () => '正文将自动拆分并建立检索索引，团队成员和 Agent 均可使用。' }),
            addErr.value ? note(addErr.value, false) : null,
            field('资料名称', h(ElInput, {
              modelValue: newTitle.value,
              'onUpdate:modelValue': (v: string) => { newTitle.value = v; addNotice.value = '' },
              disabled: addBusy.value, placeholder: '例如：团队产品规范',
            })),
            field('存放文件夹', h(ElSelect, {
              modelValue: newFolderPath.value,
              'onUpdate:modelValue': (value: string) => { newFolderPath.value = value },
              placeholder: '选择文件夹（可留在全部资料）', clearable: true,
              disabled: addBusy.value,
            }, { default: () => folders.value.map((folder) => h(ElOption, {
              key: folder.path, label: folder.path, value: folder.path,
            })) })),
            field('资料正文', h(ElInput, {
              modelValue: newText.value,
              'onUpdate:modelValue': (v: string) => { newText.value = v; addNotice.value = '' },
              type: 'textarea', autosize: { minRows: 8, maxRows: 18 }, disabled: addBusy.value,
              placeholder: '粘贴需要团队共享的文本内容…',
            })),
            addBusy.value ? h(ElText, { type: 'info', role: 'status' }, {
              default: () => '正在建立索引…请保持当前内容，完成前不能关闭此窗口。',
            }) : null,
          ],
          footer: () => h(ElSpace, null, { default: () => [
            h(ElButton, { disabled: addBusy.value, onClick: () => { addDialogOpen.value = false; editMode.value = false } }, { default: () => '取消' }),
            h(ElButton, { type: 'primary', loading: addBusy.value, disabled: !addReady(), onClick: () => void doAdd() }, {
              default: () => addBusy.value ? '正在保存…' : editMode.value ? '保存修改' : '添加到知识库',
            }),
          ] }),
        }),
        h(ElDialog, {
          modelValue: folderDialogOpen.value,
          'onUpdate:modelValue': (value: boolean) => { if (!folderBusy.value) folderDialogOpen.value = value },
          title: '新建文件夹', width: '420px', closeOnClickModal: false,
        }, {
          default: () => [
            h(ElText, { type: 'info' }, { default: () => `将在「${selectedFolderPath.value || '全部资料'}」下创建文件夹。` }),
            folderErr.value ? note(folderErr.value, false) : null,
            field('文件夹名称', h(ElInput, {
              modelValue: folderName.value,
              'onUpdate:modelValue': (value: string) => { folderName.value = value },
              placeholder: '例如：产品规范', disabled: folderBusy.value,
            })),
          ],
          footer: () => h(ElSpace, null, { default: () => [
            h(ElButton, { disabled: folderBusy.value, onClick: () => { folderDialogOpen.value = false } }, { default: () => '取消' }),
            h(ElButton, { type: 'primary', loading: folderBusy.value, disabled: !folderName.value.trim(), onClick: () => void doCreateFolder() }, { default: () => '创建文件夹' }),
          ] }),
        }),
      ])
    }
  },
})

// ── 页面注册（官方约定，仿 auth 页）──────────────────────────────────────
interface PageCtx {
  client: {
    router: {
      page(options: { path: string; name: string; icon?: Component; order?: number; component: unknown }): void
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
