import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { join, resolve, dirname, relative } from 'node:path'
import { spawnSync } from 'node:child_process'
import { parse } from '@babel/parser'
import { files, digest } from './state.mjs'

export function ast(source) { return parse(source, { sourceType: 'module', plugins: ['typescript'], attachComment: true }) }
export function visit(node, fn) {
  if (!node || typeof node !== 'object') return
  if (node.type) fn(node)
  for (const [key, value] of Object.entries(node)) {
    if (['loc', 'comments', 'leadingComments', 'trailingComments', 'innerComments', 'tokens'].includes(key)) continue
    if (Array.isArray(value)) value.forEach((n) => visit(n, fn)); else if (value?.type) visit(value, fn)
  }
}
function shape(node) {
  if (Array.isArray(node)) return node.map(shape)
  if (!node || typeof node !== 'object') return node
  return Object.fromEntries(Object.entries(node).filter(([k]) => !['start', 'end', 'loc', 'extra', 'comments', 'leadingComments', 'trailingComments', 'innerComments'].includes(k)).map(([k, v]) => [k, shape(v)]))
}
export function declaration(source, symbol) {
  const tree = ast(source)
  const statement = tree.program.body.find((n) => (n.declaration ?? n).id?.name === symbol)
  if (!statement) throw new Error(`Missing declaration ${symbol}`)
  const n = statement.declaration ?? statement
  const comments = [...(statement.leadingComments ?? []), ...(n.leadingComments ?? [])].map((c) => c.value.trim())
  const nestedComments = []
  function collect(part, path) {
    if (!part || typeof part !== 'object') return
    for (const key of path === '' ? [] : ['leadingComments', 'innerComments', 'trailingComments']) for (const comment of part[key] ?? []) if (comment.type === 'CommentBlock' && comment.value.startsWith('*')) nestedComments.push([path, key, comment.value.trim()])
    for (const [key, value] of Object.entries(part)) {
      if (['loc', 'comments', 'leadingComments', 'innerComments', 'trailingComments'].includes(key)) continue
      if (Array.isArray(value)) value.forEach((child, index) => collect(child, `${path}/${key}/${index}`)); else if (value?.type) collect(value, `${path}/${key}`)
    }
  }
  collect(n, '')
  return { text: `${[...new Set(comments)].map((c) => `/*${c}*/`).join('\n')}\n${source.slice(n.start, n.end)}`.trim(), structure: shape(n), comments: { declaration: [...new Set(comments)], members: nestedComments } }
}
export function slug(text) { return text.toLowerCase().replace(/<[^>]*>/g, '').replace(/[^\p{L}\p{N}_\-\s]/gu, '').replace(/\s/g, '-') }
export function anchors(source) {
  const values = new Set(), counts = new Map()
  for (const match of source.replace(/```[^]*?```/g, '').matchAll(/^#{1,6}\s+(.+)$/gm)) {
    const id = slug(match[1].replace(/\s+#+$/, '')), count = counts.get(id) ?? 0
    values.add(count ? `${id}-${count}` : id); counts.set(id, count + 1)
  }
  for (const m of source.matchAll(/<(?:a|h[1-6])\b[^>]*(?:id|name)=["']([^"']+)["']/g)) values.add(m[1])
  return values
}
export function linkErrors(root) {
  const errors = []
  for (const path of files(root, '.md')) {
    const source = readFileSync(join(root, path), 'utf8').replace(/```[^]*?```|~~~[^]*?~~~/g, '')
    const links = [...source.matchAll(/!?\[[^\]]*\]\(<?([^\s)>]+)>?(?:\s+["'][^]*?["'])?\)|^\s*\[[^\]]+\]:\s*<?([^\s>]+)>?/gm)]
    for (const m of links) {
      let url = m[1] ?? m[2]
      if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|\/)/i.test(url)) continue
      try { url = decodeURIComponent(url) } catch { errors.push({ path, url, reason: 'invalid URL encoding' }); continue }
      const [target, fragment] = url.split('#'), absolute = resolve(dirname(join(root, path)), target.split('?')[0])
      if (!existsSync(absolute)) errors.push({ path, url, reason: 'missing target' })
      else if (fragment && absolute.endsWith('.md') && !anchors(readFileSync(absolute, 'utf8')).has(fragment)) errors.push({ path, url, reason: 'missing anchor' })
    }
  }
  return errors
}
export function catalogue(root) {
  const rows = { tools: [], rpc: [], config: [], dependencies: [] }
  for (const path of files(root, '.ts').filter((p) => /^(plugins|packages|src)\//.test(p))) {
    const source = readFileSync(join(root, path), 'utf8'), tree = ast(source)
    for (const n of tree.program.body) {
      if (n.type === 'ImportDeclaration' && n.source.value.startsWith('space-')) rows.dependencies.push([path, n.source.value, n.importKind ?? 'value'])
      const d = n.declaration
      if (d?.type === 'TSInterfaceDeclaration' && /Config$/.test(d.id.name)) rows.config.push([path, d.id.name, declaration(source, d.id.name).text])
    }
    visit(tree, (n) => {
      if (n.type !== 'CallExpression') return
      const callee = source.slice(n.callee.start, n.callee.end)
      if (callee.endsWith('.tools.register') && n.arguments[0]?.type === 'ObjectExpression') {
        const object = n.arguments[0], values = object.properties.filter((p) => p.type === 'ObjectProperty')
        const id = values.find((p) => p.key.name === 'id')?.value
        const title = values.find((p) => p.key.name === 'title')?.value
        const descriptor = object.properties.filter((p) => p.key?.name !== 'handler')
        rows.tools.push([path, id?.value ?? '<dynamic: inspect source>', title?.value ?? '', digest(JSON.stringify(shape(descriptor)))])
      }
      if ((callee.endsWith('.webui.addEntry') || callee.endsWith('.console.addEntry')) && n.arguments[1]?.type === 'ObjectExpression') {
        for (const method of n.arguments[1].properties) {
          const name = method.key?.name ?? method.key?.value
          const params = method.params ?? method.value?.params
          if (name && params) rows.rpc.push([path, name, params.map((p) => source.slice(p.start, p.end)).join(', ')])
        }
      }
    })
  }
  return rows
}
export function generated(root) {
  const rows = catalogue(root), pages = {}
  const index = ['# 源码生成的开发接口目录', '', '> 由 `npm run docs:generate` 生成；仅扫描源码，不读取运行配置或密钥。动态注册需按源码检查，目录不是运行时权限证明。', '']
  for (const [name, entries] of Object.entries(rows)) {
    if (!entries.length) throw new Error(`Empty generated catalogue: ${name}`)
    let page = 1, out = [`# ${name}`, '']
    function flush() { const path = `${name}-${page++}.md`; pages[path] = out.join('\n').trimEnd()+'\n'; index.push(`- [${name} ${page-1}](${path})`); out = [`# ${name}（续）`, ''] }
    for (const [path, symbol, detail, fingerprint] of entries) {
      const rel = relative(join(root, 'docs/generated'), join(root, path))
      const block = [`- [${path}](${rel})：\`${symbol}\`${fingerprint ? ` · ${detail} · descriptor ${fingerprint}` : ''}`]
      if (name === 'config') block.push('', '```ts', detail, '```', '')
      else if (detail && !fingerprint) block.push(`  \`${detail.replaceAll('`', '\\`')}\``)
      if (Buffer.byteLength([...out, ...block].join('\n')) > 16000) flush()
      out.push(...block)
    }
    flush()
  }
  pages['INTERFACES.md'] = index.join('\n')+'\n'
  return pages
}
export function generate(root, check = true) {
  const pages = generated(root), dir = join(root, 'docs/generated')
  for (const [name, text] of Object.entries(pages)) {
    const path = join(dir, name)
    if (check) { if (!existsSync(path) || readFileSync(path, 'utf8') !== text) throw new Error(`Generated interfaces stale: ${name}; npm run docs:generate`) }
    else { mkdirSync(dir, { recursive: true }); writeFileSync(path, text) }
  }
  if (existsSync(dir)) for (const name of readdirSync(dir)) if (name.endsWith('.md') && !pages[name]) {
    if (check) throw new Error(`Obsolete generated file ${name}`)
    awaitRemove(join(dir, name))
  }
}
export function documentChecks(root) {
  const policy = JSON.parse(readFileSync(join(root, '.ci/docs.json'), 'utf8')), errors = []
  const known = new Set(policy.legacyLinks.map((e) => JSON.stringify(e)))
  for (const e of linkErrors(root)) if (!known.has(JSON.stringify(e))) errors.push(JSON.stringify(e))
  for (const [path, max] of Object.entries(policy.budgets)) if (Buffer.byteLength(readFileSync(join(root, path))) > max) errors.push(`${path}: document budget ${max} exceeded`)
  const source = readFileSync(join(root, policy.examples.doc), 'utf8')
  const fences = [...source.matchAll(/```ts\s+([^\n]+)\n([^]*?)\n```/g)]
  for (const item of policy.examples.equivalence) {
    const block = fences.find((f) => f[1] === `type-equiv:${item.symbol}`)
    if (!block) { errors.push(`Missing type-equiv block ${item.symbol}`); continue }
    const expected = declaration(readFileSync(join(root, item.source), 'utf8'), item.symbol), actual = declaration(block[2], item.symbol)
    if (JSON.stringify(expected.structure) !== JSON.stringify(actual.structure) || JSON.stringify(expected.comments) !== JSON.stringify(actual.comments)) errors.push(`Type/JSDoc drift: ${item.symbol}`)
  }
  const compiled = fences.filter((f) => f[1] === 'compile')
  if (!compiled.length) errors.push('No compiled public API examples')
  for (const [index, f] of compiled.entries()) {
    const dir = join(root, 'data/docs-examples'); mkdirSync(dir, { recursive: true }); const path = join(dir, `.example-${process.pid}-${index}.ts`)
    writeFileSync(path, f[2])
    try {
      const run = spawnSync(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '--ignoreConfig', '--noEmit', '--strict', '--skipLibCheck', '--target', 'ES2022', '--module', 'ESNext', '--moduleResolution', 'bundler', '--allowImportingTsExtensions', path], { cwd: root, encoding: 'utf8', timeout: 30000 })
      if (run.status !== 0) errors.push(`Example compile failed: ${run.stdout}${run.stderr}`)
    } finally { (awaitRemove)(path) }
  }
  generate(root, true)
  return errors
}
import { unlinkSync as awaitRemove } from 'node:fs'
if (process.argv[1] && resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  const root = process.cwd(), command = process.argv[2] ?? 'check'
  if (command === 'generate') generate(root, false)
  else {
    const errors = documentChecks(root)
    for (const error of errors) console.error(error)
    if (errors.length) process.exitCode = 1
    console.log(`Documentation: ${errors.length} new violations; ${linkErrors(root).length} legacy links tracked explicitly`)
  }
}
