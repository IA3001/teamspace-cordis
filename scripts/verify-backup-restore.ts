import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const fixture = mkdtempSync(join(tmpdir(), 'teamspace-restore-drill-'))

function createDatabase(path: string, table: string, value: string) {
  const db = new DatabaseSync(path)
  try {
    db.exec(`CREATE TABLE ${table} (value TEXT NOT NULL)`)
    db.prepare(`INSERT INTO ${table}(value) VALUES (?)`).run(value)
  } finally {
    db.close()
  }
}

function assertDatabase(path: string, table: string, value: string) {
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    assert.equal(db.prepare('PRAGMA integrity_check').get()?.integrity_check, 'ok')
    assert.equal(db.prepare(`SELECT value FROM ${table}`).get()?.value, value)
  } finally {
    db.close()
  }
}

try {
  const repo = join(fixture, 'repo')
  const data = join(repo, 'data')
  const restore = join(fixture, 'restored', 'data')
  mkdirSync(join(repo, 'scripts'), { recursive: true })
  mkdirSync(join(data, 'uploads'), { recursive: true })
  mkdirSync(join(data, 'shared-workspace', 'approvals', 'fixture'), { recursive: true })
  mkdirSync(join(data, 'workdirs', 'agent-fixture'), { recursive: true })
  copyFileSync(new URL('./backup.sh', import.meta.url), join(repo, 'scripts', 'backup.sh'))

  createDatabase(join(data, 'database.db'), 'fixture_data', 'team-record')
  createDatabase(join(data, 'logs.db'), 'fixture_logs', 'audit-record')
  writeFileSync(join(data, 'uploads', 'fixture.txt'), 'uploaded-file')
  writeFileSync(join(data, 'shared-workspace', 'approvals', 'fixture', 'approved.txt'), 'approved-file')
  writeFileSync(join(data, 'workdirs', 'agent-fixture', 'work.txt'), 'private-work-file')

  const backup = spawnSync('bash', [join(repo, 'scripts', 'backup.sh'), '--include-workdirs'], {
    cwd: repo,
    encoding: 'utf8',
    env: process.env,
  })
  assert.equal(backup.status, 0, `backup command failed:\n${backup.stdout}\n${backup.stderr}`)
  const backupDirs = readdirSync(join(data, 'backups'))
  assert.equal(backupDirs.length, 1, 'expected exactly one isolated backup snapshot')
  const snapshot = join(data, 'backups', backupDirs[0]!)

  mkdirSync(restore, { recursive: true })
  for (const name of ['database.db', 'logs.db']) copyFileSync(join(snapshot, name), join(restore, name))
  for (const name of ['uploads', 'shared-workspace', 'workdirs']) {
    assert.ok(existsSync(join(snapshot, name)), `${name} missing from snapshot`)
    cpSync(join(snapshot, name), join(restore, name), { recursive: true })
  }

  assertDatabase(join(restore, 'database.db'), 'fixture_data', 'team-record')
  assertDatabase(join(restore, 'logs.db'), 'fixture_logs', 'audit-record')
  assert.equal(readFileSync(join(restore, 'uploads', 'fixture.txt'), 'utf8'), 'uploaded-file')
  assert.equal(readFileSync(join(restore, 'shared-workspace', 'approvals', 'fixture', 'approved.txt'), 'utf8'), 'approved-file')
  assert.equal(readFileSync(join(restore, 'workdirs', 'agent-fixture', 'work.txt'), 'utf8'), 'private-work-file')

  console.log('✓ Isolated backup/restore drill preserved database, logs, uploads, shared approvals, and Agent workdirs')
} finally {
  rmSync(fixture, { recursive: true, force: true })
}
