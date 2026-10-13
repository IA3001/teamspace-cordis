import assert from 'node:assert/strict'
import { resolveLoadView } from '../packages/client-ui/space-client-ui-shared/client/load-state.ts'

assert.equal(resolveLoadView(true, false, false), 'loading')
assert.equal(resolveLoadView(false, true, false), 'error')
assert.equal(resolveLoadView(false, false, false), 'empty')
assert.equal(resolveLoadView(true, false, true), 'content', 'refresh should preserve visible content')
assert.equal(resolveLoadView(false, true, true), 'content', 'refresh errors should not hide cached content')

// UI loading/retry/cached-content behavior is exercised in ui-verify.mjs AS20/AS21.
console.log('✓ Loading, error, confirmed-empty, cached content, and refresh failures stay distinct')
