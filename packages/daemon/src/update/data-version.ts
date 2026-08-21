import { existsSync, readdirSync } from 'node:fs'
import { readDataVersion, stampDataVersion } from './data-version-marker.ts'
import { runMigrations } from './migrations.ts'

export { readDataVersion, stampDataVersion } from './data-version-marker.ts'

/**
 * The data schema version this build expects. Bumped whenever a new entry
 * is appended to `MIGRATIONS` (`migrations.ts`).
 */
export const CURRENT_DATA_VERSION = 2

export interface EnsureDataVersionResult {
  action: 'stamped-fresh' | 'bootstrapped' | 'ok'
  dataVersion: number
}

/**
 * The boot-time dataVersion gate (issue #43,
 * `docs/adr/0013-signed-self-update.md`: "no lazy runtime migrations — the
 * new daemon refuses to boot on an unexpected dataVersion"). Called from
 * `buildServer` before `Store` opens anything. Four cases:
 * - root missing, or present but empty: a fresh install — stamp
 *   `CURRENT_DATA_VERSION` and boot (`stamped-fresh`).
 * - marker present and equal to `CURRENT_DATA_VERSION`: boot (`ok`).
 * - marker present and different (either direction — an old build against
 *   newer data, or a downgrade): refuse. The message names both numbers and
 *   the two actual fixes an operator has (run the update, or restore the
 *   backup that matches this build) instead of attempting a schema change
 *   here.
 * - root non-empty but no marker at all: a data root that predates issue
 *   #43. Baseline it at 0 and run every migration up to
 *   `CURRENT_DATA_VERSION` once (`bootstrapped`) — the same migrations
 *   module the updater itself runs on every future update, so this one-time
 *   arrival path and every subsequent update share identical migration
 *   code, and a pre-043 backup restored later goes through this same path.
 */
export function ensureDataVersion(rootDir: string): EnsureDataVersionResult {
  const isFreshRoot = !existsSync(rootDir) || readdirSync(rootDir).length === 0
  if (isFreshRoot) {
    stampDataVersion(rootDir, CURRENT_DATA_VERSION)
    return { action: 'stamped-fresh', dataVersion: CURRENT_DATA_VERSION }
  }

  const marker = readDataVersion(rootDir)
  if (marker === undefined) {
    runMigrations(rootDir, { from: 0, to: CURRENT_DATA_VERSION })
    return { action: 'bootstrapped', dataVersion: CURRENT_DATA_VERSION }
  }

  if (marker === CURRENT_DATA_VERSION) return { action: 'ok', dataVersion: CURRENT_DATA_VERSION }

  throw new Error(
    `data root at ${rootDir} has dataVersion ${marker}, but this build expects ` +
      `${CURRENT_DATA_VERSION} — run the update, or restore the backup matching ` +
      `dataVersion ${CURRENT_DATA_VERSION}, before starting this daemon`,
  )
}
