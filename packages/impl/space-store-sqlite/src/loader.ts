// 迁移链加载器 —— 插件（schema_version 校验）与 CLI（scripts/store.ts）共用。
//
// 承旧系统 store/migrate.go 的 LoadMigrations 口径：
//   · 成对的 NNNN_名字.up.sql / .down.sql，缺一半即报错（铁律 3）
//   · 编号重复 / 名字不一致 / 编号无法解析 → 报错
//   · 按编号升序返回
//
// 注意：本文件属于 impl 层，允许 IO（node:fs）；seam 层禁止（断言 ②）。
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export interface Migration {
  version: number
  name: string
  up: string
  down: string
}

export function loadMigrations(dir: string): Migration[] {
  const entries = readdirSync(dir)
  const byVersion = new Map<number, Migration>()
  const names = new Map<number, { up?: string; down?: string }>()

  for (const file of entries) {
    if (!file.endsWith('.sql')) continue
    const stem = file.replace(/\.sql$/, '') // 0001_svc_session.up
    const underscore = stem.indexOf('_')
    if (underscore <= 0) {
      throw new Error(`迁移文件名不合规（应 NNNN_名字.up.sql / .down.sql）: ${file}`)
    }
    const numStr = stem.slice(0, underscore)
    const version = Number(numStr)
    if (!Number.isInteger(version) || version <= 0) {
      throw new Error(`迁移编号无法解析: ${file}`)
    }
    const rest = stem.slice(underscore + 1) // svc_session.up
    const isUp = rest.endsWith('.up')
    const isDown = rest.endsWith('.down')
    if (!isUp && !isDown) {
      throw new Error(`迁移文件名既不以 .up 也不以 .down 结尾: ${file}`)
    }
    const name = rest.replace(/\.up$/, '').replace(/\.down$/, '')
    if (!name) throw new Error(`迁移名字为空: ${file}`)

    const seen = names.get(version) ?? {}
    if (isUp && seen.up !== undefined) throw new Error(`迁移 ${version} 有重复的 .up`)
    if (isDown && seen.down !== undefined) throw new Error(`迁移 ${version} 有重复的 .down`)
    if (isUp) seen.up = name
    else seen.down = name
    names.set(version, seen)

    const body = readFileSync(join(dir, file), 'utf8')
    const m = byVersion.get(version) ?? { version, name, up: '', down: '' }
    if (m.name !== name) {
      throw new Error(`迁移 ${version} 的 up/down 名字不一致: ${m.name} vs ${name}`)
    }
    if (isUp) m.up = body
    else m.down = body
    byVersion.set(version, m)
  }

  const out = [...byVersion.values()].sort((a, b) => a.version - b.version)
  for (const m of out) {
    if (!m.up) throw new Error(`迁移 ${m.version} (${m.name}) 缺少 .up.sql`)
    if (!m.down) throw new Error(`迁移 ${m.version} (${m.name}) 缺少 .down.sql`)
  }
  if (out.length === 0) throw new Error(`迁移目录没有任何迁移: ${dir}`)
  return out
}

/** 期望的 schema 版本 = 迁移链最大编号。 */
export function expectedVersion(dir: string): number {
  const ms = loadMigrations(dir)
  return ms[ms.length - 1]!.version
}

/**
 * 当前库内 schema 版本；库还没跑过迁移（无 schema_version 表）时返回 0。
 * （schema_version 表是**记账设施**，不是业务表：由运行器创建、只被运行器读写，
 * 因此它不进迁移链 —— 进链会有"第一条迁移之前谁建表"的自举矛盾。）
 */
export function currentVersion(db: { prepare: Function }): number {
  const has = db.prepare(
    `SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name='schema_version'`,
  ).get() as { n: number }
  if (!has.n) return 0
  const row = db.prepare(`SELECT COALESCE(MAX(version),0) AS v FROM schema_version`).get() as { v: number }
  return row.v
}
