// 数据库运行器 CLI —— migrate / seed / reset（DDL 唯一出处是
// packages/impl/space-store-sqlite/migrations/，本文件只搬运执行，不写一行表结构）。
//
// 用法：
//   npm run migrate          增量升到最新（幂等：已应用的跳过）
//   npm run migrate:down     全部回滚（回到 0）
//   npm run seed             幂等重放种子数据
//   npm run reset -- --yes   显式确认后重置：旧库改名留档 → migrate → seed
//
// 承旧 store/doc.go 的两条硬规矩：
//   · reset 必须带显式确认标志，且先把旧库改名留档（不直接删）
//   · 每次动作都在 action_log 留痕（断言 ⑨；铁律 2：跑过就要查得到）
//
// 注意：schema_version 是**记账设施**（只被本运行器与插件的校验读写），
// 不进迁移链 —— 进链会有"第一条迁移之前谁建表"的自举矛盾。
import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync, renameSync, readdirSync, readFileSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { currentVersion, loadMigrations } from '../packages/impl/space-store-sqlite/src/loader.ts'

const DB_PATH = resolve(process.cwd(), process.env.DB_PATH ?? 'data/database.db')
const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../packages/impl/space-store-sqlite/migrations')
const SEED_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../packages/impl/space-store-sqlite/seed')

function openDb(): DatabaseSync {
  mkdirSync(dirname(DB_PATH), { recursive: true })
  const db = new DatabaseSync(DB_PATH, { enableForeignKeyConstraints: true })
  db.exec(`PRAGMA journal_mode = WAL`)
  db.exec(`PRAGMA busy_timeout = 5000`)
  db.exec(`PRAGMA synchronous = NORMAL`)
  db.exec(`CREATE TABLE IF NOT EXISTS schema_version (
    version    INTEGER PRIMARY KEY,
    name       TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`)
  return db
}

/** 断言 ⑨：动作留痕。留痕表不在（如 down-all 刚删掉它）则明说并跳过 —— 不静默。 */
function record(db: DatabaseSync, action: string, detail: Record<string, unknown>, ok = true): void {
  const has = db.prepare(
    `SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name='action_log'`,
  ).get() as { n: number }
  if (!has.n) {
    console.log('· 留痕表 action_log 不在（迁移链未含 0003），本次动作不留痕 —— 明说，不静默')
    return
  }
  db.prepare(`INSERT INTO action_log(action, detail, ok, created_at) VALUES (?, ?, ?, ?)`)
    .run(action, JSON.stringify(detail), ok ? 1 : 0, new Date().toISOString())
}

function cmdUp(): number {
  const db = openDb()
  const cur = currentVersion(db)
  const ms = loadMigrations(MIGRATIONS_DIR)
  const applied: number[] = []
  for (const m of ms) {
    if (m.version <= cur) continue
    db.exec('BEGIN')
    try {
      db.exec(m.up)
      db.prepare(`INSERT INTO schema_version(version, name, applied_at) VALUES (?, ?, ?)`)
        .run(m.version, m.name, new Date().toISOString())
      db.exec('COMMIT')
      applied.push(m.version)
      console.log(`  ↑ 应用 ${m.version}_${m.name}`)
    } catch (e) {
      db.exec('ROLLBACK')
      console.error(`✗ 应用迁移 ${m.version} (${m.name}) 失败: ${(e as Error).message}`)
      record(db, 'migrate', { direction: 'up', applied, error: String((e as Error).message) }, false)
      db.close()
      return 1
    }
  }
  console.log(applied.length ? `✓ migrate up：新应用 ${applied.length} 个迁移（v${cur} → v${ms[ms.length - 1]!.version}）` : `✓ migrate up：已是最新（v${cur}），无需变更`)
  record(db, 'migrate', { direction: 'up', applied })
  db.close()
  return 0
}

function cmdDown(): number {
  const db = openDb()
  const cur = currentVersion(db)
  const ms = loadMigrations(MIGRATIONS_DIR).filter((m) => m.version <= cur).reverse()
  const rolled: number[] = []
  for (const m of ms) {
    db.exec('BEGIN')
    try {
      db.exec(m.down)
      db.prepare(`DELETE FROM schema_version WHERE version = ?`).run(m.version)
      db.exec('COMMIT')
      rolled.push(m.version)
      console.log(`  ↓ 回滚 ${m.version}_${m.name}`)
    } catch (e) {
      db.exec('ROLLBACK')
      console.error(`✗ 回滚迁移 ${m.version} (${m.name}) 失败: ${(e as Error).message}`)
      record(db, 'migrate:down', { rolled, error: String((e as Error).message) }, false)
      db.close()
      return 1
    }
  }
  console.log(rolled.length ? `✓ migrate down：回滚 ${rolled.length} 个迁移（v${cur} → v0）` : `✓ migrate down：本来就在 v0`)
  record(db, 'migrate:down', { rolled })
  db.close()
  return 0
}

const COUNT_TABLES = ['sessions', 'session_members', 'events', 'action_log']

function rowCount(db: DatabaseSync): number {
  let n = 0
  for (const t of COUNT_TABLES) {
    const has = db.prepare(`SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name=?`).get(t) as { n: number }
    if (!has.n) continue
    n += (db.prepare(`SELECT count(*) AS n FROM "${t}"`).get() as { n: number }).n
  }
  return n
}

function cmdSeed(): number {
  const db = openDb()
  const files = readdirSync(SEED_DIR).filter((f) => f.endsWith('.sql')).sort()
  const applied: string[] = []
  for (const f of files) {
    const before = rowCount(db)
    db.exec(readFileSync(join(SEED_DIR, f), 'utf8'))
    const delta = rowCount(db) - before
    if (delta > 0) applied.push(f)
    console.log(`  · 种子 ${f}：新增 ${delta} 行`)
  }
  console.log(applied.length ? `✓ seed：实际新增 ${applied.length} 个文件（再跑一遍应为 0 —— 幂等）` : '✓ seed：0 行新增（幂等生效）')
  record(db, 'seed', { applied, files })
  db.close()
  return 0
}

function cmdReset(yes: boolean): number {
  if (!yes) {
    console.error('✗ reset 是危险动作：会把现有库改名留档后重建。确认请加 --yes（npm run reset -- --yes）')
    return 1
  }
  const stamp = new Date().toISOString().replaceAll(/[:.]/g, '-')
  for (const suffix of ['', '-wal', '-shm']) {
    const src = DB_PATH + suffix
    if (existsSync(src)) {
      const dst = `${DB_PATH}.bak-${stamp}${suffix}`
      renameSync(src, dst)
      console.log(`  · 旧库留档：${src} → ${dst}`)
    }
  }
  console.log(`✓ reset：旧库已留档，重建开始`)
  const rc = cmdUp()
  if (rc !== 0) return rc
  return cmdSeed()
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2)
  switch (cmd) {
    case 'up': process.exit(cmdUp())
    case 'down': process.exit(cmdDown())
    case 'seed': process.exit(cmdSeed())
    case 'reset': process.exit(cmdReset(rest.includes('--yes')))
    default:
      console.error('用法: tsx scripts/store.ts <up|down|seed|reset> [--yes]')
      process.exit(2)
  }
}

await main()
