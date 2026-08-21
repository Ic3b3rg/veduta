import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { loadMemoryConfig } from '../memory-config.ts'
import {
  relativeTimeSeedUpgradePatch,
  type RelativeTimeSeedUpgradeDescriptor,
} from '../relative-time-surface.ts'
import { SpacesEngine } from '../spaces-engine.ts'
import { ensureSqliteColumn } from '../sqlite-rows.ts'
import { SurfaceEngine } from '../surface-engine.ts'

/**
 * Frozen compatibility input for data migration 2. Historical migrations
 * must not derive their behavior from the live development seed: changing a
 * seed belongs in a later migration, while a direct v1-to-current update must
 * always replay this exact issue-#134 contract and these exact defaults.
 */
const V2_RELATIVE_TIME_SEED_UPGRADES: readonly RelativeTimeSeedUpgradeDescriptor[] = [
  {
    surfaceId: 'srf-meals',
    spaceId: 'spc-health',
    relativeTime: {
      window: 'day',
      source: { stateKey: 'mealRecords', occurredAtKey: 'occurredAt' },
      projectionStateKeys: ['meals', 'lastMeal', 'mealCount'],
    },
    projectionDefaults: {
      meals: [],
      lastMeal: 'Nothing logged today',
      mealCount: 0,
    },
  },
]

export function migrateV2RelativeTimeSurfaceValidity(rootDir: string): void {
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
    for (const descriptor of V2_RELATIVE_TIME_SEED_UPGRADES) {
      const persisted = surfaceEngine.getSurface(descriptor.surfaceId)
      if (persisted === undefined || spacesEngine.getSpace(persisted.spaceId) === undefined)
        continue
      const upgrade = relativeTimeSeedUpgradePatch(persisted, descriptor, {
        timeZone,
        now: now(),
      })
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
