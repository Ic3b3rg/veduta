import { copyFileSync, existsSync, readdirSync, unlinkSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { writeJsonAtomicDurable } from './atomic-file.ts'

/** Shared backup policy for mutable daemon configuration (issue 019). */
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

/** Writes pretty JSON through the repository's durable atomic-file primitive. */
export function writeJsonAtomic(path: string, value: unknown): void {
  writeJsonAtomicDurable(path, value)
}
