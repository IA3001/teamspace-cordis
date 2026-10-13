import { parse } from '@babel/parser'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { resolve, relative, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

export function inspectLayers(root) {
  const packages = new Map()
  for (const layer of ['seam', 'impl', 'policy', 'client-ui', 'bundle']) {
    for (const entry of readdirSync(resolve(root, 'packages', layer), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const folder = resolve(root, 'packages', layer, entry.name)
      if (!existsSync(resolve(folder, 'package.json'))) continue
      packages.set(JSON.parse(readFileSync(resolve(folder, 'package.json'))).name, { folder, layer })
    }
  }
  const files = []
  function walk(folder) {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      if (['node_modules', 'dist', 'cache'].includes(entry.name)) continue
      const path = resolve(folder, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (/\.tsx?$/.test(entry.name)) files.push(path)
    }
  }
  walk(resolve(root, 'packages')); walk(resolve(root, 'plugins'))
  const errors = []
  let imports = 0
  for (const file of files) {
    const source = parse(readFileSync(file, 'utf8'), { sourceType: 'module', plugins: ['typescript'] })
    const own = [...packages.values()].find((p) => file.startsWith(`${p.folder}/`))
    const client = relative(root, file).startsWith('packages/client-ui/') && file.includes('/client/')
    function visit(node) {
      if (!node || typeof node !== 'object') return
      let specifier
      let typeOnly = false
      if (['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration'].includes(node.type)) {
        specifier = node.source
        typeOnly = node.importKind === 'type' || node.exportKind === 'type' ||
          (node.specifiers?.length > 0 && node.specifiers.every((s) => s.importKind === 'type' || s.exportKind === 'type'))
      } else if (node.type === 'ImportExpression') {
        specifier = node.source
      } else if (node.type === 'CallExpression' &&
        (node.callee.type === 'Import' || node.callee.name === 'require')) {
        specifier = node.arguments[0]
      }
      if (specifier?.type === 'StringLiteral') {
        imports++
        const name = specifier.value
        const targetPath = name.startsWith('.') ? resolve(dirname(file), name) : null
        const target = [...packages.entries()].find(([pkg, p]) =>
          name === pkg || name.startsWith(`${pkg}/`) || targetPath?.startsWith(`${p.folder}/`))?.[1]
        const pluginTarget = targetPath?.startsWith(resolve(root, 'plugins') + '/')
        const badClient = client && (pluginTarget || (target &&
          (target.layer !== 'client-ui' && !(target.layer === 'seam' && typeOnly))))
        const badImpl = target?.layer === 'impl' && target !== own &&
          (own?.layer === 'impl' || own?.layer === 'policy' || relative(root, file).startsWith('plugins/'))
        if (badClient || badImpl) {
          const line = node.loc.start.line
          errors.push(`${relative(root, file)}:${line}: forbidden dependency ${name}`)
        }
      }
      for (const value of Object.values(node)) {
        if (Array.isArray(value)) value.forEach(visit)
        else if (value?.type) visit(value)
      }
    }
    visit(source)
  }
  if (!files.length || !imports) errors.push('Layer scanner found no source files or imports')
  return { errors, files: files.length, imports }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = inspectLayers(process.cwd())
  console.log(`Layer scan: ${result.files} files, ${result.imports} imports`)
  for (const error of result.errors) console.error(error)
  process.exitCode = result.errors.length ? 1 : 0
}
