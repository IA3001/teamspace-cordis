import { readFileSync, existsSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { files, digest } from './state.mjs'
export function compatibilityErrors(root, policy) {
  const errors = []
  for (const [path, hash] of Object.entries(policy.archive)) {
    if (!existsSync(join(root, path)) || digest(readFileSync(join(root, path))) !== hash) errors.push(`${path}: sealed history changed; independent review required`)
  }
  const register = JSON.parse(readFileSync(join(root, '.ci/compatibility.json'), 'utf8'))
  for (const path of files(root).filter((p) => /^packages\/seam\/.*\/src\/.*\.ts$/.test(p) || /^packages\/impl\/space-store-sqlite\/migrations\/.*\.sql$/.test(p))) {
    const current = digest(readFileSync(join(root, path)))
    if (policy.sources[path] === current) continue
    const ack = register.changes.find((item) => item.path === path && item.hash === current)
    if (!ack?.description || !ack.oldVersion || !ack.upgrade || !ack.rollback || !ack.tests?.length || ack.tests.some((test) => !existsSync(join(root, test))) || !existsSync(join(root, ack.description))) errors.push(`${path}: compatibility change requires current hash, upgrade/rollback, oldVersion, documentation and fixture tests`)
  }
  for (const path of Object.keys(policy.sources)) if (!existsSync(join(root, path)) && !register.changes.some((c) => c.path === path && c.hash === 'deleted' && c.description && c.tests?.length && c.oldVersion && c.upgrade && c.rollback && existsSync(join(root, c.description)) && c.tests.every((t) => existsSync(join(root, t))))) errors.push(`${path}: removed public contract requires compatibility acknowledgement`)
  return errors
}
if (process.argv[1] && resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  const root = process.cwd(), policyPath = process.env.DEV_TRUSTED_COMPATIBILITY || join(root, '.ci/compatibility.json')
  const errors = compatibilityErrors(root, JSON.parse(readFileSync(policyPath, 'utf8')))
  errors.forEach((e) => console.error(e)); console.log(`Compatibility and sealed-history checks: ${errors.length} violations`)
  process.exitCode = errors.length ? 1 : 0
}
