import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { userFacingFailure, userFacingPause } from '../packages/client-ui/space-client-ui-shared/client/errors.ts'

const result = userFacingFailure('上传文件')
assert.equal(result, '上传文件失败，请检查网络后重试；若问题持续，请联系系统管理员。')
assert.equal(userFacingFailure('   '), '操作失败，请检查网络后重试；若问题持续，请联系系统管理员。')
assert.equal(result.includes('https://'), false)
assert.equal(userFacingPause('coordinator_error'), '模型暂时无法完成请求，请联系系统管理员检查配置')
assert.equal(userFacingPause('agent_target_unknown'), '目标 Agent 当前不可用，请联系系统管理员检查团队配置')
assert.equal(userFacingPause('private_internal_reason'), '处理已安全暂停，请联系系统管理员。')
assert.equal(userFacingPause('private_internal_reason').includes('private_internal_reason'), false,
  'unknown internal pause codes must never be exposed in the Teamspace panel')

for (const file of [
  'packages/client-ui/space-client-ui-teamspace/client/index.ts',
  'packages/client-ui/space-client-ui-sessions/client/index.ts',
]) {
  const source = await readFile(new URL(`../${file}`, import.meta.url), 'utf8')
  assert.doesNotMatch(source, /String\(\((?:e|error) as Error\)\.message/, `${file} must not expose caught exception messages`)
  assert.match(source, /userFacingFailure/, `${file} must use the shared safe failure wording`)
}
// Pause integration is asserted by AS26 in the actual browser, not a specific Vue source expression.

console.log('✓ User-facing failures remain localized and do not accept raw transport/runtime details')
