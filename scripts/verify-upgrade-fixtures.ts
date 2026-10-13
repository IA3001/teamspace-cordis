import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { loadMigrations } from '../packages/impl/space-store-sqlite/src/loader.ts'
import { resolve } from 'node:path'
const db = new DatabaseSync(':memory:')
try {
  const migrations = loadMigrations(resolve('packages/impl/space-store-sqlite/migrations'))
  const oldVersion = 31
  for (const migration of migrations.filter((m) => m.version <= oldVersion)) db.exec(migration.up)
  db.prepare('INSERT INTO kb_documents(id,title,created_at) VALUES(?,?,?)').run('legacy-doc', 'Legacy', '2026-01-01')
  db.prepare('INSERT INTO kb_chunks(id,doc_id,idx,text,embedding,created_at) VALUES(?,?,?,?,?,?)').run('legacy-chunk','legacy-doc',0,'retained legacy text','[1,2]','2026-01-01')
  for (const migration of migrations.filter((m) => m.version > oldVersion)) {
    db.exec('BEGIN')
    try { db.exec(migration.up); db.exec('COMMIT') } catch (error) { db.exec('ROLLBACK'); throw error }
  }
  assert.equal(db.prepare('SELECT content FROM kb_documents WHERE id=?').get('legacy-doc')?.content, 'retained legacy text')
  assert.equal(db.prepare('SELECT embedding_model FROM kb_chunks WHERE id=?').get('legacy-chunk')?.embedding_model, '', 'legacy vectors must not acquire an invented model identity')
  assert.equal(db.prepare('PRAGMA integrity_check').get()?.integrity_check, 'ok')
  db.exec('BEGIN'); db.prepare('UPDATE kb_documents SET content=? WHERE id=?').run('partial write','legacy-doc'); db.exec('ROLLBACK')
  assert.equal(db.prepare('SELECT content FROM kb_documents WHERE id=?').get('legacy-doc')?.content, 'retained legacy text')
  console.log(`✓ Actual v${oldVersion} fixture upgrades to v${migrations.at(-1)!.version}; content retained, vector identity unknown, interrupted transaction rolled back`)
} finally { db.close() }
