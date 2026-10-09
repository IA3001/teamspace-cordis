// Independent Admin authentication must not accept a Team identity or session.
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { Context } from 'cordis'
import { AdminAuthError } from 'space-admin-auth'
import { IdentityError } from 'space-identity'
import { SqliteAdminAuthStore } from '../packages/impl/space-store-sqlite/src/admin-auth.ts'
import { SqliteUserStore } from '../packages/impl/space-store-sqlite/src/users.ts'

const root = resolve(import.meta.dirname ?? '.', '..')
const migrations = [
  '0015_admin_auth.up.sql',
  '0016_remove_team_admin.up.sql',
  '0017_team_role.up.sql',
].map((file) => readFileSync(join(root, 'packages/impl/space-store-sqlite/migrations', file), 'utf8'))
const dir = mkdtempSync(join(tmpdir(), 'admin-auth-verify-'))
const db = new DatabaseSync(join(dir, 'admin.db'), { enableForeignKeyConstraints: true })

try {
  db.exec(`CREATE TABLE users (
    id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
    display_name TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL DEFAULT 'human',
    created_at TEXT NOT NULL, is_admin INTEGER NOT NULL DEFAULT 0
  ); CREATE TABLE login_tokens (
    token TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL
  );`)
  db.exec(migrations[0])
  db.exec(migrations[1])
  db.exec(migrations[2])
  const ctx = new Context()
  const auth = new SqliteAdminAuthStore(ctx, db)
  const teamUsers = new SqliteUserStore(ctx, db)
  const teamUser = await teamUsers.register('team-member', 'team-pass')
  assert.equal('isAdmin' in teamUser, false, 'Team identity must not carry an admin flag')
  assert.equal(teamUser.teamRole, 'member', 'Team accounts default to the member role')
  const driUser = await teamUsers.register('team-dri', 'dri-pass', 'Team DRI', 'dri')
  assert.equal(driUser.teamRole, 'dri', 'Admin-created Team DRI role persists on the Team identity')
  assert.equal((await teamUsers.byId(driUser.id))?.teamRole, 'dri')
  const teamGrant = await teamUsers.login('team-member', 'team-pass')
  auth.configureBootstrap('admin', '123456')
  const grant = await auth.login('admin', '123456')
  assert.equal((await auth.verifyToken(grant.token)).username, 'admin')
  auth.configureBootstrap('admin', '123456')
  assert.equal((await auth.verifyToken(grant.token)).username, 'admin', 'same deployment credentials preserve sessions after restart')
  await assert.rejects(auth.verifyToken(teamGrant.token), (error: unknown) =>
    error instanceof AdminAuthError && error.code === 'token_unknown')
  await assert.rejects(teamUsers.verifyToken(grant.token), (error: unknown) =>
    error instanceof IdentityError && error.code === 'token_unknown')
  await assert.rejects(auth.login('admin', 'wrong'), (error: unknown) =>
    error instanceof AdminAuthError && error.code === 'bad_credentials')
  auth.configureBootstrap('admin', '654321')
  await assert.rejects(auth.verifyToken(grant.token), (error: unknown) =>
    error instanceof AdminAuthError && error.code === 'token_unknown')
  assert.equal((await auth.login('admin', '654321')).adminId, 'admin-root')
  console.log('✓ Admin credentials and sessions are independent, persistent, and revoked on credential rotation')
  execFileSync(process.execPath, ['scripts/record-action.mjs', 'verify-admin-auth', '{"ok":true}'], { stdio: 'inherit' })
} finally {
  db.close()
  rmSync(dir, { recursive: true, force: true })
}
