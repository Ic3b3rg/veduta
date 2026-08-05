import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { pruneBackups } from '../backup.ts'
import { compareVersions } from '../version.ts'
import { writeFileAtomicDurable } from './update-atomic.ts'
import type { UpdateHome } from './update-transaction.ts'

/**
 * Success-only, idempotent housekeeping (`issues/043-self-update.md`
 * "Retention"): pruning old releases/backups/orphaned runtimes and
 * self-updating the wrapper script, run once a transaction has actually
 * published a `success` result. Split out of `update-transaction.ts` so this
 * bookkeeping is testable independent of the journal/rollback state machine
 * that decides *when* to run it.
 */

function pruneReleases(home: UpdateHome, keep = 3): void {
  if (!existsSync(home.releasesDir)) return
  const names = readdirSync(home.releasesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('v'))
    .map((entry) => entry.name)
  const sorted = [...names].sort((a, b) => compareVersions(a.slice(1), b.slice(1)))
  const toDelete = sorted.slice(0, Math.max(0, sorted.length - keep))
  for (const name of toDelete) {
    rmSync(join(home.releasesDir, name), { recursive: true, force: true })
  }
}

function pruneOrphanedRuntimes(home: UpdateHome): void {
  if (!existsSync(home.runtimesDir)) return
  const referenced = new Set<string>()
  if (existsSync(home.releasesDir)) {
    for (const entry of readdirSync(home.releasesDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith('v')) continue
      const runtimeFile = join(home.releasesDir, entry.name, 'RUNTIME')
      if (existsSync(runtimeFile)) referenced.add(readFileSync(runtimeFile, 'utf8').trim())
    }
  }
  for (const entry of readdirSync(home.runtimesDir, { withFileTypes: true })) {
    if (entry.isDirectory() && !referenced.has(entry.name)) {
      rmSync(join(home.runtimesDir, entry.name), { recursive: true, force: true })
    }
  }
}

/** Copies `deploy/veduta-run` from the new release into `bin/veduta-run`, atomically, last (`docs/adr/0013-signed-self-update.md`) — the wrapper updates itself only after everything else about the new release has already passed. Skips silently when the source is absent (a minimal test fixture's release tree, or a fork that ships no wrapper at all). */
function selfUpdateWrapper(home: UpdateHome, newReleaseDir: string): void {
  const source = join(newReleaseDir, 'deploy', 'veduta-run')
  if (!existsSync(source)) return
  mkdirSync(home.binDir, { recursive: true })
  writeFileAtomicDurable(join(home.binDir, 'veduta-run'), readFileSync(source), 0o755)
}

export function runSuccessHousekeeping(home: UpdateHome, newReleaseDir: string): void {
  pruneReleases(home)
  // The updater's own pre-update backups directory, never the operator's
  // daily-backup directory (`docs/adr/0013-signed-self-update.md`).
  pruneBackups({ outDir: home.backupsDir, keep: 3 })
  pruneOrphanedRuntimes(home)
  selfUpdateWrapper(home, newReleaseDir)
}
