import { ModelConnectionIdSchema } from '@veduta/protocol'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, lstatSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { CODEX_STATE_SCHEMAS } from './codex-state-schemas.ts'

// Exact supported layout and table ownership: docs/references/codex-0.160-local-state.md.
const historyTables = new Set([
  'threads',
  'logs',
  'thread_dynamic_tools',
  'thread_spawn_edges',
  'thread_sections',
  'thread_attachments',
  'thread_artifacts',
  'thread_goals',
  'thread_goal_continuation_deferrals',
  'thread_turns',
  'thread_items',
  'thread_history_projection_state',
  'thread_realtime_items',
  'stage1_outputs',
  'jobs',
  'consolidation_progress',
  'agent_jobs',
  'agent_job_items',
  'queued_items',
  'queued_thread_revisions',
  'rollout_migration_skipped_rollouts',
])
const historyFiles = new Set(['history.jsonl', 'session_index.jsonl', 'session_index.jsonl.tmp'])
const uuid = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}'
const rollout = new RegExp(
  `^rollout-(\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2})-${uuid}(?:_${uuid})?\\.jsonl(?:\\.zst)?(?:\\.decompress\\.\\d+\\.\\d+\\.tmp)?$`,
)

function isRolloutFile(name: string): boolean {
  const timestamp = rollout.exec(name)?.[1]
  if (!timestamp) return false
  const iso = `${timestamp.slice(0, 10)}T${timestamp.slice(11).replace(/-/g, ':')}.000Z`
  const parsed = Date.parse(iso)
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === iso
}

function realDirectory(path: string): boolean {
  const stat = lstatSync(path, { throwIfNoEntry: false })
  if (!stat) return false
  if (stat.isSymbolicLink()) throw new Error('Codex cleanup refuses symbolic links')
  if (!stat.isDirectory()) throw new Error('Codex cleanup expected a directory')
  return true
}

export function codexHomePath(rootDir: string, connectionId: string): string {
  ModelConnectionIdSchema.parse(connectionId)
  const parent = join(rootDir, 'codex')
  realDirectory(parent)
  const home = join(parent, connectionId)
  realDirectory(home)
  return home
}

export function removeCodexHome(rootDir: string, connectionId: string): void {
  rmSync(codexHomePath(rootDir, connectionId), { recursive: true, force: true })
}

function schemaFor(name: string) {
  return Object.entries(CODEX_STATE_SCHEMAS).find(([filename]) => filename === name)?.[1]
}

function validateDatabase(path: string, name: string, inspectionParent: string): void {
  for (const suffix of ['-wal', '-shm', '-journal']) {
    if (lstatSync(path + suffix, { throwIfNoEntry: false })?.isSymbolicLink())
      throw new Error('Codex cleanup refuses symbolic SQLite sidecars')
  }
  const schema = schemaFor(name)
  if (!schema)
    throw new Error(
      `Codex cleanup: unsupported SQLite file ${name}; preserve it and upgrade the reviewed cleanup layout`,
    )
  inspectDatabaseCopy(path, inspectionParent, (db) => {
    const rows = db
      .prepare(
        "SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE substr(name, 1, 7) != 'sqlite_' AND name != '_sqlx_migrations' ORDER BY type, name",
      )
      .all()
    const canonical = rows
      .filter((row) => typeof row.sql === 'string')
      .map((row) => [row.type, row.name, row.tbl_name, String(row.sql).trim().replace(/\s+/g, ' ')])
    const fingerprint = createHash('sha256').update(JSON.stringify(canonical)).digest('hex')
    if (!(schema.fingerprints as readonly string[]).includes(fingerprint))
      throw new Error(`Codex cleanup: unsupported schema in ${name}; no history was deleted`)
    if (db.prepare("SELECT 1 FROM sqlite_schema WHERE name = '_sqlx_migrations'").get()) {
      const migrations = db.prepare('SELECT version, success FROM _sqlx_migrations').all()
      if (
        migrations.some(
          (row) =>
            row.success !== 1 ||
            !(schema.versions as readonly number[]).includes(Number(row.version)),
        )
      )
        throw new Error(`Codex cleanup: unsupported migration in ${name}; no history was deleted`)
    }
  })
}

/** SQLite read-only opens still write WAL shared memory. Inspect only a private, WAL-preserving copy. */
function inspectDatabaseCopy(
  path: string,
  inspectionParent: string,
  inspect: (db: DatabaseSync) => void,
): void {
  const suffixes = ['', '-wal', '-journal']
  const signature = (source: string): string | undefined => {
    const stat = lstatSync(source, { bigint: true, throwIfNoEntry: false })
    if (!stat) return undefined
    if (!stat.isFile()) throw new Error('Codex cleanup refuses non-regular SQLite files')
    return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':')
  }
  const before = suffixes.map((suffix) => signature(path + suffix))
  if (before[0] === undefined) throw new Error('Codex cleanup database disappeared; retry')
  const temporary = mkdtempSync(join(inspectionParent, 'veduta-codex-inspect-'))
  const copy = join(temporary, 'state.sqlite')
  try {
    suffixes.forEach((suffix, index) => {
      if (before[index] !== undefined) copyFileSync(path + suffix, copy + suffix)
    })
    if (suffixes.some((suffix, index) => signature(path + suffix) !== before[index])) {
      throw new Error(
        'Codex cleanup database changed during inspection; retry while the connection is idle',
      )
    }
    // Reconstruct shared memory here; copying a live SHM would copy process-local reader state.
    const db = new DatabaseSync(copy)
    try {
      inspect(db)
    } finally {
      db.close()
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
}

function collectRollouts(directory: string, depth = 0): string[] {
  if (!realDirectory(directory)) return []
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isSymbolicLink()) throw new Error('Codex cleanup refuses symbolic links')
    if (entry.isDirectory() && depth < 3 && (depth === 0 ? /^\d{4}$/ : /^\d{2}$/).test(entry.name))
      return collectRollouts(path, depth + 1)
    if (
      entry.isFile() &&
      (isRolloutFile(entry.name) || /^rollout-compress-[a-zA-Z0-9]+\.tmp$/.test(entry.name))
    )
      return [path]
    return []
  })
}

interface CleanupPlan {
  files: string[]
  databases: string[]
}
function planHome(home: string, inspectionParent = tmpdir()): CleanupPlan {
  const files = [
    ...collectRollouts(join(home, 'sessions')),
    ...collectRollouts(join(home, 'archived_sessions')),
  ]
  const databases: string[] = []
  for (const entry of readdirSync(home, { withFileTypes: true })) {
    const path = join(home, entry.name)
    if (!historyFiles.has(entry.name) && !entry.name.endsWith('.sqlite')) continue
    if (entry.isSymbolicLink()) throw new Error('Codex cleanup refuses symbolic links')
    if (!entry.isFile()) throw new Error('Codex cleanup expected a regular history file')
    if (entry.name.endsWith('.sqlite')) {
      validateDatabase(path, entry.name, inspectionParent)
      databases.push(path)
    } else files.push(path)
  }
  return { files, databases }
}

function cleanDatabase(path: string): void {
  const db = new DatabaseSync(path)
  try {
    // The child is absent at boot; backup sanitation operates only on staged snapshots.
    db.exec('PRAGMA foreign_keys = OFF; PRAGMA secure_delete = ON; BEGIN IMMEDIATE')
    try {
      const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all()
      for (const { name } of tables)
        if (typeof name === 'string' && historyTables.has(name)) db.exec(`DELETE FROM "${name}"`)
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
    db.exec('VACUUM; PRAGMA wal_checkpoint(TRUNCATE)')
  } finally {
    db.close()
  }
}

export function validateCodexHome(
  rootDir: string,
  connectionId: string,
  inspectionParent = tmpdir(),
): void {
  const home = codexHomePath(rootDir, connectionId)
  if (existsSync(home)) planHome(home, inspectionParent)
}

export function cleanupCodexHome(rootDir: string, connectionId: string): void {
  const home = codexHomePath(rootDir, connectionId)
  if (!existsSync(home)) return
  applyPlan(planHome(home))
}

function applyPlan(plan: CleanupPlan): void {
  for (const database of plan.databases) cleanDatabase(database)
  for (const file of plan.files) rmSync(file, { force: true })
}

/** Preflight every recognized home before mutation; unknown schemas leave all homes untouched. */
export function cleanupCodexHomes(
  rootDir: string,
  onError?: (connectionId: string, error: unknown) => void,
  inspectionParent = tmpdir(),
): void {
  const parent = join(rootDir, 'codex')
  if (!realDirectory(parent)) return
  const plans: CleanupPlan[] = []
  for (const entry of readdirSync(parent, { withFileTypes: true })) {
    if (!ModelConnectionIdSchema.safeParse(entry.name).success) continue
    try {
      const home = codexHomePath(rootDir, entry.name)
      plans.push(planHome(home, inspectionParent))
    } catch (error) {
      if (!onError) throw error
      onError(entry.name, error)
    }
  }
  for (const plan of plans) applyPlan(plan)
}
