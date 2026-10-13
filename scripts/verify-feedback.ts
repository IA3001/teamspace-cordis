import assert from 'node:assert/strict'
import { appendFailureNotice, dismissFailureNotice } from '../packages/client-ui/space-client-ui-shared/client/feedback.ts'

const first = { id: 1, message: '发送失败，请重试。' }
const second = { id: 2, message: '加载失败，请重试。' }
const withFirst = appendFailureNotice([], first)
const withBoth = appendFailureNotice(withFirst, second)
assert.deepEqual(withBoth, [first, second], 'a later failure must not erase an earlier one')
assert.equal(appendFailureNotice(withBoth, { id: 3, message: first.message }), withBoth,
  'duplicate failures should not create a noisy stack')
assert.deepEqual(dismissFailureNotice(withBoth, first.id), [second], 'dismissal is scoped to one notice')

// Dismissible alerts, independent failures and retry UI are exercised by ui-verify.mjs AS13/AS20.
console.log('✓ Failure notices remain independent, deduplicated and explicitly dismissible')
