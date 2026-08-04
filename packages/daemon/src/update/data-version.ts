import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { runMigrations } from './migrations.ts'

/**
 * The data schema version this build expects. Bumped whenever a new entry
 * is appended to `MIGRATIONS` (`migrations.ts`).
 */
export const CURRENT_DATA_VERSION = 1

const DataVersionMarkerSchema = z.object({
  dataVersion: z.number().int().nonnegative(),
})

function markerPath(rootDir: string): string {
  return join(rootDir, 'data-version.json')
}

/**
 * Reads `<rootDir>/data-version.json`. `undefined` means no marker exists
 * yet — either a brand-new root or a pre-issue-43 data root, both handled
 * by `ensureDataVersion`. A marker file that exists but fails to parse (a
 * write interrupted before this module's atomic tmp+rename could complete,
 * or hand-edited garbage) throws rather than being treated as absent: a
 * boot refusal is safer than silently re-running migrations against a root
 * whose real version is now unknown.
 */
export function readDataVersion(rootDir: string): number | undefined {
  const path = markerPath(rootDir)
  if (!existsSync(path)) return undefined
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    throw new Error(`${path} is corrupt: not valid JSON`)
  }
  const parsed = DataVersionMarkerSchema.safeParse(raw)
  if (!parsed.success) throw new Error(`${path} is corrupt: expected {"dataVersion": <number>}`)
  return parsed.data.dataVersion
}

/**
 * Writes the marker atomically: a tmp file plus rename, the same idiom
 * `auth-state-file.ts`'s `saveAuthState` uses for `auth.json`. A reader
 * never observes a half-written marker, and a crash between the write and
 * the rename leaves the previous marker (or none) intact rather than a
 * truncated file.
 */
export function stampDataVersion(rootDir: string, dataVersion: number): void {
  mkdirSync(rootDir, { recursive: true })
  const path = markerPath(rootDir)
  const tmp = `${path}.tmp`
  writeFileSync(tmp, `${JSON.stringify({ dataVersion }, null, 2)}\n`, 'utf8')
  renameSync(tmp, path)
}

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
