import assert from 'node:assert/strict'
import { decisionAccessGuidance, decisionPresentation } from '../packages/client-ui/space-client-ui-teamspace/client/decision-presentation.ts'

const target = {
  id: 'agent-answer', kind: 'message', authorKind: 'agent',
  text: '建议采用方案 A。\n【需要DRI决策】是否接受方案 A？',
}
assert.deepEqual(decisionPresentation(target, [target]), {
  recommendation: '建议采用方案 A。', question: '是否接受方案 A？',
  title: '待 DRI 决策', type: 'warning',
})
assert.equal(decisionPresentation({ ...target, text: '普通回答' }, [target]), null)
assert.equal(decisionPresentation({ ...target, authorKind: 'human' }, [target]), null)
const defer = { id: 'defer', kind: 'decision', authorKind: 'human', replyTo: target.id, seq: 10, text: 'DRI 决策：暂缓' }
assert.equal(decisionPresentation(target, [target, defer])?.title, '已暂缓，等待复核')
const pass = { id: 'pass', kind: 'approval', authorKind: 'human', replyTo: target.id, seq: 11, text: 'DRI 决策：通过' }
assert.deepEqual(decisionPresentation(target, [target, defer, pass]), {
  recommendation: '建议采用方案 A。', question: '是否接受方案 A？', title: 'DRI 已通过', type: 'success',
})
const review = { id: 'review', kind: 'decision', authorKind: 'human', replyTo: target.id, seq: 12,
  text: '【撤回复核请求】\n拟决策：reject' }
assert.equal(decisionPresentation(target, [target, review])?.title, '正在收集复核意见')
const reviewDone = { id: 'review-done', kind: 'system', authorKind: 'system', replyTo: review.id, seq: 13,
  text: '【复核完成】1 个 Agent 提出问题。' }
assert.equal(decisionPresentation(target, [target, review, reviewDone])?.title, '复核完成，待 DRI 定案')
const deferReview = { id: 'defer-review', kind: 'decision', authorKind: 'human', replyTo: target.id, seq: 14,
  text: '【撤回复核请求】\n拟决策：defer' }
assert.equal(decisionPresentation(target, [target, defer, review, reviewDone, deferReview])?.title,
  '正在收集复核意见')
const deferReviewDone = { ...reviewDone, id: 'defer-review-done', replyTo: deferReview.id, seq: 15 }
assert.equal(decisionPresentation(target, [target, defer, review, reviewDone, deferReview, deferReviewDone])?.title,
  '复核完成，待 DRI 再次决策')
assert.equal(decisionPresentation({ ...target, text: '建议。\n【需要DRI决策】' }, [target])?.question,
  '请审阅建议，并使用下方操作按钮处理。')
assert.equal(decisionAccessGuidance({ viewerIsDri: false, driName: 'dri', driPrincipalId: 'u_b926037d' }),
  '当前登录账号无通过权限。请使用 DRI「dri」（u_b926037d）登录；只有该 DRI 能在 Agent 回复卡片下方选择「通过」或「其他处理」，消息「⋯」菜单没有决策入口。请使用这个 DRI 账号登录，或请群主从会话「⋯」→「成员 / 角色管理」指定人类成员为 DRI。')
assert.match(decisionAccessGuidance({ viewerIsDri: true }), /Agent 回复卡片下方选择「通过」或「其他处理」/u)
assert.match(decisionAccessGuidance({ viewerIsDri: true, viewerIsOwnerFallback: true }), /你是群主，可直接在这张 Agent 回复卡片下方选择/u)
assert.match(decisionAccessGuidance({ viewerIsDri: false, viewerRole: '群主' }), /不能把自己改成 DRI/u)
assert.match(decisionAccessGuidance({ viewerIsDri: false }), /当前登录账号无通过权限/u)
console.log('✓ Decision presentation separates Agent recommendations, pending questions, and latest DRI status')
