import { randomBytes } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  writeSync,
} from 'node:fs'
import { basename, dirname, join } from 'node:path'

/**
 * Durable, atomic file writes for the update system (issue #43 review
 * follow-up): one primitive every other update module writes bytes through,
 * so there is exactly one tmp-then-rename discipline in play rather than
 * several hand-rolled variants that drift apart (one fixed-name and racy
 * under concurrent callers, another randomized and cleaned up — the
 * divergence this module closes).
 */

/**
 * The one atomic "write bytes durably to `path`" primitive: a
 * randomly-suffixed temp file — never a fixed name, which is racy under
 * concurrent callers and, if a crash leaves a partial file behind, gets
 * silently reused by the next writer instead of dropped — written, fsynced,
 * `chmod`ed to the exact requested mode (independent of the process umask),
 * then renamed over the destination (the rename is what makes this atomic),
 * then the containing directory is fsynced so the rename itself survives a
 * crash. Cleans up its temp file on any failure. Exported so other update
 * modules (e.g. `update-manager.ts`) can adopt the same primitive instead of
 * hand-rolling their own tmp-then-rename sequence.
 */
export function writeFileAtomicDurable(path: string, content: Buffer, mode = 0o600): void {
  const dir = dirname(path)
  mkdirSync(dir, { recursive: true })
  const tmpPath = join(dir, `.${basename(path)}.tmp-${randomBytes(6).toString('hex')}`)
  const fd = openSync(tmpPath, 'w', mode)
  try {
    writeSync(fd, content)
    fsyncSync(fd)
  } catch (error) {
    closeSync(fd)
    rmSync(tmpPath, { force: true })
    throw error
  }
  closeSync(fd)
  chmodSync(tmpPath, mode)
  renameSync(tmpPath, path)
  const dirFd = openSync(dir, fsConstants.O_RDONLY)
  try {
    fsyncSync(dirFd)
  } finally {
    closeSync(dirFd)
  }
}

/** JSON convenience wrapper over `writeFileAtomicDurable`, mode 0600 (state files are never group/world readable). */
export function writeJsonAtomic(path: string, data: unknown): void {
  writeFileAtomicDurable(path, Buffer.from(`${JSON.stringify(data, null, 2)}\n`, 'utf8'), 0o600)
}

/** Same as `writeJsonAtomic`, but swallows the error — for state that is post-hoc reporting only (`progress.json`, `docs/adr/0013-signed-self-update.md`), where a write failure must never fail the transaction it is describing. */
export function writeJsonAtomicBestEffort(path: string, data: unknown): void {
  try {
    writeJsonAtomic(path, data)
  } catch {
    // Best-effort by design — see the doc comment above.
  }
}

/** Filesystem-safe ISO timestamp: colons become dashes, uniformly, so lexical order still matches chronological order (mirrors `backup.ts`'s `isoForFilename`). */
export function isoForFilename(date: Date): string {
  return date.toISOString().replace(/:/g, '-')
}
