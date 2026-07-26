import { randomBytes } from 'node:crypto'
import {
  closeSync,
  constants as fsConstants,
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import { basename, dirname, join } from 'node:path'

/**
 * Shared config-file discipline (issue #19, Hermes onboarding/migration
 * discipline — `docs/references/04-onboarding-migration.md`): every daemon
 * config mutation gets an atomic, restorable backup taken first, and every
 * write to the live file is crash-safe. `backupFile` implements the
 * "restorable, auto-pruned at 5" half; `writeJsonAtomic` implements the
 * "atomic" half, replicating the strong write-tmp-then-rename pattern from
 * `secrets-vault.ts` so every JSON config writer in the daemon (onboarding,
 * routing, ingestion) shares one crash-safety guarantee instead of
 * reinventing it per file.
 */
const MAX_BACKUPS = 5

/**
 * Copies `path` to `<path>.bak-<ISO timestamp>` (`:`/`.` replaced with `-`
 * so the name is filesystem-safe on every OS) and prunes older siblings
 * beyond the newest 5. Returns the backup path, or `undefined` when `path`
 * does not exist yet (nothing to back up on first write).
 */
export function backupFile(path: string, now: () => Date = () => new Date()): string | undefined {
  if (!existsSync(path)) return undefined
  const timestamp = now().toISOString().replace(/[:.]/g, '-')
  const backupPath = `${path}.bak-${timestamp}`
  copyFileSync(path, backupPath)
  pruneBackups(path)
  return backupPath
}

function pruneBackups(path: string): void {
  const dir = dirname(path)
  const prefix = `${basename(path)}.bak-`
  const backups = readdirSync(dir)
    .filter((entry) => entry.startsWith(prefix))
    // The timestamp suffix is lexicographically ordered ISO-8601, so a
    // plain string sort is also a chronological sort, newest last.
    .sort()
  const stale = backups.slice(0, Math.max(0, backups.length - MAX_BACKUPS))
  for (const entry of stale) {
    unlinkSync(join(dir, entry))
  }
}

/**
 * Serializes `value` as pretty JSON and writes it to `path` with a
 * write-tmp-then-rename discipline: the tmp file is opened with `wx`
 * (`O_CREAT | O_EXCL`) so a concurrent write to the very same tmp name is
 * still a clear, actionable error rather than a silent clobber. Unlike
 * `secrets-vault.ts`'s `writeFileAtomic` (a real cross-process lock guarding
 * the one vault file every daemon process shares), the tmp name here is
 * unique per call (`<path>.<pid>.<random>.tmp`): every writer of a given
 * config file is in-process (the daemon never forks a second writer of its
 * own `onboarding.json`/`routing.json`/`ingestion.json`), so a fixed tmp name
 * bought no real locking — it only meant a leftover tmp file from a crashed
 * write permanently blocked every future save of that file (an availability
 * bug: AC2's "recover from a crash mid-write" never got to actually retry).
 * A stale tmp from a real crash is simply inert now; nothing here needs to
 * clean it up. `fsync` covers both the file and its parent directory so the
 * rename is durable across a crash, not just visible. The parent directory
 * is created recursively first; the file is written `0o600` (config files
 * can carry secret references). The tmp file is always unlinked on any
 * failure path so a failed write never leaves its own tmp behind either.
 */
export function writeJsonAtomic(path: string, value: unknown): void {
  const content = `${JSON.stringify(value, null, 2)}\n`
  const dir = dirname(path)
  mkdirSync(dir, { recursive: true })
  const tmpPath = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  let fd: number
  try {
    fd = openSync(tmpPath, 'wx', 0o600)
  } catch (error) {
    if (isErrnoException(error) && error.code === 'EEXIST') {
      // Vanishingly unlikely (pid + 48 random bits) — never a stale file
      // from a previous crash, since this name is fresh every call.
      throw new Error(`${tmpPath} already exists — retry the write`)
    }
    throw error
  }
  try {
    writeSync(fd, content, 0, 'utf8')
    fsyncSync(fd)
  } catch (error) {
    closeSync(fd)
    unlinkSync(tmpPath)
    throw error
  }
  closeSync(fd)
  try {
    renameSync(tmpPath, path)
  } catch (error) {
    unlinkSync(tmpPath)
    throw error
  }
  const dirFd = openSync(dir, fsConstants.O_RDONLY)
  try {
    fsyncSync(dirFd)
  } finally {
    closeSync(dirFd)
  }
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}
