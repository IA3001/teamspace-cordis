// Team-shared Agent catalog editor. Definitions are configurable data and run
// through the shared Agent runtime; no per-definition plugin is required.
import { defineComponent, h, onMounted, ref, resolveComponent } from 'vue'
import type { VNodeChild } from 'vue'
import { useRpc } from '@cordisjs/client'
import { ICONS } from 'space-client-ui-shared/client/console.ts'
import { ThemeStyle } from 'space-client-ui-shared/client/theme.ts'
import { userFacingFailure } from 'space-client-ui-shared/client/errors.ts'

interface AgentDefinition {
  id: string
  title: string
  description: string
  promptRef: string
  modelRef: string
  llmProfileRef: string
  toolIds: string[]
  contextSources: string[]
  memoryPolicy: string
  speechPolicy: string
  templateOrigin: { id: string; version: number } | null
  status: 'active' | 'archived'
  createdAt: string
  updatedAt: string
}
interface AgentInput {
  title: string
  description: string
  promptRef: string
  modelRef: string
  llmProfileRef: string
  toolIds: string[]
  contextSources: string[]
  memoryPolicy: string
  speechPolicy: string
}
interface SessionOption { id: string; title: string; status: string }
interface PromptTemplate { ref: string; title: string; body: string; updatedAt: string }
interface ToolOption { id: string; title: string; capabilities: string[] }
interface LlmProfileOption { id: string; name: string; model: string }
interface AgentTemplate {
  id: string
  version: number
  title: string
  summary: string
  input: Omit<AgentInput, 'llmProfileRef'> & { llmProfileRef?: string }
  teamOwned?: boolean
  status?: 'active' | 'archived'
}
type ApiError = { error: string; detail: string }
const isError = (value: unknown): value is ApiError => Boolean(value && typeof value === 'object' && 'error' in value)

export const AgentManagementPage = defineComponent({
  name: 'TeamAgentManagementPage',
  setup() {
    const rpc = useRpc<{
      agentDefinitions(token: string): Promise<AgentDefinition[] | null>
      agentTemplates(token: string, includeArchived?: boolean): Promise<AgentTemplate[] | null>
      saveAgentTemplate(token: string, input: { title: string; summary: string; input: AgentInput }, id?: string): Promise<AgentTemplate | ApiError | null>
      archiveAgentTemplate(token: string, id: string): Promise<AgentTemplate | ApiError | null>
      restoreAgentTemplate(token: string, id: string): Promise<AgentTemplate | ApiError | null>
      llmProfiles(token: string): Promise<LlmProfileOption[] | null>
      promptTemplates(token: string): Promise<PromptTemplate[] | null>
      toolCatalog(token: string): Promise<ToolOption[] | null>
      savePromptTemplate(token: string, ref: string, title: string, body: string): Promise<{ ok: true; template: PromptTemplate } | ApiError | null>
      sessions(token: string): Promise<SessionOption[]>
      createAgent(token: string, input: AgentInput & { templateOrigin?: { id: string; version: number } }): Promise<AgentDefinition | ApiError | null>
      updateAgent(token: string, id: string, patch: Partial<AgentInput>): Promise<AgentDefinition | ApiError | null>
      archiveAgent(token: string, id: string): Promise<{ ok: true; definition: AgentDefinition } | ApiError | null>
      inviteAgent(token: string, sessionId: string, agentId: string): Promise<{ ok: true; joined: boolean; detail: string } | ApiError | null>
    }>()
    const token = () => localStorage.getItem('space_token') ?? ''
    const definitions = ref<AgentDefinition[]>([])
    const sessions = ref<SessionOption[]>([])
    const prompts = ref<PromptTemplate[]>([])
    const toolOptions = ref<ToolOption[]>([])
    const llmProfiles = ref<LlmProfileOption[]>([])
    const templates = ref<AgentTemplate[]>([])
    const selectedTemplate = ref('')
    const templateMeta = ref({ title: '', summary: '' })
    const templateMetaOpen = ref(false)
    const templateSaving = ref(false)
    const showArchivedTemplates = ref(false)
    const discardDialogVisible = ref(false)
    const discardDialogMessage = ref('')
    let resolveDiscardDialog: ((confirmed: boolean) => void) | undefined
    const sessionId = ref('')
    const editingId = ref('')
    const showForm = ref(false)
    const selectedAgentId = ref('')
    const menuVersion = ref(0)
    const loading = ref(false)
    const archivingId = ref('')
    const invitingId = ref('')
    const definitionsLoaded = ref(false)
    const loadFailed = ref(false)
    const loadError = ref('')
    const saving = ref(false)
    const notice = ref('')
    const failure = ref(false)
    const promptNotice = ref('')
    const promptFailure = ref(false)
    const promptSaving = ref(false)
    const activePane = ref('agents')
    const promptSelection = ref('')
    const promptForm = ref({ ref: '', title: '', body: '' })
    const promptSaved = ref({ ref: '', title: '', body: '' })
    const promptVersion = ref(0)
    const form = ref<AgentInput>({
      title: '', description: '', promptRef: '', modelRef: '', llmProfileRef: '', toolIds: [],
      contextSources: ['session', 'agent-memory', 'team-kb'],
      memoryPolicy: 'agent', speechPolicy: 'passive',
    })

    const flash = (message: string, failed = false) => {
      notice.value = message
      failure.value = failed
    }
    const agentInputReady = () => Boolean(form.value.title.trim() && form.value.description.trim())
    const blankAgentInput = (): AgentInput => ({
      title: '', description: '', promptRef: '', modelRef: '', llmProfileRef: '', toolIds: [],
      contextSources: ['session', 'agent-memory', 'team-kb'], memoryPolicy: 'agent', speechPolicy: 'passive',
    })
    const definitionInput = (def: AgentDefinition): AgentInput => ({
      title: def.title, description: def.description, promptRef: def.promptRef, modelRef: def.modelRef,
      llmProfileRef: def.llmProfileRef || '', toolIds: [...def.toolIds], contextSources: [...def.contextSources],
      memoryPolicy: def.memoryPolicy, speechPolicy: def.speechPolicy,
    })
    const isDirty = () => {
      if (editingId.value) {
        const def = definitions.value.find((item) => item.id === editingId.value)
        return Boolean(def && JSON.stringify(form.value) !== JSON.stringify(definitionInput(def)))
      }
      const blank = blankAgentInput()
      return JSON.stringify(form.value) !== JSON.stringify(blank) || Boolean(selectedTemplate.value || templateMeta.value.title || templateMeta.value.summary)
    }
    function askDiscard(message: string): Promise<boolean> {
      discardDialogMessage.value = message
      discardDialogVisible.value = true
      return new Promise((resolve) => { resolveDiscardDialog = resolve })
    }
    function finishDiscard(confirmed: boolean) {
      discardDialogVisible.value = false
      if (!confirmed) {
        menuVersion.value += 1
        promptVersion.value += 1
      }
      const resolve = resolveDiscardDialog
      resolveDiscardDialog = undefined
      resolve?.(confirmed)
    }
    async function confirmDiscard() {
      if (!showForm.value || !isDirty()) return true
      return askDiscard('当前 Agent 配置尚未保存。切换后将丢失这些修改。')
    }
    async function selectAgent(id: string) {
      if (id === editingId.value) return
      const def = definitions.value.find((item) => item.id === id)
      if (!def || !await confirmDiscard()) return
      edit(def)
    }
    async function startNewAgent() {
      if (!await confirmDiscard()) return
      reset()
      selectedAgentId.value = ''
      showForm.value = true
    }
    const templateInputReady = () => agentInputReady() &&
      Boolean(templateMeta.value.title.trim() && templateMeta.value.summary.trim())
    const reset = () => {
      editingId.value = ''
      showForm.value = false
      selectedTemplate.value = ''
      templateMeta.value = { title: '', summary: '' }
      templateMetaOpen.value = false
      form.value = {
        title: '', description: '', promptRef: '', modelRef: '', llmProfileRef: '', toolIds: [],
        contextSources: ['session', 'agent-memory', 'team-kb'],
        memoryPolicy: 'agent', speechPolicy: 'passive',
      }
    }
    async function refresh() {
      loading.value = true
      loadFailed.value = false
      loadError.value = ''
      try {
        const [defs, allSessions, promptRows, registeredTools, templateRows, modelRows] = await Promise.all([
          rpc.value.agentDefinitions(token()), rpc.value.sessions(token()), rpc.value.promptTemplates(token()),
          rpc.value.toolCatalog(token()), rpc.value.agentTemplates(token(), true), rpc.value.llmProfiles(token()),
        ])
        if (!defs || !promptRows || !registeredTools || !templateRows || !modelRows) { window.location.assign('/login'); return }
        definitions.value = defs
        definitionsLoaded.value = true
        if (!defs.some((item) => item.id === selectedAgentId.value)) selectedAgentId.value = defs[0]?.id ?? ''
        if (!showForm.value && !editingId.value && selectedAgentId.value) {
          const selected = defs.find((item) => item.id === selectedAgentId.value)
          if (selected) edit(selected)
        }
        prompts.value = promptRows
        toolOptions.value = registeredTools
        templates.value = templateRows
        llmProfiles.value = modelRows
        sessions.value = allSessions.filter((s) => s.status === 'open')
        if (!sessionId.value && sessions.value.length) sessionId.value = sessions.value[0]!.id
      } catch {
        loadFailed.value = true
        loadError.value = userFacingFailure('加载团队 Agent')
      } finally { loading.value = false }
    }
    function edit(def: AgentDefinition) {
      selectedAgentId.value = def.id
      editingId.value = def.id
      showForm.value = true
      selectedTemplate.value = ''
      form.value = definitionInput(def)
      notice.value = ''
    }
    function cancelChanges() {
      const selected = definitions.value.find((item) => item.id === editingId.value)
      if (selected) edit(selected)
      else reset()
    }
    function applyTemplate(id: string) {
      selectedTemplate.value = id
      const template = templates.value.find((item) => item.id === id)
      if (!template || editingId.value) return
      templateMeta.value = { title: template.title, summary: template.summary }
      form.value = {
        ...template.input,
        llmProfileRef: template.input.llmProfileRef ?? '',
        toolIds: template.input.toolIds.filter((toolId) => toolOptions.value.some((tool) => tool.id === toolId)),
        contextSources: [...template.input.contextSources],
      }
    }
    async function save() {
      if (saving.value) return
      if (!agentInputReady()) {
        flash('请填写 Agent 名称和职责说明后再保存', true)
        return
      }
      const selected = templates.value.find((template) => template.id === selectedTemplate.value)
      if (!editingId.value && selected?.status === 'archived') {
        flash('归档模板不能用于创建 Agent，请先恢复模板或选择其他模板', true)
        return
      }
      saving.value = true
      try {
        const payload: AgentInput = { ...form.value }
        const result = editingId.value
          ? await rpc.value.updateAgent(token(), editingId.value, payload)
          : await rpc.value.createAgent(token(), {
            ...payload,
            templateOrigin: templates.value.find((template) => template.id === selectedTemplate.value)
              ? { id: selectedTemplate.value, version: templates.value.find((template) => template.id === selectedTemplate.value)!.version }
              : undefined,
          })
        if (!result) { window.location.assign('/login'); return }
        if (isError(result)) { flash(result.detail || result.error, true); return }
        const wasEditing = Boolean(editingId.value)
        flash(wasEditing ? '共享 Agent 配置已更新' : '共享 Agent 已创建；它尚未加入任何会话')
        if (!wasEditing) selectedAgentId.value = result.id
        else editingId.value = result.id
        await refresh()
      } catch { flash(userFacingFailure(editingId.value ? '保存 Agent 配置' : '创建 Agent'), true) }
      finally { saving.value = false }
    }
    async function saveTemplate(asNew: boolean) {
      if (templateSaving.value) return
      if (!templateInputReady()) {
        flash('请填写 Agent 名称、职责说明、模板名称和模板说明后再保存', true)
        return
      }
      templateSaving.value = true
      try {
        const selected = templates.value.find((item) => item.id === selectedTemplate.value)
        const id = !asNew && selected?.teamOwned ? selected.id : undefined
        if (selected?.status === 'archived' && id) { flash('归档模板不能追加版本，请先恢复', true); return }
        const result = await rpc.value.saveAgentTemplate(token(), {
          title: templateMeta.value.title,
          summary: templateMeta.value.summary,
          input: { ...form.value },
        }, id)
        if (!result) { window.location.assign('/login'); return }
        if (isError(result)) { flash(result.detail || result.error, true); return }
        selectedTemplate.value = result.id
        templateMeta.value = { title: result.title, summary: result.summary }
        flash(`团队模板「${result.title}」已保存为 v${result.version}`)
        await refresh()
      } catch { flash(userFacingFailure('保存团队模板'), true) }
      finally { templateSaving.value = false }
    }
    async function setTemplateArchived(restore: boolean) {
      const selected = templates.value.find((item) => item.id === selectedTemplate.value)
      if (!selected?.teamOwned || templateSaving.value) return
      templateSaving.value = true
      try {
        const result = restore
          ? await rpc.value.restoreAgentTemplate(token(), selected.id)
          : await rpc.value.archiveAgentTemplate(token(), selected.id)
        if (!result) { window.location.assign('/login'); return }
        if (isError(result)) { flash(result.detail || result.error, true); return }
        flash(restore ? `已恢复团队模板「${result.title}」` : `已归档团队模板「${result.title}」`)
        await refresh()
      } catch { flash(userFacingFailure(restore ? '恢复团队模板' : '归档团队模板'), true) }
      finally { templateSaving.value = false }
    }
    async function archive(def: AgentDefinition) {
      if (archivingId.value || invitingId.value) return
      archivingId.value = def.id
      try {
        const result = await rpc.value.archiveAgent(token(), def.id)
        if (!result) { window.location.assign('/login'); return }
        if (isError(result)) { flash(result.detail || result.error, true); return }
        flash(`已归档「${def.title}」`)
        if (editingId.value === def.id) reset()
        await refresh()
      } catch { flash(userFacingFailure('归档 Agent'), true) }
      finally { archivingId.value = '' }
    }
    async function invite(def: AgentDefinition) {
      if (!sessionId.value || invitingId.value || archivingId.value) return
      invitingId.value = def.id
      try {
        const result = await rpc.value.inviteAgent(token(), sessionId.value, def.id)
        if (!result) { window.location.assign('/login'); return }
        if (isError(result)) { flash(result.detail || result.error, true); return }
        flash(result.detail)
      } catch { flash(userFacingFailure('邀请 Agent 加入会话'), true) }
      finally { invitingId.value = '' }
    }
    const isPromptDirty = () => JSON.stringify(promptForm.value) !== JSON.stringify(promptSaved.value)
    const promptInputReady = () => Boolean(promptForm.value.ref.trim() && promptForm.value.title.trim() && promptForm.value.body.trim())
    const promptHasContent = () => Boolean(promptForm.value.ref.trim() || promptForm.value.title.trim() || promptForm.value.body.trim())
    function selectPrompt(refId: string) {
      promptSelection.value = refId
      const template = prompts.value.find((item) => item.ref === refId)
      const next = template
        ? { ref: template.ref, title: template.title, body: template.body }
        : { ref: refId, title: '', body: '' }
      promptForm.value = next
      promptSaved.value = { ...next }
      promptNotice.value = ''
      promptFailure.value = false
    }
    async function requestPromptSelection(refId: string) {
      if (refId === promptSelection.value) return
      if (isPromptDirty() && !await askDiscard('当前共享提示词尚未保存。切换后将丢失这些修改。')) return
      selectPrompt(refId)
    }
    async function savePrompt() {
      if (promptSaving.value) return
      if (!promptInputReady()) {
        promptFailure.value = true
        promptNotice.value = '请填写稳定 ref、模板名称和提示词正文后再保存'
        return
      }
      if (promptSelection.value && !isPromptDirty()) return
      promptSaving.value = true
      promptNotice.value = ''
      try {
        const result = await rpc.value.savePromptTemplate(token(), promptForm.value.ref,
          promptForm.value.title, promptForm.value.body)
        if (!result) { window.location.assign('/login'); return }
        if (isError(result)) { promptFailure.value = true; promptNotice.value = result.detail || result.error; return }
        promptFailure.value = false
        promptNotice.value = `已保存团队共享提示词「${result.template.title}」`
        await refresh()
        selectPrompt(result.template.ref)
      } catch {
        promptFailure.value = true
        promptNotice.value = userFacingFailure('保存共享提示词')
      } finally { promptSaving.value = false }
    }
    onMounted(() => { void refresh() })

    return () => {
      const ElButton = resolveComponent('el-button') as unknown as string
      const ElCard = resolveComponent('el-card') as unknown as string
      const ElForm = resolveComponent('el-form') as unknown as string
      const ElInput = resolveComponent('el-input') as unknown as string
      const ElSelect = resolveComponent('el-select') as unknown as string
      const ElOption = resolveComponent('el-option') as unknown as string
      const ElSpace = resolveComponent('el-space') as unknown as string
      const ElText = resolveComponent('el-text') as unknown as string
      const ElTag = resolveComponent('el-tag') as unknown as string
      const ElEmpty = resolveComponent('el-empty') as unknown as string
      const ElAlert = resolveComponent('el-alert') as unknown as string
      const ElRow = resolveComponent('el-row') as unknown as string
      const ElDivider = resolveComponent('el-divider') as unknown as string
      const ElDialog = resolveComponent('el-dialog') as unknown as string
      const ElPopconfirm = resolveComponent('el-popconfirm') as unknown as string
      const ElTabs = resolveComponent('el-tabs') as unknown as string
      const ElTabPane = resolveComponent('el-tab-pane') as unknown as string
      const ElMenu = resolveComponent('el-menu') as unknown as string
      const ElMenuItem = resolveComponent('el-menu-item') as unknown as string
      const ElCol = resolveComponent('el-col') as unknown as string
      const ElMain = resolveComponent('el-main') as unknown as string
      const ElScrollbar = resolveComponent('el-scrollbar') as unknown as string
      const KLayout = resolveComponent('k-layout') as unknown as string
      const field = (label: string, control: VNodeChild, className = '') => h('div', { key: label, class: `sp-agent-field ${className}` }, [
        h(ElText, { tag: 'label', size: 'small' }, { default: () => label }), control,
      ])
      const groupBreak = (title: string) => h(ElDivider, {
        class: 'sp-agent-field--wide', contentPosition: 'left',
      }, { default: () => title })
      const archiveAction = (def: AgentDefinition) => h(ElPopconfirm, {
        title: `归档「${def.title}」后，它将不再出现在可邀请目录中。`,
        confirmButtonText: '归档 Agent', cancelButtonText: '取消',
        onConfirm: () => void archive(def),
      }, {
        reference: () => h(ElButton, {
          text: true, type: 'danger', size: 'small', loading: archivingId.value === def.id,
          disabled: Boolean(archivingId.value || invitingId.value || saving.value || templateSaving.value),
        }, { default: () => '归档' }),
      })
      const saveAction = () => editingId.value && !isDirty()
        ? h(ElTag, { size: 'small', type: 'success', effect: 'plain' }, { default: () => '已保存' })
        : h(ElButton, {
          type: isDirty() ? 'primary' : 'default', text: !isDirty(), size: 'small', loading: saving.value,
          disabled: saving.value || templateSaving.value || !agentInputReady() || (Boolean(editingId.value) && !isDirty()),
          onClick: () => void save(),
        }, { default: () => editingId.value ? '保存更改' : '创建 Agent' })
      const inviteAction = () => h(ElButton, {
        size: 'small', loading: invitingId.value === editingId.value,
        disabled: !sessionId.value || Boolean(invitingId.value || archivingId.value || saving.value || templateSaving.value),
        onClick: () => { const def = definitions.value.find((item) => item.id === editingId.value); if (def) void invite(def) },
      }, { default: () => '邀请入会' })
      const formCard = h(ElCard, { shadow: 'never', class: 'sp-agent-form-card' }, {
        header: () => h(ElRow, { justify: 'space-between', align: 'middle', class: 'sp-agent-form-header' }, {
          default: () => [
            h('div', { class: 'sp-agent-form-title' }, [
              h(ElText, { tag: 'strong' }, { default: () => editingId.value
                ? `配置 Agent · ${form.value.title}` : '创建团队共享 Agent' }),
              isDirty() ? h(ElTag, { size: 'small', type: 'warning', effect: 'plain' }, { default: () => '未保存' }) : null,
            ]),
            h(ElSpace, { wrap: true, size: 6, class: 'sp-agent-form-header-actions' }, { default: () => [
              editingId.value && definitions.value.find((item) => item.id === editingId.value)
                ? archiveAction(definitions.value.find((item) => item.id === editingId.value)!) : null,
              isDirty() ? h(ElButton, { text: true, size: 'small', disabled: saving.value || templateSaving.value, onClick: cancelChanges }, { default: () => '撤销修改' }) : null,
              saveAction(),
              editingId.value ? inviteAction() : null,
            ] }),
          ],
        }),
        default: () => h(ElForm, { class: 'sp-agent-form-content', disabled: saving.value || templateSaving.value }, { default: () => [
          h('div', { class: 'sp-agent-form-grid' }, [
            groupBreak(editingId.value ? '角色信息' : '角色与模板'),
            !editingId.value ? field('创建模板', h(ElSelect, { modelValue: selectedTemplate.value,
              'onUpdate:modelValue': (v: string) => applyTemplate(v), placeholder: '从通用模板开始，也可直接填写' }, {
              default: () => templates.value.filter((item) => showArchivedTemplates.value || item.status !== 'archived').map((item) => h(ElOption, { key: item.id,
                label: `${item.status === 'archived' ? '已归档 · ' : ''}${item.title} v${item.version}：${item.summary}`, value: item.id })),
            }), 'sp-agent-field--wide') : null,
            !editingId.value ? h('div', { class: 'sp-agent-template-actions sp-agent-field--wide' }, h(ElSpace, {}, { default: () => [
              h(ElButton, { text: true, onClick: () => { showArchivedTemplates.value = !showArchivedTemplates.value } }, {
                default: () => showArchivedTemplates.value ? '隐藏归档模板' : '显示归档模板',
              }),
              !selectedTemplate.value || !templates.value.find((item) => item.id === selectedTemplate.value)?.teamOwned ? null
                : templates.value.find((item) => item.id === selectedTemplate.value)?.status === 'archived'
                  ? h(ElButton, { text: true, type: 'primary', loading: templateSaving.value, disabled: saving.value || templateSaving.value, onClick: () => void setTemplateArchived(true) }, { default: () => '恢复所选模板' })
                  : h(ElPopconfirm, { title: '归档后会从 Agent 新建模板列表隐藏；现有 Agent 的来源记录和历史版本会保留。',
                    confirmButtonText: '归档模板', cancelButtonText: '取消', onConfirm: () => void setTemplateArchived(false) }, {
                    reference: () => h(ElButton, { text: true, type: 'danger', loading: templateSaving.value, disabled: saving.value || templateSaving.value }, { default: () => '归档所选模板' }),
                  }),
            ] })) : null,
            field('Agent 名称（必填）', h(ElInput, { modelValue: form.value.title, maxlength: 80, showWordLimit: true,
              'onUpdate:modelValue': (v: string) => { form.value.title = v }, placeholder: '例如：需求分析助手' })),
            field('职责说明（必填）', h(ElInput, { modelValue: form.value.description, type: 'textarea', rows: 3,
              'onUpdate:modelValue': (v: string) => { form.value.description = v }, placeholder: '说明 Agent 的目标、工作方式和输出要求' })),
            groupBreak('模型与提示词'),
            field('团队共享提示词', h(ElSelect, { modelValue: form.value.promptRef,
              'onUpdate:modelValue': (v: string) => { form.value.promptRef = v }, placeholder: '选择提示词模板', clearable: true }, {
              default: () => prompts.value.map((item) => h(ElOption, { key: item.ref, label: `${item.title}（${item.ref}）`, value: item.ref })),
            })),
            field('文字模型供应商', h(ElSelect, { modelValue: form.value.llmProfileRef,
              'onUpdate:modelValue': (v: string) => { form.value.llmProfileRef = v }, placeholder: '留空使用后台系统默认', clearable: true }, {
              default: () => llmProfiles.value.map((item) => h(ElOption, { key: item.id,
                label: `${item.name}（${item.id} · ${item.model}）`, value: item.id })),
            })),
            field('供应商内模型 ID 覆盖（可选）', h(ElInput, { modelValue: form.value.modelRef,
              'onUpdate:modelValue': (v: string) => { form.value.modelRef = v }, placeholder: '留空使用所选供应商配置中的模型 ID' }), 'sp-agent-field--wide'),
            groupBreak('工具与上下文'),
            field('可用工具', h(ElSelect, { modelValue: form.value.toolIds, multiple: true, filterable: true,
              'onUpdate:modelValue': (v: string[]) => { form.value.toolIds = v }, placeholder: '选择已注册的工具' }, {
              default: () => toolOptions.value.map((item) => h(ElOption, { key: item.id,
                label: `${item.title}（${item.id}）`, value: item.id })),
            })),
            field('上下文来源', h(ElSelect, { modelValue: form.value.contextSources, multiple: true,
              'onUpdate:modelValue': (v: string[]) => { form.value.contextSources = v }, placeholder: '选择上下文来源' }, {
              default: () => [
                h(ElOption, { label: '当前会话', value: 'session' }),
                h(ElOption, { label: 'Agent 记忆库', value: 'agent-memory' }),
                h(ElOption, { label: '团队知识库', value: 'team-kb' }),
              ],
            })),
            groupBreak('记忆与发言策略'),
            field('记忆策略', h(ElSelect, { modelValue: form.value.memoryPolicy,
              'onUpdate:modelValue': (v: string) => { form.value.memoryPolicy = v } }, {
              default: () => [h(ElOption, { label: '独立 Agent 记忆', value: 'agent' }), h(ElOption, { label: '不写入记忆', value: 'none' })],
            })),
            field('发言策略', h(ElSelect, { modelValue: form.value.speechPolicy,
              'onUpdate:modelValue': (v: string) => { form.value.speechPolicy = v } }, {
              default: () => [h(ElOption, { label: '仅被 @ 时回复', value: 'passive' }), h(ElOption, { label: '允许主动发言', value: 'proactive' })],
            })),
            !editingId.value ? h('div', { class: 'sp-agent-field--wide sp-agent-template-toggle' }, h(ElButton, {
              text: true, type: 'primary', onClick: () => { templateMetaOpen.value = !templateMetaOpen.value },
            }, { default: () => templateMetaOpen.value ? '收起模板保存设置' : '＋ 设置团队模板（可选）' })) : null,
            !editingId.value && templateMetaOpen.value ? groupBreak('另存为团队模板') : null,
            !editingId.value && templateMetaOpen.value ? h('div', { class: 'sp-agent-field--wide sp-agent-template-note' },
              '只有另存模板时才需要填写名称和说明。') : null,
            !editingId.value && templateMetaOpen.value ? field('模板名称（保存模板时必填）', h(ElInput, { modelValue: templateMeta.value.title,
              'onUpdate:modelValue': (v: string) => { templateMeta.value.title = v }, placeholder: '例如：发布验收助手' })) : null,
            !editingId.value && templateMetaOpen.value ? field('模板说明（保存模板时必填）', h(ElInput, { modelValue: templateMeta.value.summary, maxlength: 240,
              'onUpdate:modelValue': (v: string) => { templateMeta.value.summary = v }, placeholder: '简要说明这个模板适合什么工作' })) : null,
          ]),
          !editingId.value && templateMetaOpen.value ? h('div', { class: 'sp-agent-form-actions' }, h(ElSpace, {}, { default: () => [
              !editingId.value ? h(ElButton, { loading: templateSaving.value, disabled: saving.value || templateSaving.value || !templateInputReady(), onClick: () => void saveTemplate(true) }, { default: () => '另存为团队模板' }) : null,
              !editingId.value && templates.value.find((item) => item.id === selectedTemplate.value)?.teamOwned &&
                templates.value.find((item) => item.id === selectedTemplate.value)?.status !== 'archived'
                ? h(ElButton, { loading: templateSaving.value, disabled: saving.value || templateSaving.value || !templateInputReady(), onClick: () => void saveTemplate(false) }, { default: () => '保存为所选模板新版本' }) : null,
            ] })) : null,
        ] }),
      })
      const catalog = !definitionsLoaded.value && loading.value
        ? h(ElEmpty, { description: '正在加载 Agent、提示词、工具和模型配置…', imageSize: 60 })
        : !definitionsLoaded.value && loadFailed.value
          ? h('div', { class: 'sp-agent-load-error' }, [
            h(ElAlert, { title: loadError.value, type: 'error', showIcon: true, closable: false }),
            h(ElButton, { type: 'primary', loading: loading.value, onClick: () => void refresh() }, { default: () => '重试加载' }),
          ])
        : definitions.value.length
          ? h(ElCard, { shadow: 'never', class: 'sp-agent-list-card' }, {
            header: () => h('div', { class: 'sp-agent-catalog-head' }, [
              h(ElText, { tag: 'strong', class: 'sp-agent-catalog-count' }, { default: () => `Agent 列表 · ${definitions.value.length}` }),
            ]),
            default: () => h(ElMenu, {
              key: `${selectedAgentId.value}:${menuVersion.value}`,
              class: 'sp-agent-menu', defaultActive: selectedAgentId.value,
              onSelect: (id: string) => { void selectAgent(id) },
            }, { default: () => definitions.value.map((def) => h(ElMenuItem, {
              key: def.id, index: def.id, disabled: saving.value || templateSaving.value,
            }, { default: () => [
              h('div', { class: 'sp-agent-menu-item' }, [
                h('div', { class: 'sp-agent-menu-copy' }, [
                  h(ElText, { tag: 'strong', truncated: true }, { default: () => def.title }),
                  h(ElText, { type: 'info', size: 'small', truncated: true, title: def.description }, {
                    default: () => def.description.replaceAll(/\s+/g, ' ').trim(),
                  }),
                ]),
                h(ElTag, { size: 'small', type: def.speechPolicy === 'proactive' ? 'success' : 'info' }, {
                  default: () => def.speechPolicy === 'proactive' ? '主动发言' : '仅 @ 时回复',
                }),
              ]),
            ] })) }),
          })
          : h(ElEmpty, { description: '还没有团队共享 Agent，可以先创建一个' })
      const selectedDefinition = definitions.value.find((item) => item.id === selectedAgentId.value)
      const detailPlaceholder = h(ElEmpty, {
        description: selectedDefinition ? '正在打开 Agent 配置…' : '从左侧选择 Agent，或新建一个团队共享 Agent。',
        imageSize: 72,
      })

      const promptTemplateMenu = h(ElMenu, {
        key: `${promptSelection.value}:${promptVersion.value}`,
        class: 'sp-agent-prompt-menu', defaultActive: promptSelection.value,
        onSelect: (refId: string) => { void requestPromptSelection(refId) },
      }, { default: () => prompts.value.map((item) => h(ElMenuItem, {
        key: item.ref, index: item.ref,
      }, { default: () => h('div', { class: 'sp-agent-prompt-menu-item' }, [
        h(ElText, { tag: 'strong', truncated: true }, { default: () => item.title }),
        h(ElText, { type: 'info', size: 'small' }, { default: () => item.ref }),
      ]) })) })
      const promptEditor = h('section', { class: 'sp-agent-prompt-editor' }, [
        h('div', { class: 'sp-agent-form-grid' }, [
          field('稳定 ref', h(ElInput, { modelValue: promptForm.value.ref,
            'onUpdate:modelValue': (v: string) => { promptForm.value.ref = v; promptNotice.value = ''; promptFailure.value = false }, placeholder: '例如 prompt.research' })),
          field('模板名称', h(ElInput, { modelValue: promptForm.value.title,
            'onUpdate:modelValue': (v: string) => { promptForm.value.title = v; promptNotice.value = ''; promptFailure.value = false }, placeholder: '给团队看的名称' })),
          field('提示词正文', h(ElInput, { modelValue: promptForm.value.body, type: 'textarea', rows: 10,
            'onUpdate:modelValue': (v: string) => { promptForm.value.body = v; promptNotice.value = ''; promptFailure.value = false }, placeholder: '定义 Agent 的目标、边界、工作步骤和回答格式' }), 'sp-agent-field--wide'),
        ]),
        h(ElRow, { justify: 'space-between', align: 'middle', class: 'sp-agent-prompt-actions' }, [
          promptNotice.value ? h(ElText, { type: promptFailure.value ? 'danger' : 'success' }, { default: () => promptNotice.value })
            : h(ElText, { type: isPromptDirty() ? 'warning' : 'info' }, { default: () => isPromptDirty() ? '有未保存修改' : promptSelection.value ? '已保存' : '填写后保存' }),
          h(ElButton, { type: 'primary', loading: promptSaving.value, disabled: promptSaving.value || !promptHasContent() || (Boolean(promptSelection.value) && !isPromptDirty()), onClick: () => void savePrompt() }, {
            default: () => promptSelection.value ? (isPromptDirty() ? '保存更改' : '已保存') : '保存共享提示词',
          }),
        ]),
      ])
      const agentPane = h(ElTabPane, { label: 'Agent 管理', name: 'agents' }, {
        default: () => h('div', { class: 'sp-agent-workspace' }, [
          notice.value ? h('div', { class: `sp-agent-notice${failure.value ? ' is-error' : ''}` },
            h(ElText, { type: failure.value ? 'danger' : 'success' }, { default: () => notice.value })) : null,
          h('section', { class: 'sp-agent-directory' }, [
            h('div', { class: 'sp-agent-section-head' }, [
              h('div', { class: 'sp-agent-selection-hint' }, [
                h(ElText, { type: 'info' }, { default: () => '选择角色即可直接编辑配置' }),
              ]),
              h(ElSpace, { wrap: true, class: 'sp-agent-directory-actions' }, { default: () => [
                h(ElSelect, { class: 'sp-agent-session-select', modelValue: sessionId.value,
                  disabled: Boolean(invitingId.value), 'onUpdate:modelValue': (v: string) => { sessionId.value = v },
                  placeholder: '选择会话', 'aria-label': '选择邀请目标会话', clearable: true }, {
                  default: () => sessions.value.map((s) => h(ElOption, { key: s.id, label: s.title, value: s.id })),
                }),
                h(ElButton, { type: 'primary', onClick: () => void startNewAgent() }, { default: () => '新建 Agent' }),
              ] }),
            ]),
            loading.value && definitionsLoaded.value
              ? h('div', { class: 'sp-hint', role: 'status' }, '正在刷新 Agent 目录…仍可继续查看已加载内容。')
              : null,
            loadError.value && definitionsLoaded.value
              ? h(ElAlert, { title: `${loadError.value} 当前仍显示上次加载的数据。`, type: 'error', showIcon: true, closable: true,
                  onClose: () => { loadError.value = '' } })
              : null,
            h(ElRow, { gutter: 16, class: 'sp-agent-master-detail' }, [
              h(ElCol, { span: 8, class: 'sp-agent-master-column' }, catalog),
              h(ElCol, { span: 16, class: 'sp-agent-detail-column' },
                showForm.value ? formCard : detailPlaceholder),
            ]),
          ]),
        ]),
      })
      const promptPane = h(ElTabPane, { label: '共享提示词', name: 'prompts' }, {
        default: () => h(ElRow, { gutter: 20, class: 'sp-agent-prompt-layout' }, [
          h(ElCol, { span: 5, class: 'sp-agent-prompt-directory' }, [
            h(ElRow, { justify: 'space-between', align: 'middle', class: 'sp-agent-prompt-directory-head' }, [
              h(ElText, { tag: 'strong' }, { default: () => `共享提示词 · ${prompts.value.length}` }),
              h(ElButton, { text: true, type: 'primary', disabled: promptSaving.value, onClick: () => { void requestPromptSelection('') } }, {
                default: () => '新建',
              }),
            ]),
            promptTemplateMenu,
          ]),
          h(ElCol, { span: 19, class: 'sp-agent-prompt-main' }, [
            h('div', { class: 'sp-agent-section-head' }, [
              h('div', {}, [
                h('div', { class: 'sp-agent-prompt-title' }, [
                  h(ElText, { tag: 'h2' }, { default: () => promptSelection.value ? '编辑共享提示词' : '新建共享提示词' }),
                  isPromptDirty() ? h(ElTag, { size: 'small', type: 'warning', effect: 'plain' }, { default: () => '未保存' }) : null,
                ]),
                h(ElText, { type: 'info' }, { default: () => 'Agent 通过稳定 ref 引用提示词；保存已有模板会追加新版本。' }),
              ]),
            ]),
            promptEditor,
          ]),
        ]),
      })

      return h(KLayout, { main: 'page-teamspace-agents', class: 'sp-team-layout' }, {
        header: () => h(ElRow, { justify: 'space-between', align: 'middle' }, [
          h(ElText, { tag: 'strong' }, { default: () => '团队空间' }),
          h(ElButton, { text: true, onClick: () => window.location.assign('/teamspace') }, { default: () => '返回会话' }),
        ]),
        default: () => [
          h(ThemeStyle),
          h(ElMain, { class: ['sp-agent-page', 'sp-agent-directory-page'] }, { default: () => h(ElScrollbar, {}, { default: () => h('div', { class: 'sp-agent-page-inner' }, [
            h('header', { class: 'sp-agent-page-head' }, [
              h('div', {}, [
                h(ElText, { tag: 'h1' }, { default: () => '团队共享 Agent' }),
                h(ElText, { class: 'sp-agent-page-description', type: 'info' }, { default: () => '统一配置团队 Agent 的职责、模型、工具、记忆与发言方式。创建后再邀请加入会话。' }),
              ]),
              h(ElTag, { class: 'sp-agent-page-badge', type: 'info', effect: 'plain' }, { default: () => '团队共享资源' }),
            ]),
            h(ElTabs, {
              class: 'sp-agent-tabs', modelValue: activePane.value,
              'onUpdate:modelValue': (value: string) => { activePane.value = value },
            }, { default: () => [agentPane, promptPane] }),
            h(ElDialog, {
              modelValue: discardDialogVisible.value,
              'onUpdate:modelValue': (visible: boolean) => { if (!visible) finishDiscard(false) },
              title: '放弃未保存修改？', width: '420px',
            }, {
              default: () => h(ElText, null, { default: () => discardDialogMessage.value }),
              footer: () => h(ElSpace, null, { default: () => [
                h(ElButton, { onClick: () => finishDiscard(false) }, { default: () => '继续编辑' }),
                h(ElButton, { type: 'primary', onClick: () => finishDiscard(true) }, { default: () => '放弃并切换' }),
              ] }),
            }),
          ]) }) }),
        ],
      })
    }
  },
})

export const AGENT_PAGE_ICON = ICONS.agents
