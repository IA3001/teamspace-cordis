# rpc

- [packages/client-ui/space-client-ui-admin/src/index.ts](../../packages/client-ui/space-client-ui-admin/src/index.ts)：`users`
  `token: string`
- [packages/client-ui/space-client-ui-admin/src/index.ts](../../packages/client-ui/space-client-ui-admin/src/index.ts)：`plugins`
  `token: string`
- [packages/client-ui/space-client-ui-admin/src/index.ts](../../packages/client-ui/space-client-ui-admin/src/index.ts)：`createUser`
  `token: string, input: { username: string; password: string; displayName?: string; teamRole: TeamRole }`
- [packages/client-ui/space-client-ui-admin/src/index.ts](../../packages/client-ui/space-client-ui-admin/src/index.ts)：`resetPassword`
  `token: string, userId: string, password: string`
- [packages/client-ui/space-client-ui-admin/src/index.ts](../../packages/client-ui/space-client-ui-admin/src/index.ts)：`getRegisterEnabled`
  `token: string`
- [packages/client-ui/space-client-ui-admin/src/index.ts](../../packages/client-ui/space-client-ui-admin/src/index.ts)：`setRegisterEnabled`
  `token: string, value: boolean`
- [packages/client-ui/space-client-ui-admin/src/index.ts](../../packages/client-ui/space-client-ui-admin/src/index.ts)：`removeUser`
  `token: string, userId: string`
- [packages/client-ui/space-client-ui-admin/src/index.ts](../../packages/client-ui/space-client-ui-admin/src/index.ts)：`getApiConfig`
  `token: string`
- [packages/client-ui/space-client-ui-admin/src/index.ts](../../packages/client-ui/space-client-ui-admin/src/index.ts)：`getEmbeddingIndexStatus`
  `token: string`
- [packages/client-ui/space-client-ui-admin/src/index.ts](../../packages/client-ui/space-client-ui-admin/src/index.ts)：`retryEmbeddingIndex`
  `token: string`
- [packages/client-ui/space-client-ui-admin/src/index.ts](../../packages/client-ui/space-client-ui-admin/src/index.ts)：`fetchTextModels`
  `token: string, input: { target: 'text' | 'embedding' | 'profile' | 'embeddingProfile'; profileId?: string; baseURL?: string; apiKey?: string }`
- [packages/client-ui/space-client-ui-admin/src/index.ts](../../packages/client-ui/space-client-ui-admin/src/index.ts)：`saveTextApi`
  `token: string, cfg: { baseURL?: string; model?: string; apiKey?: string; timeoutMs?: number }`
- [packages/client-ui/space-client-ui-admin/src/index.ts](../../packages/client-ui/space-client-ui-admin/src/index.ts)：`saveTextProfile`
  `token: string, cfg: { id?: string; name?: string; baseURL?: string; model?: string; apiKey?: string; maxOutputTokens?: number | null }`
- [packages/client-ui/space-client-ui-admin/src/index.ts](../../packages/client-ui/space-client-ui-admin/src/index.ts)：`removeTextProfile`
  `token: string, idInput: string`
- [packages/client-ui/space-client-ui-admin/src/index.ts](../../packages/client-ui/space-client-ui-admin/src/index.ts)：`setDefaultTextProfile`
  `token: string, idInput: string`
- [packages/client-ui/space-client-ui-admin/src/index.ts](../../packages/client-ui/space-client-ui-admin/src/index.ts)：`saveServiceProfile`
  `token: string, kind: ManagedService, input: { id?: string; name?: string; baseURL?: string; model?: string; apiKey?: string }`
- [packages/client-ui/space-client-ui-admin/src/index.ts](../../packages/client-ui/space-client-ui-admin/src/index.ts)：`activateServiceProfile`
  `token: string, kind: ManagedService, idInput: string`
- [packages/client-ui/space-client-ui-admin/src/index.ts](../../packages/client-ui/space-client-ui-admin/src/index.ts)：`removeServiceProfile`
  `token: string, kind: ManagedService, idInput: string`
- [packages/client-ui/space-client-ui-admin/src/index.ts](../../packages/client-ui/space-client-ui-admin/src/index.ts)：`saveEmbeddingApi`
  `token: string, cfg: { baseURL?: string; model?: string; apiKey?: string }`
- [packages/client-ui/space-client-ui-admin/src/index.ts](../../packages/client-ui/space-client-ui-admin/src/index.ts)：`saveWebSearchApi`
  `token: string, cfg: { baseURL?: string; apiKey?: string }`
- [packages/client-ui/space-client-ui-admin/src/index.ts](../../packages/client-ui/space-client-ui-admin/src/index.ts)：`testTextApi`
  `token: string`
- [packages/client-ui/space-client-ui-admin/src/index.ts](../../packages/client-ui/space-client-ui-admin/src/index.ts)：`testTextProfile`
  `token: string, idInput: string`
- [packages/client-ui/space-client-ui-admin/src/index.ts](../../packages/client-ui/space-client-ui-admin/src/index.ts)：`testTextProfileStream`
  `token: string, idInput: string`
- [packages/client-ui/space-client-ui-admin/src/index.ts](../../packages/client-ui/space-client-ui-admin/src/index.ts)：`testEmbeddingApi`
  `token: string, profileId?: string`
- [packages/client-ui/space-client-ui-admin/src/index.ts](../../packages/client-ui/space-client-ui-admin/src/index.ts)：`testWebSearchApi`
  `token: string, profileId?: string`
- [packages/client-ui/space-client-ui-admin/src/index.ts](../../packages/client-ui/space-client-ui-admin/src/index.ts)：`sandboxApprovals`
  `token: string`
- [packages/client-ui/space-client-ui-admin/src/index.ts](../../packages/client-ui/space-client-ui-admin/src/index.ts)：`decideSandboxApproval`
  `token: string, id: string, decision: 'approved' | 'rejected', note = ''`
- [packages/client-ui/space-client-ui-auth/src/index.ts](../../packages/client-ui/space-client-ui-auth/src/index.ts)：`register`
  `username: string, password: string, displayName: string`
- [packages/client-ui/space-client-ui-auth/src/index.ts](../../packages/client-ui/space-client-ui-auth/src/index.ts)：`login`
  `username: string, password: string`
- [packages/client-ui/space-client-ui-auth/src/index.ts](../../packages/client-ui/space-client-ui-auth/src/index.ts)：`me`
  `token: string`
- [packages/client-ui/space-client-ui-kb/src/index.ts](../../packages/client-ui/space-client-ui-kb/src/index.ts)：`docs`
  `token: string`
- [packages/client-ui/space-client-ui-kb/src/index.ts](../../packages/client-ui/space-client-ui-kb/src/index.ts)：`folders`
  `token: string`
- [packages/client-ui/space-client-ui-kb/src/index.ts](../../packages/client-ui/space-client-ui-kb/src/index.ts)：`getDoc`
  `token: string, id: string`
- [packages/client-ui/space-client-ui-kb/src/index.ts](../../packages/client-ui/space-client-ui-kb/src/index.ts)：`createFolder`
  `token: string, name: string, parentPath = ''`
- [packages/client-ui/space-client-ui-kb/src/index.ts](../../packages/client-ui/space-client-ui-kb/src/index.ts)：`addDoc`
  `token: string, title: string, text: string, folderPath = ''`
- [packages/client-ui/space-client-ui-kb/src/index.ts](../../packages/client-ui/space-client-ui-kb/src/index.ts)：`updateDoc`
  `token: string, id: string, title: string, text: string, folderPath = ''`
- [packages/client-ui/space-client-ui-kb/src/index.ts](../../packages/client-ui/space-client-ui-kb/src/index.ts)：`removeDoc`
  `token: string, id: string`
- [packages/client-ui/space-client-ui-kb/src/index.ts](../../packages/client-ui/space-client-ui-kb/src/index.ts)：`searchKb`
  `token: string, query: string`
- [packages/client-ui/space-client-ui-kb/src/index.ts](../../packages/client-ui/space-client-ui-kb/src/index.ts)：`embeddingsStatus`
  `token: string`
- [packages/client-ui/space-client-ui-sessions/src/index.ts](../../packages/client-ui/space-client-ui-sessions/src/index.ts)：`me`
  `token: string`
- [packages/client-ui/space-client-ui-sessions/src/index.ts](../../packages/client-ui/space-client-ui-sessions/src/index.ts)：`sessions`
  `token: string`
- [packages/client-ui/space-client-ui-sessions/src/index.ts](../../packages/client-ui/space-client-ui-sessions/src/index.ts)：`summaries`
  `token: string, seen?: Record<string, number>`
- [packages/client-ui/space-client-ui-sessions/src/index.ts](../../packages/client-ui/space-client-ui-sessions/src/index.ts)：`members`
  `token: string, sessionId: string`
- [packages/client-ui/space-client-ui-sessions/src/index.ts](../../packages/client-ui/space-client-ui-sessions/src/index.ts)：`agentRoster`
  `token: string`
- [packages/client-ui/space-client-ui-sessions/src/index.ts](../../packages/client-ui/space-client-ui-sessions/src/index.ts)：`create`
  `token: string, selectedIds: string[] = []`
- [packages/client-ui/space-client-ui-sessions/src/index.ts](../../packages/client-ui/space-client-ui-sessions/src/index.ts)：`listHumans`
  `token: string`
- [packages/client-ui/space-client-ui-sessions/src/index.ts](../../packages/client-ui/space-client-ui-sessions/src/index.ts)：`createGroup`
  `token: string, title: string, userIds: string[] = [], agentIds: string[] = []`
- [packages/client-ui/space-client-ui-sessions/src/index.ts](../../packages/client-ui/space-client-ui-sessions/src/index.ts)：`invite`
  `token: string, sessionId: string, userIds: string[] = []`
- [packages/client-ui/space-client-ui-sessions/src/index.ts](../../packages/client-ui/space-client-ui-sessions/src/index.ts)：`removeMember`
  `token: string, sessionId: string, principalId: string`
- [packages/client-ui/space-client-ui-sessions/src/index.ts](../../packages/client-ui/space-client-ui-sessions/src/index.ts)：`setMemberRole`
  `token: string, sessionId: string, principalId: string, role: unknown`
- [packages/client-ui/space-client-ui-sessions/src/index.ts](../../packages/client-ui/space-client-ui-sessions/src/index.ts)：`logout`
  `token: string`
- [packages/client-ui/space-client-ui-sessions/src/index.ts](../../packages/client-ui/space-client-ui-sessions/src/index.ts)：`close`
  `token: string, sessionId: string`
- [packages/client-ui/space-client-ui-sessions/src/index.ts](../../packages/client-ui/space-client-ui-sessions/src/index.ts)：`rename`
  `token: string, sessionId: string, title: string`
- [packages/client-ui/space-client-ui-settings/src/index.ts](../../packages/client-ui/space-client-ui-settings/src/index.ts)：`me`
  `token: string`
- [packages/client-ui/space-client-ui-settings/src/index.ts](../../packages/client-ui/space-client-ui-settings/src/index.ts)：`getConfig`
  `token: string`
- [packages/client-ui/space-client-ui-settings/src/index.ts](../../packages/client-ui/space-client-ui-settings/src/index.ts)：`saveLlm`
  `token: string, cfg: { baseURL?: string; model?: string; apiKey?: string; timeoutMs?: number }`
- [packages/client-ui/space-client-ui-settings/src/index.ts](../../packages/client-ui/space-client-ui-settings/src/index.ts)：`saveEmbed`
  `token: string, cfg: { baseURL?: string; model?: string; apiKey?: string }`
- [packages/client-ui/space-client-ui-settings/src/index.ts](../../packages/client-ui/space-client-ui-settings/src/index.ts)：`testLlm`
  `token: string`
- [packages/client-ui/space-client-ui-settings/src/index.ts](../../packages/client-ui/space-client-ui-settings/src/index.ts)：`testEmbed`
  `token: string`
- [packages/client-ui/space-client-ui-teamspace/src/index.ts](../../packages/client-ui/space-client-ui-teamspace/src/index.ts)：`me`
  `token: string`
- [packages/client-ui/space-client-ui-teamspace/src/index.ts](../../packages/client-ui/space-client-ui-teamspace/src/index.ts)：`agents`
  `token: string`
- [packages/client-ui/space-client-ui-teamspace/src/index.ts](../../packages/client-ui/space-client-ui-teamspace/src/index.ts)：`agentDefinitions`
  `token: string`
- [packages/client-ui/space-client-ui-teamspace/src/index.ts](../../packages/client-ui/space-client-ui-teamspace/src/index.ts)：`agentMemories`
  `token: string, agentId: string, offset = 0, includeInvalidated = false, limit = 20, folderPath = ''`
- [packages/client-ui/space-client-ui-teamspace/src/index.ts](../../packages/client-ui/space-client-ui-teamspace/src/index.ts)：`agentMemoryCatalog`
  `token: string`
- [packages/client-ui/space-client-ui-teamspace/src/index.ts](../../packages/client-ui/space-client-ui-teamspace/src/index.ts)：`agentMemoryFolders`
  `token: string, agentId: string`
- [packages/client-ui/space-client-ui-teamspace/src/index.ts](../../packages/client-ui/space-client-ui-teamspace/src/index.ts)：`agentMemoryCreateFolder`
  `token: string, agentId: string, name: string, parentPath = ''`
- [packages/client-ui/space-client-ui-teamspace/src/index.ts](../../packages/client-ui/space-client-ui-teamspace/src/index.ts)：`agentMemoryMove`
  `token: string, agentId: string, memoryId: string, folderPath: string`
- [packages/client-ui/space-client-ui-teamspace/src/index.ts](../../packages/client-ui/space-client-ui-teamspace/src/index.ts)：`agentWorkspaceOverview`
  `token: string`
- [packages/client-ui/space-client-ui-teamspace/src/index.ts](../../packages/client-ui/space-client-ui-teamspace/src/index.ts)：`agentWorkspaceInbox`
  `token: string, agentId: string, sessionId: string, page = 1, pageSize = 20`
- [packages/client-ui/space-client-ui-teamspace/src/index.ts](../../packages/client-ui/space-client-ui-teamspace/src/index.ts)：`agentWorkspaceHistory`
  `token: string, agentId: string, sessionId: string, page = 1, pageSize = 20`
- [packages/client-ui/space-client-ui-teamspace/src/index.ts](../../packages/client-ui/space-client-ui-teamspace/src/index.ts)：`agentWorkspaceBrowse`
  `token: string, agentId: string, path = ''`
- [packages/client-ui/space-client-ui-teamspace/src/index.ts](../../packages/client-ui/space-client-ui-teamspace/src/index.ts)：`agentWorkspaceRead`
  `token: string, agentId: string, path: string`
- [packages/client-ui/space-client-ui-teamspace/src/index.ts](../../packages/client-ui/space-client-ui-teamspace/src/index.ts)：`sharedWorkspaceBrowse`
  `token: string, path = ''`
- [packages/client-ui/space-client-ui-teamspace/src/index.ts](../../packages/client-ui/space-client-ui-teamspace/src/index.ts)：`sharedWorkspaceRead`
  `token: string, path: string`
- [packages/client-ui/space-client-ui-teamspace/src/index.ts](../../packages/client-ui/space-client-ui-teamspace/src/index.ts)：`transferWorkspaceFile`
  `token: string, sourceAgentId: string, path: string, targetAgentId = ''`
- [packages/client-ui/space-client-ui-teamspace/src/index.ts](../../packages/client-ui/space-client-ui-teamspace/src/index.ts)：`agentTemplates`
  `token: string, includeArchived = false`
- [packages/client-ui/space-client-ui-teamspace/src/index.ts](../../packages/client-ui/space-client-ui-teamspace/src/index.ts)：`saveAgentTemplate`
  `token: string, input: { title: string; summary: string; input: AgentDefinitionInput }, id?: string`
- [packages/client-ui/space-client-ui-teamspace/src/index.ts](../../packages/client-ui/space-client-ui-teamspace/src/index.ts)：`archiveAgentTemplate`
  `token: string, id: string`
- [packages/client-ui/space-client-ui-teamspace/src/index.ts](../../packages/client-ui/space-client-ui-teamspace/src/index.ts)：`restoreAgentTemplate`
  `token: string, id: string`
- [packages/client-ui/space-client-ui-teamspace/src/index.ts](../../packages/client-ui/space-client-ui-teamspace/src/index.ts)：`llmProfiles`
  `token: string`
- [packages/client-ui/space-client-ui-teamspace/src/index.ts](../../packages/client-ui/space-client-ui-teamspace/src/index.ts)：`toolCatalog`
  `token: string`
- [packages/client-ui/space-client-ui-teamspace/src/index.ts](../../packages/client-ui/space-client-ui-teamspace/src/index.ts)：`promptTemplates`
  `token: string`
- [packages/client-ui/space-client-ui-teamspace/src/index.ts](../../packages/client-ui/space-client-ui-teamspace/src/index.ts)：`savePromptTemplate`
  `token: string, ref: string, title: string, body: string`
- [packages/client-ui/space-client-ui-teamspace/src/index.ts](../../packages/client-ui/space-client-ui-teamspace/src/index.ts)：`createAgent`
  `token: string, input: AgentDefinitionInput`
- [packages/client-ui/space-client-ui-teamspace/src/index.ts](../../packages/client-ui/space-client-ui-teamspace/src/index.ts)：`updateAgent`
  `token: string, id: string, patch: AgentDefinitionPatch`
- [packages/client-ui/space-client-ui-teamspace/src/index.ts](../../packages/client-ui/space-client-ui-teamspace/src/index.ts)：`archiveAgent`
  `token: string, id: string`
