#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const defaultRoot = resolve(scriptDir, '..')
const defaultOutput = resolve(defaultRoot, 'data/dev/project-tree.html')

function parseArgs(args) {
  const options = { root: defaultRoot, output: defaultOutput }
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--root' || arg === '--out') {
      const value = args[++i]
      if (!value || value.startsWith('--')) throw new Error(`${arg} 后面需要一个路径`)
      options[arg === '--root' ? 'root' : 'output'] = resolve(value)
    }
    else if (arg === '--help' || arg === '-h') options.help = true
    else throw new Error(`未知参数：${arg}`)
  }
  return options
}

function printHelp() {
  console.log(`用法：node scripts/project-tree-html.mjs [选项]

选项：
  --root <目录>  要扫描的项目根目录（默认当前仓库）
  --out <文件>   输出 HTML 文件（默认 data/dev/project-tree.html）
  --help         显示帮助`)
}

export function loadMetadata() {
  const path = resolve(scriptDir, 'project-tree.metadata.json')
  const metadata = JSON.parse(readFileSync(path, 'utf8'))
  if (!Array.isArray(metadata.modules)) throw new Error('project-tree.metadata.json 必须包含 modules 数组')
  for (const module of metadata.modules) {
    if (!module.id || !module.label || !Array.isArray(module.paths) || !module.paths.length) {
      throw new Error(`模块元数据缺少 id、label 或 paths：${JSON.stringify(module)}`)
    }
    if (!/^#[\da-f]{6}$/i.test(module.color ?? '')) {
      throw new Error(`模块 ${module.id} 的 color 必须是 #RRGGBB 格式`)
    }
  }
  metadata.moduleRules = [...metadata.modules].sort((a, b) => {
    const aLength = Math.max(...a.paths.map((item) => item.length))
    const bLength = Math.max(...b.paths.map((item) => item.length))
    return bLength - aLength
  })
  return metadata
}

function moduleClass(id) {
  return `module-${String(id).toLowerCase().replace(/[^a-z0-9_-]/g, '-')}`
}

function normalizedPath(path) {
  return path.replaceAll('\\', '/')
}

function isExcluded(path, root, outputPath, metadata) {
  const normalized = normalizedPath(path)
  const name = normalized.split('/').at(-1)
  const exclude = metadata.exclude ?? {}
  if (resolve(outputPath) === resolve(root, path)) return true
  if (name === '.env' || (name.startsWith('.env.') && name !== '.env.example')) return true
  if ((exclude.directoryNames ?? []).some((part) => normalized.split('/').includes(part))) return true
  if ((exclude.exactPaths ?? []).includes(normalized)) return true
  if ((exclude.fileSuffixes ?? []).some((suffix) => name.endsWith(suffix))) return true
  return false
}

function findModule(path, metadata) {
  const rule = metadata.moduleRules.find((module) => module.paths.some((prefix) => path === prefix || path.startsWith(`${prefix}/`)))
  if (rule) return rule
  const top = path.split('/')[0] || 'root'
  return { id: `auto-${top}`, label: `其他 · ${top}`, color: '#a5aeba', description: '未配置专属说明的项目模块。可在 scripts/project-tree.metadata.json 中添加颜色和说明。' }
}

const readableTerms = {
  agent: '智能体', agents: '智能体', activity: '活动', admin: '管理', auth: '身份验证', authz: '权限',
  api: '接口', approval: '审批', archive: '归档', attachment: '附件', audit: '审计', bus: '事件总线',
  cache: '缓存', catalog: '目录', child: '子项', client: '客户端', command: '命令', config: '配置',
  context: '上下文', cors: '跨域', decision: '决策', dialog: '对话', dispatch: '分发', embedding: '向量',
  embedder: '向量生成', error: '错误', event: '事件', execution: '执行', feedback: '反馈', flow: '流程',
  graph: '流程图', group: '分组', health: '健康检查', history: '历史记录', identity: '身份', inbox: '收件箱',
  index: '入口', knowledge: '知识', kb: '知识库', labels: '显示名称', llm: '大语言模型', loader: '加载器',
  markdown: 'Markdown', memory: '记忆', mention: '提及', message: '消息', migration: '数据库变更',
  new: '新', notification: '通知', operations: '操作', openai: 'OpenAI', orchestrator: '协调调度',
  policy: '策略', prompt: '提示词', progress: '进度', reaction: '表情回应', recorder: '记录器', registry: '注册表',
  retrieval: '检索', runtime: '运行时', sandbox: '沙箱', search: '搜索', session: '会话', settings: '设置',
  shared: '共享', speech: '发言', staging: '暂存区', store: '数据存储', summary: '摘要', teamspace: '团队空间',
  template: '模板', tool: '工具', tools: '工具', ui: '界面', upload: '上传', user: '用户', users: '用户',
  web: '网页', work: '任务', workdir: '工作目录', workspace: '工作区',
}

function readableFileTopic(path) {
  let file = basename(path)
  if (file === 'index.ts') {
    const parts = path.split('/')
    file = parts.at(-2) === 'src' || parts.at(-2) === 'client' ? parts.at(-3) : parts.at(-2)
  }
  file = file.replace(/\.up\.sql$|\.down\.sql$|\.test\.[^.]+$|\.d\.ts$|\.[^.]+$/, '')
  const parts = file.split(/[-_.]+/).filter(Boolean).filter((part) => !['space', 'client', 'src', 'index', 'test'].includes(part.toLowerCase()))
  return parts.map((part) => readableTerms[part.toLowerCase()] ?? part).join('') || file
}

function describeFile(path, module) {
  const file = basename(path)
  const topic = readableFileTopic(path)
  if (path === 'package.json') return '项目的命令和依赖清单：列出如何启动、检查项目，以及运行时需要哪些第三方工具。'
  if (file === 'package.json') return `「${module.label}」这个包的说明书：记录包名、依赖和它提供的命令。`
  if (file === 'index.ts' && path.startsWith('packages/seam/')) {
    return `定义「${topic}」这项能力的调用约定，让其他部分知道可以调用什么；这里主要放接口说明，不负责具体数据库操作。`
  }
  if (file === 'index.ts' && path.startsWith('packages/impl/')) {
    return `「${topic}」的具体实现入口：把项目约定的接口接到实际技术能力上，例如数据库或模型服务。`
  }
  if (file === 'index.ts' && path.startsWith('packages/policy/')) {
    return `「${topic}」策略的入口：集中放置可替换的判断规则，让其他模块按统一方式使用。`
  }
  if (file === 'index.ts' && path.startsWith('plugins/')) {
    return `「${topic}」插件的启动入口：在系统启动时注册这项功能，并连接它需要的服务。`
  }
  if (file === 'index.ts' && path.includes('/client/')) {
    return `「${topic}」浏览器界面的入口：把页面功能、按钮操作和服务端接口连接起来。`
  }
  if (file === 'index.ts') return `「${topic}」模块的入口文件：负责把这个目录里的功能接入项目。`
  if (/\.up\.sql$/.test(file)) return `数据库升级步骤：为「${topic}」相关功能新增或调整数据结构。升级时由项目自动执行。`
  if (/\.down\.sql$/.test(file)) return `数据库回退步骤：撤销「${topic}」这次升级造成的结构变化。`
  if (/\.test\.[^.]+$/.test(file)) return `自动测试：检查「${topic}」相关功能在常见情况下是否正常工作。`
  if (file === 'README.md') return `「${module.label}」目录的使用说明，帮助了解这里的功能和运行方式。`
  if (file === 'AGENTS.md') return '这个目录的开发说明：告诉维护者需要遵守哪些规则、先看哪些文档。'
  if (file === 'tsconfig.json') return 'TypeScript 检查设置：决定这个目录里的代码如何进行类型检查和编译。'
  if (file === 'cordis.patch.yml') return '功能组合清单：决定这个运行表面会加载哪些插件。'
  if (/\.md$/.test(file)) return `「${topic}」说明文档：介绍相关功能、开发约定或操作步骤。`
  if (/\.json$/.test(file)) return `「${topic}」配置文件：由项目读取，用来决定相关功能如何运行。`
  if (/\.ya?ml$/.test(file)) return `「${topic}」配置文件：用来设置相关功能或选择要加载的组件。`
  if (/\.d\.ts$/.test(file)) return `「${topic}」类型声明：帮助 TypeScript 识别项目中使用的对象和接口。`
  if (/\.(ts|tsx|mjs|js)$/.test(file)) return `这份代码处理「${topic}」相关逻辑，属于「${module.label}」。具体职责可在 scripts/project-tree.metadata.json 中为它补充说明。`
  if (/\.css$/.test(file)) return `「${topic}」界面的样式设置，控制相关页面元素的外观。`
  return `「${topic}」相关文件，属于「${module.label}」模块。`
}

function describe(path, kind, childCount, module, metadata) {
  if (path === '') return metadata.rootDescription
  if (metadata.fileDescriptions?.[path]) return metadata.fileDescriptions[path]
  const exactModule = metadata.modules.find((item) => item.paths.includes(path))
  if (exactModule && kind === 'directory') return exactModule.description
  if (kind === 'directory') {
    return `${module.description} 此目录当前包含 ${childCount} 项。`
  }
  return describeFile(path, module)
}

export function scanTree(root, outputPath, metadata) {
  const rootNode = {
    name: 'teamspace-cordis',
    path: '',
    kind: 'directory',
    module: { id: 'root', label: '项目根目录', color: '#a5aeba', description: metadata.rootDescription },
    children: [],
  }
  const top = execFileSync('git', ['-C', root, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()
  if (resolve(top) !== resolve(root)) throw new Error(`--root 必须指向 Git 仓库根目录：${top}`)
  const paths = execFileSync('git', ['-C', root, 'ls-files', '--cached', '--others', '--exclude-standard', '-z'], { encoding: 'buffer' })
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .map((path) => normalizedPath(path))
    .filter((path) => !isExcluded(path, root, outputPath, metadata))
  let changedPaths = []
  try {
    execFileSync('git', ['-C', root, 'rev-parse', '--verify', 'HEAD'], { stdio: ['ignore', 'pipe', 'ignore'] })
    changedPaths = execFileSync('git', ['-C', root, 'diff', '--name-only', '--no-renames', '-z', 'HEAD', '--'], { encoding: 'buffer' })
      .toString('utf8')
      .split('\0')
      .filter(Boolean)
      .map((path) => normalizedPath(path))
      .filter((path) => !isExcluded(path, root, outputPath, metadata))
  }
  catch { /* A valid repository may not have a commit yet. */ }
  const uniquePaths = [...new Set([...paths, ...changedPaths])].sort((a, b) => a.localeCompare(b, 'zh-CN'))

  const nodes = new Map([['', rootNode]])
  for (const path of uniquePaths) {
    const parts = path.split('/')
    for (let index = 0; index < parts.length; index++) {
      const nodePath = parts.slice(0, index + 1).join('/')
      if (nodes.has(nodePath)) continue
      const parentPath = parts.slice(0, index).join('/')
      const parent = nodes.get(parentPath)
      const isFile = index === parts.length - 1
      const module = findModule(nodePath, metadata)
      const node = {
        name: parts[index],
        path: nodePath,
        kind: isFile ? 'file' : 'directory',
        module: { id: module.id, label: module.label, color: module.color, description: module.description },
        children: [],
      }
      parent.children.push(node)
      nodes.set(nodePath, node)
    }
  }

  function annotate(node) {
    node.children.sort((a, b) => Number(b.kind === 'directory') - Number(a.kind === 'directory') || a.name.localeCompare(b.name, 'zh-CN'))
    node.description = describe(node.path, node.kind, node.children.length, node.module, metadata)
    for (const child of node.children) annotate(child)
  }
  annotate(rootNode)
  return rootNode
}

export function countTree(node) {
  let files = node.kind === 'directory' ? 0 : 1
  let directories = node.kind === 'directory' && node.path !== '' && !node.virtual ? 1 : 0
  for (const child of node.children) {
    const count = countTree(child)
    files += count.files
    directories += count.directories
  }
  return { files, directories }
}

export function groupRootFiles(tree) {
  const rootFiles = tree.children.filter((child) => child.kind === 'file')
  if (!rootFiles.length) return tree
  tree.children = tree.children.filter((child) => child.kind !== 'file')
  tree.children.push({
    name: '根目录文件',
    path: '@root-files',
    kind: 'directory',
    virtual: true,
    module: tree.module,
    children: rootFiles,
    description: `仓库根目录下的 ${rootFiles.length} 个独立文件，为保持画布清晰按组展示。`,
  })
  return tree
}

function safeJson(value) {
  return JSON.stringify(value)
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e')
    .replaceAll('&', '\\u0026')
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029')
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character])
}

export function renderPage(tree, counts, projectName, metadata, apiBase = '') {
  const template = readFileSync(resolve(scriptDir, 'project-tree-atlas.template.html'), 'utf8')
  const moduleOptions = metadata.modules
    .map((module) => `<option value="${escapeHtml(module.id)}">${escapeHtml(module.label)}</option>`)
    .join('')
  const values = {
    PROJECT: escapeHtml(projectName),
    DIRECTORIES: String(counts.directories),
    FILES: String(counts.files),
    MODULE_OPTIONS: moduleOptions,
    TREE_JSON: safeJson(tree),
    API_BASE: safeJson(apiBase),
  }
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (_, key) => values[key] ?? '')
}

export function generateHtml(options = parseArgs(process.argv.slice(2))) {
  const root = resolve(options.root)
  const output = resolve(options.output)
  const metadata = loadMetadata()
  const tree = groupRootFiles(scanTree(root, output, metadata))
  const counts = countTree(tree)
  const html = renderPage(tree, counts, basename(root), metadata, options.apiBase ?? '')
  return { html, tree, counts, root, output, metadata }
}

function runCli() {
try {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    printHelp()
    process.exit(0)
  }
  const { html, counts, output } = generateHtml(options)
  mkdirSync(dirname(output), { recursive: true })
  writeFileSync(output, html, 'utf8')
  console.log(`项目文件树已生成：${output}`)
  console.log(`共 ${counts.directories} 个目录、${counts.files} 个文件`)
} catch (error) {
  console.error(`生成失败：${error.message}`)
  process.exitCode = 1
}
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) runCli()
