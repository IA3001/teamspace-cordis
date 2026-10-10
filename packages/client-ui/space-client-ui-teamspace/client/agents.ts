// Team-shared Agent catalog editor. Definitions are configurable data and run
// through the shared Agent runtime; no per-definition plugin is required.
import { defineComponent, h, onMounted, ref, resolveComponent } from 'vue'
import type { VNodeChild } from 'vue'
import { useRpc } from '@cordisjs/client'
import { ThemeStyle } from 'space-client-ui-shared/client/theme.ts'

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
interface AgentTemplate { id: string; version: number; title: string; summary: string; input: Omit<AgentInput, 'llmProfileRef'> & { llmProfileRef?: string } }
type ApiError = { error: string; detail: string }
const isError = (value: unknown): value is ApiError => Boolean(value && typeof value === 'object' && 'error' in value)

export const AgentManagementPage = defineComponent({
  name: 'TeamAgentManagementPage',
  setup() {
    const rpc = useRpc<{
      agentDefinitions(token: string): Promise<AgentDefinition[] | null>
      agentTemplates(token: string): Promise<AgentTemplate[] | null>
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
    const sessionId = ref('')
    const editingId = ref('')
    const loading = ref(false)
    const saving = ref(false)
    const notice = ref('')
    const failure = ref(false)
    const promptNotice = ref('')
    const promptFailure = ref(false)
    const promptSaving = ref(false)
    const promptSelection = ref('')
    const promptForm = ref({ ref: '', title: '', body: '' })
    const form = ref<AgentInput>({
      title: '', description: '', promptRef: '', modelRef: '', llmProfileRef: '', toolIds: [],
      contextSources: ['session', 'agent-memory', 'team-kb'],
      memoryPolicy: 'agent', speechPolicy: 'passive',
    })

    const flash = (message: string, failed = false) => {
      notice.value = message
      failure.value = failed
    }
    const reset = () => {
      editingId.value = ''
      selectedTemplate.value = ''
      form.value = {
        title: '', description: '', promptRef: '', modelRef: '', llmProfileRef: '', toolIds: [],
        contextSources: ['session', 'agent-memory', 'team-kb'],
        memoryPolicy: 'agent', speechPolicy: 'passive',
      }
    }
    async function refresh() {
      loading.value = true
      try {
        const [defs, allSessions, promptRows, registeredTools, templateRows, modelRows] = await Promise.all([
          rpc.value.agentDefinitions(token()), rpc.value.sessions(token()), rpc.value.promptTemplates(token()),
          rpc.value.toolCatalog(token()), rpc.value.agentTemplates(token()), rpc.value.llmProfiles(token()),
        ])
        if (!defs || !promptRows || !registeredTools || !templateRows || !modelRows) { window.location.assign('/login'); return }
        definitions.value = defs
        prompts.value = promptRows
        toolOptions.value = registeredTools
        templates.value = templateRows
        llmProfiles.value = modelRows
        sessions.value = allSessions.filter((s) => s.status === 'open')
        if (!sessionId.value && sessions.value.length) sessionId.value = sessions.value[0]!.id
      } catch (e) {
        flash(`加载失败：${(e as Error).message}`, true)
      } finally { loading.value = false }
    }
    function edit(def: AgentDefinition) {
      editingId.value = def.id
      selectedTemplate.value = ''
      form.value = {
        title: def.title, description: def.description, promptRef: def.promptRef,
        modelRef: def.modelRef, llmProfileRef: def.llmProfileRef || '', toolIds: [...def.toolIds], contextSources: [...def.contextSources],
        memoryPolicy: def.memoryPolicy, speechPolicy: def.speechPolicy,
      }
      notice.value = ''
    }
    function applyTemplate(id: string) {
      selectedTemplate.value = id
      const template = templates.value.find((item) => item.id === id)
      if (!template || editingId.value) return
      form.value = {
        ...template.input,
        llmProfileRef: template.input.llmProfileRef ?? '',
        toolIds: template.input.toolIds.filter((toolId) => toolOptions.value.some((tool) => tool.id === toolId)),
        contextSources: [...template.input.contextSources],
      }
    }
    async function save() {
      if (saving.value) return
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
        flash(editingId.value ? '共享 Agent 配置已更新' : '共享 Agent 已创建；它尚未加入任何会话')
        reset()
        await refresh()
      } catch (e) { flash(`保存失败：${(e as Error).message}`, true) }
      finally { saving.value = false }
    }
    async function archive(def: AgentDefinition) {
      const result = await rpc.value.archiveAgent(token(), def.id)
      if (!result) { window.location.assign('/login'); return }
      if (isError(result)) { flash(result.detail || result.error, true); return }
      flash(`已归档「${def.title}」`)
      if (editingId.value === def.id) reset()
      await refresh()
    }
    async function invite(def: AgentDefinition) {
      if (!sessionId.value) return
      const result = await rpc.value.inviteAgent(token(), sessionId.value, def.id)
      if (!result) { window.location.assign('/login'); return }
      if (isError(result)) { flash(result.detail || result.error, true); return }
      flash(result.detail)
    }
    function selectPrompt(refId: string) {
      promptSelection.value = refId
      const template = prompts.value.find((item) => item.ref === refId)
      promptForm.value = template
        ? { ref: template.ref, title: template.title, body: template.body }
        : { ref: refId, title: '', body: '' }
    }
    async function savePrompt() {
      if (promptSaving.value) return
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
      } catch (e) {
        promptFailure.value = true
        promptNotice.value = `保存失败：${(e as Error).message}`
      } finally { promptSaving.value = false }
    }
    onMounted(() => { void refresh() })

    return () => {
      const ElButton = resolveComponent('el-button') as unknown as string
      const ElCard = resolveComponent('el-card') as unknown as string
      const ElInput = resolveComponent('el-input') as unknown as string
      const ElSelect = resolveComponent('el-select') as unknown as string
      const ElOption = resolveComponent('el-option') as unknown as string
      const ElSpace = resolveComponent('el-space') as unknown as string
      const ElText = resolveComponent('el-text') as unknown as string
      const ElTag = resolveComponent('el-tag') as unknown as string
      const ElEmpty = resolveComponent('el-empty') as unknown as string
      const ElRow = resolveComponent('el-row') as unknown as string
      const KLayout = resolveComponent('k-layout') as unknown as string
      const KContent = resolveComponent('k-content') as unknown as string
      const field = (label: string, control: VNodeChild) => h('div', { key: label }, [
        h(ElText, { tag: 'label', size: 'small' }, { default: () => label }), control,
      ])
      const formCard = h(ElCard, { shadow: 'never' }, {
        header: () => h(ElRow, { justify: 'space-between', align: 'middle' }, {
          default: () => [
            h(ElText, { tag: 'strong' }, { default: () => editingId.value ? '编辑团队共享 Agent' : '创建团队共享 Agent' }),
            editingId.value ? h(ElButton, { text: true, onClick: reset }, { default: () => '取消编辑' }) : null,
          ],
        }),
        default: () => h(ElSpace, { direction: 'vertical', fill: true, size: 12 }, {
          default: () => [
            !editingId.value ? field('创建模板', h(ElSelect, { modelValue: selectedTemplate.value,
              'onUpdate:modelValue': (v: string) => applyTemplate(v), placeholder: '从通用模板开始，也可直接填写' }, {
              default: () => templates.value.map((item) => h(ElOption, { key: item.id,
                label: `${item.title} v${item.version}：${item.summary}`, value: item.id })),
            })) : null,
            field('名称', h(ElInput, { modelValue: form.value.title, maxlength: 80, showWordLimit: true,
              'onUpdate:modelValue': (v: string) => { form.value.title = v }, placeholder: '例如：需求分析助手' })),
            field('职责说明', h(ElInput, { modelValue: form.value.description, type: 'textarea', rows: 3,
              'onUpdate:modelValue': (v: string) => { form.value.description = v }, placeholder: '说明 Agent 的目标、工作方式和输出要求' })),
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
              'onUpdate:modelValue': (v: string) => { form.value.modelRef = v }, placeholder: '留空使用所选供应商配置中的模型 ID' })),
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
            field('记忆策略', h(ElSelect, { modelValue: form.value.memoryPolicy,
              'onUpdate:modelValue': (v: string) => { form.value.memoryPolicy = v } }, {
              default: () => [h(ElOption, { label: '独立 Agent 记忆', value: 'agent' }), h(ElOption, { label: '不写入记忆', value: 'none' })],
            })),
            field('发言策略', h(ElSelect, { modelValue: form.value.speechPolicy,
              'onUpdate:modelValue': (v: string) => { form.value.speechPolicy = v } }, {
              default: () => [h(ElOption, { label: '仅被 @ 时回复', value: 'passive' }), h(ElOption, { label: '允许主动发言', value: 'proactive' })],
            })),
            h(ElSpace, {}, { default: () => [
              h(ElButton, { type: 'primary', loading: saving.value, onClick: () => void save() }, { default: () => editingId.value ? '保存配置' : '创建 Agent' }),
              h(ElButton, { onClick: reset }, { default: () => '重置' }),
            ] }),
          ],
        }),
      })
      const catalog = definitions.value.length
        ? h(ElSpace, { direction: 'vertical', fill: true, size: 12 }, {
            default: () => definitions.value.map((def) => h(ElCard, { key: def.id, shadow: 'never' }, {
              header: () => h(ElRow, { justify: 'space-between', align: 'middle' }, {
                default: () => [
                  h(ElText, { tag: 'strong' }, { default: () => def.title }),
                  h(ElSpace, {}, { default: () => [
                    h(ElButton, { text: true, onClick: () => edit(def) }, { default: () => '编辑' }),
                    h(ElButton, { text: true, type: 'danger', onClick: () => void archive(def) }, { default: () => '归档' }),
                  ] }),
                ],
              }),
              default: () => [
                h(ElText, {}, { default: () => def.description }),
                h(ElSpace, { wrap: true }, { default: () => [
                  def.templateOrigin ? h(ElTag, { size: 'small', type: 'info' }, { default: () => `起始模板：${def.templateOrigin?.id} v${def.templateOrigin?.version}` }) : null,
                  h(ElTag, { size: 'small' }, { default: () => `供应商：${llmProfiles.value.find((item) => item.id === def.llmProfileRef)?.name ?? (def.llmProfileRef || '系统默认')}` }),
                  def.modelRef ? h(ElTag, { size: 'small' }, { default: () => `模型覆盖：${def.modelRef}` }) : null,
                  h(ElTag, { size: 'small' }, { default: () => `工具：${def.toolIds.join(', ') || '未配置'}` }),
                  h(ElTag, { size: 'small' }, { default: () => `提示词：${def.promptRef || '未绑定'}` }),
                ] }),
                h(ElSpace, {}, { default: () => [
                  h(ElSelect, { modelValue: sessionId.value, 'onUpdate:modelValue': (v: string) => { sessionId.value = v }, placeholder: '选择要邀请到的会话', clearable: true }, {
                    default: () => sessions.value.map((s) => h(ElOption, { key: s.id, label: s.title, value: s.id })),
                  }),
                  h(ElButton, { type: 'primary', disabled: !sessionId.value, onClick: () => void invite(def) }, { default: () => '邀请加入' }),
                ] }),
              ],
            })),
          })
        : h(ElEmpty, { description: '还没有团队共享 Agent，可以先创建一个' })

      const promptEditor = h(ElCard, { shadow: 'never' }, {
        header: () => h(ElRow, { justify: 'space-between', align: 'middle' }, [
          h(ElText, { tag: 'strong' }, { default: () => '团队共享 Agent 提示词' }),
          h(ElSelect, { modelValue: promptSelection.value, placeholder: '打开已有模板', clearable: true,
            'onUpdate:modelValue': (v: string) => selectPrompt(v) }, {
            default: () => prompts.value.map((item) => h(ElOption, { key: item.ref, label: `${item.title}（${item.ref}）`, value: item.ref })),
          }),
        ]),
        default: () => h(ElSpace, { direction: 'vertical', fill: true, size: 10 }, {
          default: () => [
            field('稳定 ref', h(ElInput, { modelValue: promptForm.value.ref,
              'onUpdate:modelValue': (v: string) => { promptForm.value.ref = v }, placeholder: '例如 prompt.research' })),
            field('模板名称', h(ElInput, { modelValue: promptForm.value.title,
              'onUpdate:modelValue': (v: string) => { promptForm.value.title = v }, placeholder: '给团队看的名称' })),
            field('提示词正文', h(ElInput, { modelValue: promptForm.value.body, type: 'textarea', rows: 8,
              'onUpdate:modelValue': (v: string) => { promptForm.value.body = v }, placeholder: '定义 Agent 的目标、边界、工作步骤和回答格式' })),
            promptNotice.value ? h(ElText, { type: promptFailure.value ? 'danger' : 'success' }, { default: () => promptNotice.value }) : null,
            h(ElButton, { type: 'primary', loading: promptSaving.value, onClick: () => void savePrompt() }, { default: () => '保存共享提示词' }),
          ],
        }),
      })

      return h(KLayout, { main: 'page-teamspace-agents' }, {
        header: () => h(ElRow, { justify: 'space-between', align: 'middle' }, [
          h(ElText, { tag: 'strong' }, { default: () => '团队共享 Agent' }),
          h(ElButton, { text: true, onClick: () => window.location.assign('/teamspace') }, { default: () => '返回会话' }),
        ]),
        default: () => [
          h(ThemeStyle),
          h(KContent, {}, { default: () => h(ElSpace, { direction: 'vertical', fill: true, size: 16 }, {
            default: () => [
              h(ElText, { type: 'info', size: 'small' }, { default: () => 'Agent 配置属于整个团队共享资源，没有个人所有者。邀请加入会话后可访问从会话开始以来的完整历史。' }),
              h(ElText, { type: 'info', size: 'small' }, { default: () => '共享 Agent 使用统一运行时。模型、工具、上下文来源、记忆和发言策略会按配置执行；提示词需绑定已有模板 ref，模型凭据由系统管理员维护。创建定义不会自动加入会话，需显式邀请。' }),
              promptEditor,
              notice.value ? h(ElText, { type: failure.value ? 'danger' : 'success' }, { default: () => notice.value }) : null,
              formCard,
              h(ElText, { tag: 'strong' }, { default: () => `共享 Agent 目录${loading.value ? '（加载中）' : ''}` }),
              catalog,
            ],
          }) }),
        ],
      })
    }
  },
})

export const AGENT_PAGE_ICON = 'users'
