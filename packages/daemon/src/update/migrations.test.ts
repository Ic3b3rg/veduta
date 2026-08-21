import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { surfaceRelativeTimeStatus } from '@veduta/protocol'
import { describe, expect, it } from 'vitest'
import { Store } from '../store.ts'
import { readDataVersion, stampDataVersion } from './data-version.ts'
import { MIGRATIONS, runMigrations } from './migrations.ts'

describe('MIGRATIONS', () => {
  it('is ordered ascending with no gaps, starting at 1', () => {
    expect(MIGRATIONS.length).toBeGreaterThan(0)
    let previous = 0
    for (const migration of MIGRATIONS) {
      expect(migration.to).toBe(previous + 1)
      previous = migration.to
    }
  })

  it('every step is idempotent: running it twice against the same root has the same effect', async () => {
    for (const migration of MIGRATIONS) {
      const rootDir = await mkdtemp(join(tmpdir(), 'veduta-migration-idempotent-'))
      expect(() => migration.migrate(rootDir)).not.toThrow()
      expect(() => migration.migrate(rootDir)).not.toThrow()
    }
  })
})

describe('runMigrations', () => {
  it('runs every step in (from, to] and stamps the marker to the final to', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'veduta-run-migrations-'))

    const ran = runMigrations(rootDir, { from: 0, to: 2 })

    expect(ran).toEqual([1, 2])
    expect(readDataVersion(rootDir)).toBe(2)
  })

  it('runs nothing when the span is already satisfied', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'veduta-run-migrations-noop-'))

    const ran = runMigrations(rootDir, { from: 2, to: 2 })

    expect(ran).toEqual([])
    expect(readDataVersion(rootDir)).toBeUndefined()
  })

  it('is crash-safe to re-run: running the same span twice yields the same marker and steps', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'veduta-run-migrations-rerun-'))

    const first = runMigrations(rootDir, { from: 0, to: 2 })
    const second = runMigrations(rootDir, { from: 0, to: 2 })

    expect(first).toEqual(second)
    expect(readDataVersion(rootDir)).toBe(2)
  })

  it('retrofits a persisted pre-#134 seed Surface without guessing legacy occurrence dates', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'veduta-relative-time-migration-'))
    await writeFile(join(rootDir, 'memory.json'), JSON.stringify({ timezone: 'Europe/Rome' }))
    const legacyStore = new Store({
      rootDir,
      now: () => new Date('2026-08-20T12:00:00.000Z'),
      timeZone: 'Europe/Rome',
    })
    legacyStore.setPinned('srf-meals', true, {
      origin: 'trusted:user',
      updatedBy: 'user',
    })
    const cursorBefore = legacyStore.latestSurfaceCursor()
    legacyStore.close()

    const db = new DatabaseSync(join(rootDir, 'surfaces.sqlite'))
    db.prepare(
      `update surfaces
       set state_json = ?, validity_json = null, updated_at = ?, updated_by = 'seed'
       where id = 'srf-meals'`,
    ).run(
      JSON.stringify({
        meals: [
          { time: '20:00', meal: 'pasta' },
          { occurredAt: null, time: '12:00', meal: 'legacy unknown' },
        ],
        lastMeal: 'pasta',
        mealCount: 2,
      }),
      '2026-08-20T12:00:00.000Z',
    )
    db.exec('alter table surfaces drop column validity_json')
    db.close()
    stampDataVersion(rootDir, 1)

    expect(runMigrations(rootDir, { from: 1, to: 2 })).toEqual([2])
    expect(readDataVersion(rootDir)).toBe(2)

    const migratedStore = new Store({ rootDir, timeZone: 'Europe/Rome' })
    const meals = migratedStore.getSurface('srf-meals')!
    expect(meals.pinned).toBe(true)
    expect(meals.validity).toMatchObject({
      kind: 'relative-time',
      timeZone: 'Europe/Rome',
      window: 'day',
      source: { stateKey: 'mealRecords', occurredAtKey: 'occurredAt' },
      projectionStateKeys: ['meals', 'lastMeal', 'mealCount'],
    })
    expect(meals.state).toEqual({
      mealRecords: [
        { time: '20:00', meal: 'pasta' },
        { occurredAt: null, time: '12:00', meal: 'legacy unknown' },
      ],
      meals: [],
      lastMeal: 'Nothing logged today',
      mealCount: 0,
    })
    expect(surfaceRelativeTimeStatus(meals)).toMatchObject({
      status: 'current',
      undatedRecords: 2,
    })

    const migrationEvents = migratedStore.surfaceEventsAfter(cursorBefore)
    expect(migrationEvents).toEqual([
      expect.objectContaining({
        kind: 'patch',
        event: expect.objectContaining({ validity: meals.validity }),
      }),
    ])
    expect(migratedStore.eventLog('spc-health').at(-1)).toMatchObject({
      type: 'surface.patch_state',
      origin: 'trusted:system',
    })

    const migration = MIGRATIONS.find(({ to }) => to === 2)!
    migration.migrate(rootDir)
    expect(migratedStore.latestSurfaceCursor()).toBe(migrationEvents[0]!.event.cursor)
    migratedStore.close()
  })

  it('refuses a source-present v1 Surface instead of erasing populated legacy projections', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'veduta-relative-time-migration-conflict-'))
    await writeFile(join(rootDir, 'memory.json'), JSON.stringify({ timezone: 'Europe/Rome' }))
    const legacyStore = new Store({
      rootDir,
      now: () => new Date('2026-08-20T12:00:00.000Z'),
      timeZone: 'Europe/Rome',
    })
    const cursorBefore = legacyStore.latestSurfaceCursor()
    legacyStore.close()

    const conflictingState = {
      mealRecords: [],
      meals: [{ time: '20:00', meal: 'pasta' }],
      lastMeal: 'pasta',
      mealCount: 1,
    }
    const db = new DatabaseSync(join(rootDir, 'surfaces.sqlite'))
    db.prepare(
      `update surfaces
       set state_json = ?, validity_json = null, updated_at = ?, updated_by = 'seed'
       where id = 'srf-meals'`,
    ).run(JSON.stringify(conflictingState), '2026-08-20T12:00:00.000Z')
    db.exec('alter table surfaces drop column validity_json')
    db.close()
    stampDataVersion(rootDir, 1)

    expect(runMigrations(rootDir, { from: 1, to: 2 })).toEqual([2])

    const migratedStore = new Store({ rootDir, timeZone: 'Europe/Rome' })
    const meals = migratedStore.getSurface('srf-meals')!
    expect(meals.state).toEqual(conflictingState)
    expect(meals.validity).toBeUndefined()
    expect(migratedStore.latestSurfaceCursor()).toBe(cursorBefore)
    expect(
      migratedStore.eventLog('spc-health').filter((event) => event.type === 'surface.patch_state'),
    ).toEqual([])
    migratedStore.close()
  })
})
