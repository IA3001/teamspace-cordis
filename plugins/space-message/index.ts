// space-message —— ctx.messages 服务实例的提供者（IM 化改造，2026-09-30）。
//
// 职责（seam/space-message 契约的实现侧）：
//   · send：人类与 AI 成员**同一个入口**上时间线 —— 校验（会话在/非空/在册
//     成员/作者可分类）→ eventLog.append → 返回落定事件。
//   · 落库 + 广播绑死：eventLog.append 内部已 emit 'space/event-appended'
//     （exactly-once 在实现层结构保证），本插件**不得**再 emit 一次。
//   · mentions：服务端解析文本中的 @token（按在册成员的 principalId / duty
//     双口径），与调用方显式传入的 mentions 取并集去重。
import { randomUUID } from 'node:crypto'
import type { Context } from 'cordis'
import type { SessionEvent } from 'space-event'
import { MessageError, MessageService } from 'space-message'
import type { MessageMetadata } from 'space-message'
import { blockedSpeechNotice, decideAgentSpeech } from 'space-agent-speech'

export const name = 'space-message'
export const inject = ['session', 'eventLog', 'agents']

/** 人类账号 ID 的约定前缀；Agent 身份以注册表为准，不依赖专属 ID 形状。 */
const HUMAN_PREFIX = 'u_'

export class MessageServiceImpl extends MessageService {
  async send(
    sessionId: string,
    authorId: string,
    text: string,
    mentions: string[] = [],
    replyTo?: string | null,
    metadata: MessageMetadata = {},
  ): Promise<SessionEvent> {
    // 1) 会话必须存在。
    if (!this.ctx.session.getSession(sessionId)) {
      throw new MessageError('session_not_found', `会话 ${sessionId} 不存在，消息无处可落`)
    }
    // 2) 文本拒空白。
    if (!text || !text.trim()) {
      throw new MessageError('empty_text', '消息文本为空（纯空白），拒绝落库')
    }
    // 3) 作者必须可分类。普通 Agent 是可配置数据实例，身份以注册表为准；
    //    不要求 a_* / agent.* 这类专属命名，也不把未知 ID 当作 Agent。
    let descriptor
    try { descriptor = this.ctx.agents.get(authorId).descriptor }
    catch { descriptor = undefined }
    const authorKind = descriptor ? 'agent' : authorId.startsWith(HUMAN_PREFIX) ? 'human' : null
    if (!authorKind) {
      throw new MessageError('unknown_author', `作者 id "${authorId}" 无法分类（需为已注册 Agent 或 u_* 人类账号）`)
    }
    // 4) 作者必须在册（含已离开的历史成员不算 —— onlyActive=true）。
    const members = this.ctx.session.listMembers(sessionId, true)
    if (!members.some((m) => m.principalId === authorId)) {
      throw new MessageError('not_member', `作者 ${authorId} 不是会话 ${sessionId} 的在册成员`)
    }
    // 5) 引用校验（引用系统化 2026-10-02）：目标事件必须存在且属于本会话；
    //    目标已 voided 允许引用（渲染层标注「原消息已撤回」）。
    let targetReplyTo: string | null = null
    if (replyTo) {
      const target = this.ctx.eventLog.listBySession(sessionId).find((e) => e.id === replyTo)
      if (!target) {
        throw new MessageError('empty_text', `引用目标事件不存在或不属于本会话：${replyTo}`)
      }
      targetReplyTo = replyTo
    }

    // 5) mentions 并集：入参显式 mentions ∪ 文本 @token 解析（按在册成员
    //    principalId / duty 双口径匹配，承 /tell 双口径先例）。
    const resolved = new Set(mentions)
    for (const m of members) {
      if (text.includes(`@${m.principalId}`) || (m.duty && text.includes(`@${m.duty}`))) {
        resolved.add(m.principalId)
      }
    }

    if (authorKind === 'agent') {
      const history = this.ctx.eventLog.listBySession(sessionId)
      const decision = decideAgentSpeech(authorId, descriptor?.speechPolicy, metadata.sourceEventId, history)
      if (!decision.allowed) {
        return this.ctx.eventLog.append({
          id: randomUUID(), sessionId, authorId: null, phaseId: null,
          authorKind: 'system', kind: 'system',
          text: blockedSpeechNotice(descriptor?.title ?? authorId, decision.reason!),
          mentions: [], toolCalls: [], replyMode: '',
        })
      }
    }

    // 6) 落库（append 内部恰好 emit 一次 'space/event-appended'，这里不再 emit）。
    return this.ctx.eventLog.append({
      id: randomUUID(),
      sessionId,
      authorId,
      phaseId: null,
      authorKind,
      kind: 'message',
      text,
      mentions: [...resolved],
      toolCalls: [],
      replyMode: '',
      replyTo: targetReplyTo,
      sourceEventId: metadata.sourceEventId,
      sourceEventIds: metadata.sourceEventIds,
    })
  }
}

export function apply(ctx: Context) {
  new MessageServiceImpl(ctx)
}
