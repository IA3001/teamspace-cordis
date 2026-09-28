// compose.ts —— P5 组合引擎：bundle 层 + 用户层叠加成 loader 清单（断言 ③ 的执行者）。
//
// 规则（MODULE-PLAN 铁律 3 / 3.6 节 / 第 6 节断言 ③）：
//   · 清单从空根开始，bundle 层按序 insert，用户层最后写赢（方案 A：单进程多面）
//   · 同 id 后层出现 = 整项替换（整体替换，不深合并）；层内重复 id = 报错
//   · 断言 ③：任一 id 最多出现在「一个 bundle 层文件 + 一个用户层文件」——
//     出现在两个 bundle 层、或多个用户层文件，即判红
//   · patch 文件支持 !!js 表达式（与 cordis loader 同款语义）。compose 对表达式
//     **不求值**：读入时包成 { __jsExpr } 标记，写出时原样还原 !!js 原文——
//     求值时机与语义完全交给 loader（plugin-include），零语义漂移；lint 阶段
//     因此也不需要加载 .env。tag 机制照抄 @cordisjs/plugin-include 的 JsExpr。
//   · 本文件零业务：只懂「层、id、叠加」。
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'
import {
  defineScalarTag,
  dump as dumpYaml,
  JSON_SCHEMA,
  load as parseYaml,
  NOT_RESOLVED,
} from 'js-yaml'

/** 一行插件配置（形状同 cordis.yml 顶层元素，字段落全靠 loader 校验）。 */
type PatchEntry = Record<string, any>

interface Layer {
  /** patch 文件绝对路径（观测/报错用） */
  file: string
  kind: 'bundle' | 'profile'
  entries: PatchEntry[]
}

// !!js 往返标签（照抄 @cordisjs/plugin-include/lib/index.js 的 JsExpr，2026-09-28 核实）：
//   读入：!!js <文本> → { __jsExpr: <文本> }（不求值）
//   写出：identify 选中标记对象，represent 还原 !!js <文本>
// 与 plugin-include 唯一的差别是用的 js-yaml 大版本不同（本项目 ^5.4.2 的新
// defineScalarTag API，plugin-include 内嵌的是 4.x 的 yaml.Type），语义一致。
const jsTag = defineScalarTag<{ __jsExpr: string }>('tag:yaml.org,2002:js', {
  resolve: (source) => (typeof source === 'string' ? { __jsExpr: source } : NOT_RESOLVED),
  identify: (d: any) => typeof d === 'object' && d !== null && '__jsExpr' in d,
  represent: (d: any) => d.__jsExpr,
})
// lineWidth: -1 = 不限宽，防长表达式被折叠成块标量（实测 2026-09-28，真实表达式均单行还原）
const composeSchema = JSON_SCHEMA.withTags(jsTag)

function listDirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => resolve(dir, d.name))
      .sort()
  } catch {
    return []
  }
}

function loadPatch(file: string, kind: Layer['kind']): Layer {
  let raw: unknown
  try {
    raw = parseYaml(readFileSync(file, 'utf8'), { schema: composeSchema })
  } catch (err) {
    throw new Error(`patch 文件解析失败：${file}\n  ${(err as Error).message}`)
  }
  if (!Array.isArray(raw)) {
    throw new Error(`patch 文件顶层必须是数组：${file}`)
  }
  const entries = raw as PatchEntry[]
  const seen = new Set<string>()
  for (const e of entries) {
    if (!e || typeof e.id !== 'string' || e.id === '') {
      throw new Error(`patch 文件存在缺 id（或 id 非字符串）的行：${file}`)
    }
    if (seen.has(e.id)) {
      throw new Error(`patch 文件内同 id 重复：${file} 的「${e.id}」`)
    }
    seen.add(e.id)
  }
  return { file, kind, entries }
}

/** 收集全部 patch 层：bundle 层（space-base 固定最前，其余字母序）+ 用户层（profiles/*，字母序）。 */
export function collectLayers(): Layer[] {
  const layers: Layer[] = []

  const bundleDirs = listDirs(resolve(process.cwd(), 'packages/bundle'))
  const bundles = bundleDirs
    .map((d) => {
      const pkgPath = resolve(d, 'package.json')
      if (!existsSync(pkgPath)) return null
      let patchRel: unknown
      try {
        patchRel = JSON.parse(readFileSync(pkgPath, 'utf8'))?.cordis?.bundle?.patch
      } catch {
        return null
      }
      return typeof patchRel === 'string' && patchRel !== '' ? resolve(d, patchRel) : null
    })
    .filter((f): f is string => f !== null)
  // space-base 必须是第一层（字母序天然满足，这里显式钉死，防未来改名漂移）
  bundles.sort((a, b) => {
    const ab = basename(a) === 'cordis.patch.yml' ? basename(dirname(a)) : ''
    const bb = basename(b) === 'cordis.patch.yml' ? basename(dirname(b)) : ''
    if (ab === 'space-base') return -1
    if (bb === 'space-base') return 1
    return ab.localeCompare(bb)
  })
  for (const f of bundles) layers.push(loadPatch(f, 'bundle'))

  for (const d of listDirs(resolve(process.cwd(), 'profiles'))) {
    const f = resolve(d, 'cordis.patch.yml')
    if (existsSync(f)) layers.push(loadPatch(f, 'profile'))
  }
  return layers
}

/** 断言 ③ 校验：返回错误列表（空 = 通过）。 */
export function lintLayers(): string[] {
  let layers: Layer[]
  try {
    layers = collectLayers()
  } catch (err) {
    return [(err as Error).message]
  }
  if (layers.length === 0) {
    return ['没有任何 patch 层——packages/bundle/*/package.json 缺 cordis.bundle.patch 声明？']
  }

  const errors: string[] = []
  // id → { bundle 层文件, 用户层文件, 出现总次数 }
  const ledger = new Map<string, { bundle?: string; profile?: string; count: number }>()
  for (const l of layers) {
    for (const e of l.entries) {
      const rec = ledger.get(e.id) ?? { count: 0 }
      rec.count++
      if (l.kind === 'bundle') {
        if (rec.bundle) {
          errors.push(`断言③：id「${e.id}」出现在两个 bundle 层（${rec.bundle} 与 ${l.file}）——bundle 层之间禁止同 id`)
        }
        rec.bundle = l.file
      } else {
        if (rec.profile) {
          errors.push(`断言③：id「${e.id}」出现在多个用户层文件（${rec.profile} 与 ${l.file}）——用户层内部禁止同 id`)
        }
        rec.profile = l.file
      }
      if (rec.count > 2) {
        errors.push(`断言③：id「${e.id}」出现 ${rec.count} 层（上限 = 一个 bundle 层 + 用户层）`)
      }
      ledger.set(e.id, rec)
    }
  }
  return errors
}

export interface ComposeResult {
  /** 产物绝对路径 */
  path: string
  /** 合成后的总行数 */
  total: number
  /** 其中 disabled 的行数 */
  disabled: number
  /** 各层贡献行数（观测用） */
  layers: { file: string; count: number }[]
}

/** 叠加全部层并写出产物。断言 ③ 不过 = 抛错（调用方决定退出码 / 启动失败）。 */
export function composeTo(outPath: string): ComposeResult {
  const errors = lintLayers()
  if (errors.length > 0) {
    throw new Error(`组合清单校验失败：\n  ${errors.join('\n  ')}`)
  }
  const layers = collectLayers()
  const byId = new Map<string, PatchEntry>()
  for (const l of layers) {
    for (const e of l.entries) {
      byId.set(e.id, e) // 后写赢：整项替换（不深合并，铁律 3）
    }
  }
  const composed = [...byId.values()]
  const disabled = composed.filter((e) => e.disabled === true).length

  const abs = resolve(process.cwd(), outPath)
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, dumpYaml(composed, { schema: composeSchema, lineWidth: -1 }))
  return {
    path: abs,
    total: composed.length,
    disabled,
    layers: layers.map((l) => ({ file: l.file, count: l.entries.length })),
  }
}
