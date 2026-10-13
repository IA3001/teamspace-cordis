import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { parse } from '@babel/parser'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export function complexities(text) {
  const ast = parse(text, { sourceType: 'module', plugins: ['typescript'] })
  const values = new Map()
  const counts = new Map()
  function visit(node, path = '') {
    if (!node || typeof node !== 'object') return
    if (/Function|Method/.test(node.type) && node.body) {
      const name = `${path}/${node.id?.name ?? node.key?.name ?? node.key?.value ?? 'anonymous'}`
      const occurrence = counts.get(name) ?? 0
      counts.set(name, occurrence + 1)
      let complexity = 1
      function count(part) {
        if (!part || typeof part !== 'object') return
        if (part !== node && /Function|Method/.test(part.type)) return
        if (['IfStatement', 'ConditionalExpression', 'ForStatement', 'ForInStatement', 'ForOfStatement',
          'WhileStatement', 'DoWhileStatement', 'CatchClause'].includes(part.type) ||
          (part.type === 'SwitchCase' && part.test) || part.type === 'LogicalExpression') complexity++
        for (const value of Object.values(part)) {
          if (Array.isArray(value)) value.forEach(count)
          else if (value?.type) count(value)
        }
      }
      count(node)
      values.set(`${name}#${occurrence}`, complexity)
      path = name
    } else if (node.type === 'VariableDeclarator') path += `/${node.id?.name ?? 'binding'}`
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach((part) => visit(part, path))
      else if (value?.type) visit(value, path)
    }
  }
  visit(ast)
  return values
}
export function checkDocument(text, maxBytes) {
  const errors = []
  if (Buffer.byteLength(text) > maxBytes) errors.push(`document exceeds ${maxBytes} bytes`)
  const paragraphs = text.split(/\n\s*\n/).map((p) => p.trim()).filter((p) => p.length >= 120 && !p.startsWith('```'))
  if (new Set(paragraphs).size !== paragraphs.length) errors.push('duplicate long paragraph')
  return errors
}
function git(args) { return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 32 * 1024 * 1024 }) }
function blob(ref, path) { try { return git(['show', `${ref}:${path}`]) } catch { return '' } }
function main() {
  const base = process.argv[2]
  if (!base) throw new Error('Pass the trusted PR base commit: npm run lint:changes -- <base-sha>')
  git(['rev-parse', '--verify', `${base}^{commit}`])
  const prefix = git(['rev-parse', '--show-prefix']).trim()
  // Policy comes from the base branch; a PR cannot raise its own budget.
  const oldPolicy = blob(base, `${prefix}.ci/change-policy.json`)
  const policy = JSON.parse(oldPolicy || readFileSync('.ci/change-policy.json', 'utf8'))
  const rows = git(['diff', '--numstat', '--no-renames', base, 'HEAD', '--', '.']).trim().split('\n').filter(Boolean)
  const errors = []
  const review = []
  let lines = 0
  const allowed = process.env.CI_ALLOWED_PATHS?.split(',').filter(Boolean)
  for (const row of rows) {
    const [added, removed, gitPath] = row.split('\t')
    const path = gitPath.startsWith(prefix) ? gitPath.slice(prefix.length) : gitPath
    lines += (Number(added) || 0) + (Number(removed) || 0)
    if (allowed && !allowed.some((scope) => path === scope || path.startsWith(scope.endsWith('/') ? scope : `${scope}/`))) errors.push(`${path}: outside approved scope`)
    const before = blob(base, gitPath)
    const after = blob('HEAD', gitPath)
    if (/\.md$/.test(path) && after && after !== before) {
      const oldErrors = checkDocument(before, policy.maxDocumentBytes)
      for (const error of checkDocument(after, policy.maxDocumentBytes)) {
        if (!oldErrors.includes(error) || Buffer.byteLength(after) > Buffer.byteLength(before)) errors.push(`${path}: ${error}`)
      }
    }
    if (/\.tsx?$/.test(path) && after) {
      const oldValues = complexities(before)
      for (const [name, value] of complexities(after)) {
        if (value > policy.maxComplexity && value > (oldValues.get(name) ?? 0)) errors.push(`${path}: ${name} complexity ${value} exceeds ${policy.maxComplexity}`)
      }
    }
    if (/^(\.ci\/|\.github\/|\.rules\/|scripts\/|tsconfig|package(?:-lock)?\.json)/.test(path)) review.push(`${path}: CI/rule/test changes require independent review`)
    if (/^scripts\/.*verify/.test(path) && Number(removed) > 0) review.push(`${path}: regression assertions removed or rewritten; inspect behavior coverage`)
  }
  if (rows.length > policy.maxFiles) errors.push(`${rows.length} changed files exceeds ${policy.maxFiles}`)
  if (lines > policy.maxChangedLines) errors.push(`${lines} changed lines exceeds ${policy.maxChangedLines}`)
  console.log(`Change budget: ${rows.length} files, ${lines} lines`)
  for (const item of review) console.log(`REVIEW: ${item}`)
  for (const item of errors) console.error(`FAIL: ${item}`)
  process.exitCode = errors.length ? 1 : 0
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
