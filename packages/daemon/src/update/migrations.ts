import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { loadMemoryConfig } from '../memory-config.ts'
import { relativeTimeSeedUpgradePatch } from '../relative-time-surface.ts'
import { seedSpaces } from '../seed.ts'
import { SpacesEngine } from '../spaces-engine.ts'
import { ensureSqliteColumn } from '../sqlite-rows.ts'
import { SurfaceEngine } from '../surface-engine.ts'
import { stampDataVersion } from './data-version-marker.ts'

/**
 * One forward-only data migration (`docs/adr/0013-signed-self-update.md`):
 * sqlite/derived stores only. Append-only truth files (the Event log,
 * FACTS, USER/SOUL) are never rewritten (ADR-0003/ADR-0006), and the hybrid
 * memory index rebuilds on mismatch rather than migrating (ADR-0011) —
 * neither belongs here. `migrate` must be idempotent:
 * `runMigrations` re-stamps `data-version.json` to this step's `to` right
 * after it runs, so a crash mid-transaction resumes on the next boot by
 * re-running from the last *completed* step, which means any given step can
 * be asked to run again against a root it already finished.
 */
export interface DataMigration {
  readonly to: number
  readonly description: string
  migrate(rootDir: string): void
}

/**
 * Ordered ascending, each `to` exactly one more than the previous one —
 * `migrations.test.ts` asserts that contiguity so a gap can never be
 * introduced by mistake. Migration 1 has no schema work of its own: issue
 * #43 is what introduces `data-version.json` at all, so its entire effect
 * is the marker stamp `runMigrations` already performs after every step
 * (see `data-version.ts`'s `ensureDataVersion` for the one-time bootstrap
 * that runs this against a pre-issue-43 data root).
 */
export const MIGRATIONS: readonly DataMigration[] = [
  {
    to: 1,
    description:
      'Adopt the data-version marker. No schema change: disposable derived ' +
      'stores already rebuild on mismatch (ADR-0011) and truth files are ' +
      'never rewritten (ADR-0003/ADR-0006) — this step only establishes the ' +
      'marker that ensureDataVersion checks on every future boot.',
    migrate: () => {},
  },
  {
    to: 2,
    description:
      'Add explicit relative-time Surface validity and retrofit matching persisted seed ' +
      'Surfaces through the ordinary validated patch and Event paths.',
    migrate: migrateRelativeTimeSurfaceValidity,
  },
]

function migrateRelativeTimeSurfaceValidity(rootDir: string): void {
  const databasePath = join(rootDir, 'surfaces.sqlite')
  if (!existsSync(databasePath)) return

  const db = new DatabaseSync(databasePath)
  try {
    ensureSqliteColumn(db, 'surfaces', 'validity_json', 'text')
  } finally {
    db.close()
  }

  const now = () => new Date()
  const timeZone = loadMemoryConfig(rootDir).timezone
  const seed = seedSpaces({ relativeTimeNow: now, timeZone })
  const spacesEngine = new SpacesEngine({ rootDir, now })
  const surfaceEngine = new SurfaceEngine({
    rootDir,
    now,
    timeZone,
    seed: [],
    hasSpace: (spaceId) => spacesEngine.getSpace(spaceId) !== undefined,
    appendSpaceEvent: (spaceId, input) => spacesEngine.appendEvent(spaceId, input),
  })

  try {
    for (const seedSurface of seed.surfaces) {
      const persisted = surfaceEngine.getSurface(seedSurface.id)
      if (persisted === undefined || spacesEngine.getSpace(persisted.spaceId) === undefined)
        continue
      const upgrade = relativeTimeSeedUpgradePatch(persisted, seedSurface)
      if (upgrade === undefined) continue
      surfaceEngine.patchState(persisted.id, upgrade.operations, {
        updatedBy: 'job',
        origin: 'trusted:system',
        relativeTime: upgrade.relativeTime,
      })
    }
  } finally {
    surfaceEngine.close()
  }
}

/**
 * Runs every migration whose `to` falls in `(span.from, span.to]`, in
 * ascending order, stamping `data-version.json` to that step's `to`
 * immediately after it completes. That per-step stamp is what makes a crash
 * between two steps safe to resume: the marker is left at the last step
 * that actually finished, so re-running the same span only redoes the steps
 * that never got their stamp, not the ones already done. Returns the `to`
 * values actually run, in order.
 */
export function runMigrations(rootDir: string, span: { from: number; to: number }): number[] {
  const ran: number[] = []
  for (const migration of MIGRATIONS) {
    if (migration.to <= span.from || migration.to > span.to) continue
    migration.migrate(rootDir)
    stampDataVersion(rootDir, migration.to)
    ran.push(migration.to)
  }
  return ran
}
