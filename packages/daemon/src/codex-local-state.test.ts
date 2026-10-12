import { afterEach, expect, it } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { cleanupCodexHomes, removeCodexHome } from './codex-local-state.ts'

const id = '5b1c9a6e-2f3a-4b8a-9c1d-0e2f3a4b5c6d'
const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'veduta-codex-cleanup-'))
  roots.push(root)
  const home = join(root, 'codex', id)
  mkdirSync(join(home, 'sessions', '2026', '10', '12'), { recursive: true })
  writeFileSync(join(home, 'auth.json'), 'opaque-existing-credential', { mode: 0o600 })
  writeFileSync(join(home, 'unknown-runtime'), 'preserve')
  const rollout = join(
    home,
    'sessions',
    '2026',
    '10',
    '12',
    `rollout-2026-10-12T09-00-00-${id}.jsonl`,
  )
  writeFileSync(rollout, 'legacy-conversation')
  return { root, home, rollout }
}
it('removes recognized history idempotently while retaining credentials and unknown runtime files', () => {
  const { root, home, rollout } = fixture()
  writeFileSync(join(home, 'history.jsonl'), 'legacy conversation')
  cleanupCodexHomes(root)
  cleanupCodexHomes(root)
  expect(existsSync(rollout)).toBe(false)
  expect(existsSync(join(home, 'history.jsonl'))).toBe(false)
  expect(readFileSync(join(home, 'auth.json'), 'utf8')).toBe('opaque-existing-credential')
  expect(readFileSync(join(home, 'unknown-runtime'), 'utf8')).toBe('preserve')
})
it('fails before deleting anything when a known database has an unknown schema', () => {
  const { root, home, rollout } = fixture()
  const db = new DatabaseSync(join(home, 'state_5.sqlite'))
  db.exec('CREATE TABLE threads (secret TEXT)')
  db.close()
  expect(() => cleanupCodexHomes(root)).toThrow(/schema/)
  expect(existsSync(rollout)).toBe(true)
})
it('rejects unknown SQLite versions and symlink traversal without touching their targets', () => {
  const { root, home, rollout } = fixture()
  writeFileSync(join(home, 'state_99.sqlite'), 'future database')
  expect(() => cleanupCodexHomes(root)).toThrow(/unsupported/)
  expect(existsSync(rollout)).toBe(true)
  rmSync(join(home, 'state_99.sqlite'))
  symlinkSync(join(home, 'auth.json'), join(home, 'history.jsonl'))
  expect(() => cleanupCodexHomes(root)).toThrow(/symbolic/)
  expect(readFileSync(join(home, 'auth.json'), 'utf8')).toBe('opaque-existing-credential')
})
it('confines full removal to a validated real connection directory', () => {
  const { root, home } = fixture()
  expect(() => removeCodexHome(root, '../escape')).toThrow()
  const other = join(root, 'codex', 'openai')
  mkdirSync(other)
  writeFileSync(join(other, 'auth.json'), 'other')
  removeCodexHome(root, id)
  removeCodexHome(root, id)
  expect(existsSync(home)).toBe(false)
  expect(readFileSync(join(other, 'auth.json'), 'utf8')).toBe('other')
})

it('cleans the pinned mixed database while retaining exact authorization and project values', () => {
  const { root, home } = fixture()
  const path = join(home, 'state_5.sqlite')
  const db = new DatabaseSync(path)
  db.exec(readFileSync(new URL('./test-fixtures/codex-state-0.160.sql', import.meta.url), 'utf8'))
  db.prepare(
    'INSERT INTO threads (id, rollout_path, created_at, updated_at, source, model_provider, cwd, title, sandbox_policy, approval_mode) VALUES (?, ?, 1, 1, ?, ?, ?, ?, ?, ?)',
  ).run(id, 'rollout', 'app-server', 'openai', '/tmp', 'legacy-conversation-marker', '{}', 'never')
  db.exec(
    "INSERT INTO remote_control_enrollments VALUES ('wss://example.test', 'account', 'client', 'server', 'environment', 'preserve-authorization', 1, 1)",
  )
  db.exec("INSERT INTO projects VALUES ('project', 'preserve-project', '{}', 0, 1, 1)")
  const retained = db.prepare('SELECT * FROM remote_control_enrollments').all()
  db.close()
  cleanupCodexHomes(root)
  cleanupCodexHomes(root)
  const clean = new DatabaseSync(path)
  expect(clean.prepare('SELECT * FROM threads').all()).toEqual([])
  expect(clean.prepare('SELECT * FROM remote_control_enrollments').all()).toEqual(retained)
  expect(clean.prepare('SELECT name FROM projects').get()).toMatchObject({
    name: 'preserve-project',
  })
  clean.close()
  expect(readFileSync(path).includes(Buffer.from('legacy-conversation-marker'))).toBe(false)
})

it('sanitizes only backup snapshots, retaining live WAL data, authorization and canonical Veduta history', async () => {
  const { createBackup, restoreBackup } = await import('./backup.ts')
  const { root, home, rollout } = fixture()
  const db = new DatabaseSync(join(home, 'state_5.sqlite'))
  db.exec(readFileSync(new URL('./test-fixtures/codex-state-0.160.sql', import.meta.url), 'utf8'))
  db.exec('PRAGMA journal_mode = WAL')
  db.prepare(
    'INSERT INTO threads (id, rollout_path, created_at, updated_at, source, model_provider, cwd, title, sandbox_policy, approval_mode) VALUES (?, ?, 1, 1, ?, ?, ?, ?, ?, ?)',
  ).run(id, 'rollout', 'app-server', 'openai', '/tmp', 'private-provider-history', '{}', 'never')
  db.exec(
    "INSERT INTO remote_control_enrollments VALUES ('wss://example.test', 'account', 'client', 'server', 'environment', 'wal-authorization', 1, 1)",
  )
  writeFileSync(join(root, 'auth.json'), '{}')
  mkdirSync(join(root, 'spaces'))
  writeFileSync(join(root, 'spaces', 'canonical-ledger.jsonl'), 'canonical-conversation-history')
  const keyMaterial = Buffer.from('codex backup disposable test encryption key')
  try {
    const file = await createBackup({ rootDir: root, outDir: join(root, 'backups'), keyMaterial })
    const restored = join(root, 'restored')
    await restoreBackup({ file, targetRootDir: restored, keyMaterial })
    const restoredHome = join(restored, 'codex', id)
    const snapshot = new DatabaseSync(join(restoredHome, 'state_5.sqlite'))
    expect(snapshot.prepare('SELECT * FROM threads').all()).toEqual([])
    expect(
      snapshot.prepare('SELECT server_name FROM remote_control_enrollments').get(),
    ).toMatchObject({ server_name: 'wal-authorization' })
    snapshot.close()
    expect(readFileSync(join(restoredHome, 'auth.json'), 'utf8')).toBe('opaque-existing-credential')
    expect(existsSync(rollout.replace(root, restored))).toBe(false)
    expect(readFileSync(join(restored, 'spaces', 'canonical-ledger.jsonl'), 'utf8')).toBe(
      'canonical-conversation-history',
    )
    expect(db.prepare('SELECT title FROM threads').get()).toMatchObject({
      title: 'private-provider-history',
    })
    expect(existsSync(rollout)).toBe(true)
  } finally {
    db.close()
  }
})

it('recognizes archived, reverted, compressed and interrupted variants without guessing at neighbors', () => {
  const { root, home } = fixture()
  const archived = join(home, 'archived_sessions')
  mkdirSync(archived)
  const base = `rollout-2026-10-12T09-00-00-${id}_${id}.jsonl`
  for (const name of [
    base,
    `${base}.zst`,
    `${base}.decompress.123.1.tmp`,
    'rollout-compress-Ab12cd.tmp',
  ])
    writeFileSync(join(archived, name), 'provider-history')
  writeFileSync(join(archived, 'unrecognized.jsonl'), 'preserve-unknown')
  cleanupCodexHomes(root)
  for (const name of [
    base,
    `${base}.zst`,
    `${base}.decompress.123.1.tmp`,
    'rollout-compress-Ab12cd.tmp',
  ])
    expect(existsSync(join(archived, name))).toBe(false)
  expect(readFileSync(join(archived, 'unrecognized.jsonl'), 'utf8')).toBe('preserve-unknown')
})

it('accepts a known older migration prefix and preserves auth permissions', () => {
  const { root, home } = fixture()
  const db = new DatabaseSync(join(home, 'state_5.sqlite'))
  db.exec(readFileSync(new URL('./test-fixtures/codex-state-legacy.sql', import.meta.url), 'utf8'))
  db.prepare(
    'INSERT INTO threads (id, rollout_path, created_at, updated_at, source, model_provider, cwd, title, sandbox_policy, approval_mode) VALUES (?, ?, 1, 1, ?, ?, ?, ?, ?, ?)',
  ).run(id, 'rollout', 'app-server', 'openai', '/tmp', 'legacy-content', '{}', 'never')
  db.close()
  cleanupCodexHomes(root)
  const clean = new DatabaseSync(join(home, 'state_5.sqlite'))
  expect(clean.prepare('SELECT * FROM threads').all()).toEqual([])
  clean.close()
  expect(readFileSync(join(home, 'auth.json'), 'utf8')).toBe('opaque-existing-credential')
  expect(statSync(join(home, 'auth.json')).mode & 0o777).toBe(0o600)
})

it('refuses newer SQLx versions before changing any recognized home', () => {
  const { root, home, rollout } = fixture()
  const other = join(root, 'codex', 'openai')
  mkdirSync(other)
  writeFileSync(join(other, 'history.jsonl'), 'other-history')
  const db = new DatabaseSync(join(home, 'state_5.sqlite'))
  db.exec(readFileSync(new URL('./test-fixtures/codex-state-legacy.sql', import.meta.url), 'utf8'))
  db.exec(
    'CREATE TABLE _sqlx_migrations (version BIGINT PRIMARY KEY, success BOOLEAN); INSERT INTO _sqlx_migrations VALUES (99999, 1)',
  )
  db.close()
  const original = readFileSync(join(home, 'state_5.sqlite'))
  expect(() => cleanupCodexHomes(root)).toThrow(/unsupported migration/)
  expect(existsSync(rollout)).toBe(true)
  expect(readFileSync(join(other, 'history.jsonl'), 'utf8')).toBe('other-history')
  expect(readFileSync(join(home, 'state_5.sqlite'))).toEqual(original)
})
