#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { basename, dirname, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { countTree, generateHtml, groupRootFiles, loadMetadata, scanTree } from './project-tree-html.mjs'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const defaultRoot = resolve(scriptDir, '..')
const statuses = new Set(['todo', 'in-progress', 'done', 'blocked'])
const maxBodyBytes = 2 * 1024 * 1024
const maxTextDiffBytes = 1024 * 1024

function parseArgs(args) {
  const options = { root: defaultRoot, port: 0 }
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (arg === '--root' || arg === '--port') {
      const value = args[++index]
      if (!value || value.startsWith('--')) throw new Error(`${arg} 后面需要一个值`)
      if (arg === '--root') options.root = resolve(value)
      else {
        options.port = Number(value)
        if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) throw new Error('--port 必须是 0 到 65535 之间的整数')
      }
    }
    else if (arg === '--help' || arg === '-h') options.help = true
    else throw new Error(`未知参数：${arg}`)
  }
  return options
}

function printHelp() {
  console.log(`用法：node scripts/project-tree-server.mjs [选项]

选项：
  --root <目录>  Git 项目根目录（默认当前仓库）
  --port <端口>  监听端口，默认由系统分配空闲端口
  --help         显示帮助`)
}

function git(root, args, encoding = 'utf8') {
  return execFileSync('git', ['-C', root, ...args], { encoding, maxBuffer: 32 * 1024 * 1024, windowsHide: true })
}

function normalizePath(path) {
  return path.split(sep).join('/')
}

function collectNodePaths(node, paths = new Set()) {
  paths.add(node.path)
  for (const child of node.children) collectNodePaths(child, paths)
  return paths
}

function annotationDirectory(root, { create = false } = {}) {
  const directory = resolve(root, 'scripts')
  try { lstatSync(directory) }
  catch (error) {
    if (error.code !== 'ENOENT') throw error
    if (!create) return null
    mkdirSync(directory)
  }
  const info = lstatSync(directory)
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('为保护项目目录，规划卡只能保存到项目内的普通 scripts 目录。')
  const realRoot = realpathSync(root)
  const realDirectory = realpathSync(directory)
  const rel = relative(realRoot, realDirectory)
  if (rel !== 'scripts') throw new Error('规划卡目录必须是项目仓库内部的 scripts 目录。')
  return directory
}

function annotationsFile(root, { createDirectory = false } = {}) {
  const directory = annotationDirectory(root, { create: createDirectory })
  if (!directory) return null
  const path = resolve(directory, 'project-tree.annotations.json')
  try {
    const info = lstatSync(path)
    if (info.isSymbolicLink() || !info.isFile()) throw new Error('规划卡数据必须是 scripts 目录内的普通文件。')
    if (realpathSync(path) !== resolve(realpathSync(directory), 'project-tree.annotations.json')) throw new Error('规划卡数据路径必须位于项目仓库内部。')
  }
  catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  return path
}

function readAnnotations(root) {
  const path = annotationsFile(root)
  if (!path || !existsSync(path)) return { version: 1, cards: [] }
  const value = JSON.parse(readFileSync(path, 'utf8'))
  if (value?.version !== 1 || !Array.isArray(value.cards)) throw new Error('project-tree.annotations.json 格式无效：需要 version 1 和 cards 数组')
  return value
}

function validatedAnnotations(root, metadata) {
  return validateAnnotations(readAnnotations(root), collectNodePaths(makeTree(root, metadata)), { allowMissingPaths: true })
}

function validateAnnotations(value, nodePaths, { allowMissingPaths = false } = {}) {
  if (!value || value.version !== 1 || !Array.isArray(value.cards)) throw new Error('标注数据必须包含 version: 1 和 cards 数组')
  if (value.cards.length > 2000) throw new Error('标注卡片数量不能超过 2000')
  const ids = new Set()
  const cards = value.cards.map((card, index) => {
    if (!card || typeof card !== 'object' || Array.isArray(card)) throw new Error(`第 ${index + 1} 张卡片格式无效`)
    const { id, title, instruction, status, tags, nodePaths: cardPaths, createdAt, updatedAt } = card
    if (typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) || ids.has(id)) throw new Error(`第 ${index + 1} 张卡片 ID 无效或重复`)
    ids.add(id)
    if (typeof title !== 'string' || !title.trim() || title.length > 160) throw new Error(`第 ${index + 1} 张卡片标题须为 1–160 个字符`)
    if (typeof instruction !== 'string' || instruction.length > 10000) throw new Error(`第 ${index + 1} 张卡片指令不能超过 10000 个字符`)
    if (!statuses.has(status)) throw new Error(`第 ${index + 1} 张卡片状态无效`)
    if (!Array.isArray(tags) || tags.length > 30 || tags.some((tag) => typeof tag !== 'string' || !tag.trim() || tag.length > 40)) throw new Error(`第 ${index + 1} 张卡片标签格式无效`)
    if (new Set(tags).size !== tags.length) throw new Error(`第 ${index + 1} 张卡片不能包含重复标签`)
    if (!Array.isArray(cardPaths) || !cardPaths.length || cardPaths.length > 100 || new Set(cardPaths).size !== cardPaths.length) throw new Error(`第 ${index + 1} 张卡片至少关联一个节点，且不能重复`)
    for (const path of cardPaths) {
      const unsafe = typeof path !== 'string' || path.length > 1024 || path.includes('\\') || path.includes('\0') || path.startsWith('/') || /^[a-z]:/i.test(path) || path.split('/').some((part) => part === '..' || part === '.')
      if (unsafe || (!allowMissingPaths && !nodePaths.has(path))) {
        throw new Error(`第 ${index + 1} 张卡片包含无效项目路径：${String(path)}`)
      }
    }
    for (const [name, timestamp] of [['createdAt', createdAt], ['updatedAt', updatedAt]]) {
      if (typeof timestamp !== 'string' || Number.isNaN(Date.parse(timestamp))) throw new Error(`第 ${index + 1} 张卡片 ${name} 无效`)
    }
    return { id, title: title.trim(), instruction, status, tags: [...tags], nodePaths: [...cardPaths], createdAt, updatedAt }
  })
  return { version: 1, cards }
}

function atomicSave(root, value) {
  const path = annotationsFile(root, { createDirectory: true })
  const temporaryPath = `${path}.tmp-${process.pid}-${randomUUID()}`
  writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
  renameSync(temporaryPath, path)
}

function parseGitStatus(root) {
  const output = git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])
  const records = output.split('\0')
  const changes = []
  for (let index = 0; index < records.length; index++) {
    const record = records[index]
    if (!record) continue
    const code = record.slice(0, 2)
    const path = normalizePath(record.slice(3))
    let oldPath
    if (code.includes('R') || code.includes('C')) oldPath = normalizePath(records[++index] ?? '')
    let kind = 'modified'
    if (code === '??') kind = 'untracked'
    else if (code.includes('R')) kind = 'renamed'
    else if (code.includes('C')) kind = 'copied'
    else if (code.includes('D')) kind = 'deleted'
    else if (code.includes('A')) kind = 'added'
    changes.push({ path, oldPath, code, kind })
  }
  return changes.sort((a, b) => a.path.localeCompare(b.path, 'zh-CN'))
}

function changedFileDiff(root, change) {
  if (change.kind === 'untracked') {
    const absolutePath = resolve(root, change.path)
    const rel = relative(root, absolutePath)
    if (!rel || rel.startsWith(`..${sep}`) || rel === '..') throw new Error('文件路径超出项目根目录')
    const info = lstatSync(absolutePath)
    if (info.isSymbolicLink()) return { binary: true, text: '符号链接文件已变化，出于安全考虑不读取其目标内容。' }
    if (!info.isFile()) return { binary: true, text: '非普通文件，无法显示文本差异。' }
    if (info.size > maxTextDiffBytes) return { binary: true, text: `文件大于 ${maxTextDiffBytes / 1024 / 1024} MiB，已省略文本内容。` }
    const buffer = readFileSync(absolutePath)
    if (buffer.includes(0)) return { binary: true, text: '二进制文件已新增，不显示文本差异。' }
    let body
    try { body = new TextDecoder('utf-8', { fatal: true }).decode(buffer) }
    catch { return { binary: true, text: '无法按 UTF-8 解码，按二进制文件处理。' } }
    const lines = body.replace(/\r\n/g, '\n').split('\n')
    if (lines.at(-1) === '') lines.pop()
    return {
      binary: false,
      text: `diff --git a/${change.path} b/${change.path}\nnew file mode 100644\n--- /dev/null\n+++ b/${change.path}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((line) => `+${line}`).join('\n')}${lines.length ? '\n' : ''}`,
    }
  }
  const args = ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--unified=3', '--find-renames', 'HEAD', '--']
  if (change.oldPath) args.push(change.oldPath)
  args.push(change.path)
  const text = git(root, args)
  return { binary: /^Binary files |^GIT binary patch/m.test(text), text: text || '没有可显示的文本差异。' }
}

function sendJson(response, statusCode, value) {
  response.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  response.end(JSON.stringify(value))
}

async function readJson(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > maxBodyBytes) throw Object.assign(new Error('请求内容不能超过 2 MiB'), { statusCode: 413 })
    chunks.push(chunk)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) }
  catch { throw Object.assign(new Error('请求不是有效的 JSON'), { statusCode: 400 }) }
}

function makeTree(root, metadata) {
  return groupRootFiles(scanTree(root, resolve(root, 'data/dev/project-tree.html'), metadata))
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) return printHelp()
  const root = resolve(options.root)
  const top = git(root, ['rev-parse', '--show-toplevel']).trim()
  if (resolve(top) !== root) throw new Error(`--root 必须指向 Git 仓库根目录：${top}`)
  const metadata = loadMetadata()
  const server = createServer(async (request, response) => {
    const address = server.address()
    const expectedHost = `127.0.0.1:${address.port}`
    if (request.headers.host !== expectedHost) return sendJson(response, 403, { error: '仅允许通过本机地址访问' })
    const origin = request.headers.origin
    if (origin && origin !== `http://${expectedHost}`) return sendJson(response, 403, { error: '跨站请求已拒绝' })
    const url = new URL(request.url, `http://${expectedHost}`)
    try {
      if (request.method === 'GET' && url.pathname === '/') {
        const { html } = generateHtml({ root, output: resolve(root, 'data/dev/project-tree.html'), apiBase: '/api' })
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
        response.end(html)
        return
      }
      if (request.method === 'GET' && url.pathname === '/api/tree') {
        const tree = makeTree(root, metadata)
        return sendJson(response, 200, { tree, counts: countTree(tree) })
      }
      if (request.method === 'GET' && url.pathname === '/api/annotations') return sendJson(response, 200, validatedAnnotations(root, metadata))
      if (request.method === 'PUT' && url.pathname === '/api/annotations') {
        if (!request.headers['content-type']?.startsWith('application/json')) return sendJson(response, 415, { error: 'Content-Type 必须为 application/json' })
        const paths = collectNodePaths(makeTree(root, metadata))
        let value
        try { value = validateAnnotations(await readJson(request), paths) }
        catch (error) { error.statusCode ||= 400; throw error }
        atomicSave(root, value)
        return sendJson(response, 200, value)
      }
      if (request.method === 'GET' && url.pathname === '/api/git/changes') return sendJson(response, 200, { changes: parseGitStatus(root) })
      if (request.method === 'GET' && url.pathname === '/api/git/diff') {
        const requestedPath = url.searchParams.get('path')
        if (!requestedPath) return sendJson(response, 400, { error: '缺少 path 参数' })
        const change = parseGitStatus(root).find((item) => item.path === requestedPath || item.oldPath === requestedPath)
        if (!change) return sendJson(response, 404, { error: '该文件当前没有工作区改动' })
        return sendJson(response, 200, { change, ...changedFileDiff(root, change) })
      }
      return sendJson(response, 404, { error: '没有这个本机接口' })
    }
    catch (error) {
      return sendJson(response, error.statusCode ?? 500, { error: error.message })
    }
  })
  server.on('error', (error) => { console.error(`项目地图服务启动失败：${error.message}`); process.exitCode = 1 })
  server.listen(options.port, '127.0.0.1', () => {
    const { port } = server.address()
    console.log(`项目地图开发视图已启动：http://127.0.0.1:${port}/`)
    console.log('按 Ctrl+C 停止；服务只监听本机地址。')
  })
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)))
}

try { main() }
catch (error) {
  if (error?.message === 'Help requested') process.exit(0)
  console.error(`项目地图服务启动失败：${error.message}`)
  process.exitCode = 1
}
