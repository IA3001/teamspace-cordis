import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Context } from 'cordis'
import { SettingsEncryptionError, SqliteSettingsStore } from '../packages/impl/space-store-sqlite/src/settings.ts'
import { loadMigrations } from '../packages/impl/space-store-sqlite/src/loader.ts'

const oldKey = process.env.SETTINGS_ENCRYPTION_KEY
const key = Buffer.alloc(32, 37).toString('base64')
const db = new DatabaseSync(':memory:')
try {
  for (const migration of loadMigrations(resolve(import.meta.dirname ?? '.', '../packages/impl/space-store-sqlite/migrations'))) {
    db.exec(migration.up)
  }
  process.env.SETTINGS_ENCRYPTION_KEY = key
  const settings = new SqliteSettingsStore(new Context(), db)
  const secret = 'test-provider-key-never-print'
  settings.set('llm.apiKey', secret)
  const encrypted = db.prepare("SELECT value FROM settings WHERE key = 'llm.apiKey'").get() as { value: string }
  assert.match(encrypted.value, /^encrypted:v1:/)
  assert.equal(encrypted.value.includes(secret), false)
  assert.equal(settings.get('llm.apiKey', ''), secret)
  assert.equal(settings.all('llm.')['llm.apiKey'], secret)

  const profileSecret = 'profile-key-never-print'
  settings.set('llm.profile.ark-coding.apiKey', profileSecret)
  const profileEncrypted = db.prepare("SELECT value FROM settings WHERE key = 'llm.profile.ark-coding.apiKey'").get() as { value: string }
  assert.match(profileEncrypted.value, /^encrypted:v1:/)
  assert.equal(profileEncrypted.value.includes(profileSecret), false, 'named profile credentials are encrypted at rest')
  assert.equal(settings.get('llm.profile.ark-coding.apiKey', ''), profileSecret)

  const legacySecret = 'legacy-provider-key-never-print'
  db.prepare("INSERT INTO settings(key, value, updated_at) VALUES ('embed.apiKey', ?, ?)")
    .run(JSON.stringify(legacySecret), new Date().toISOString())
  assert.equal(settings.get('embed.apiKey', ''), legacySecret)
  const upgraded = db.prepare("SELECT value FROM settings WHERE key = 'embed.apiKey'").get() as { value: string }
  assert.match(upgraded.value, /^encrypted:v1:/, 'legacy plaintext is upgraded on first read')
  assert.equal(upgraded.value.includes(legacySecret), false)

  settings.set('llm.baseURL', 'https://provider.invalid/v1')
  assert.equal((db.prepare("SELECT value FROM settings WHERE key = 'llm.baseURL'").get() as { value: string }).value,
    JSON.stringify('https://provider.invalid/v1'), 'non-secret settings retain ordinary JSON storage')

  process.env.SETTINGS_ENCRYPTION_KEY = Buffer.alloc(32, 99).toString('base64')
  assert.throws(() => settings.get('llm.apiKey', ''), SettingsEncryptionError, 'wrong master key fails closed')
  delete process.env.SETTINGS_ENCRYPTION_KEY
  assert.throws(() => settings.get('llm.apiKey', ''), SettingsEncryptionError, 'missing master key fails closed')
  assert.throws(() => settings.set('search.apiKey', 'new-secret'), SettingsEncryptionError,
    'cannot write credentials without an encryption key')
  console.log('✓ API credentials are encrypted at rest, legacy values migrate lazily, and missing/wrong master keys fail closed')
} finally {
  if (oldKey === undefined) delete process.env.SETTINGS_ENCRYPTION_KEY
  else process.env.SETTINGS_ENCRYPTION_KEY = oldKey
  db.close()
}
