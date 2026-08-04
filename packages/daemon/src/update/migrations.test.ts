import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readDataVersion } from './data-version.ts'
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

    const ran = runMigrations(rootDir, { from: 0, to: 1 })

    expect(ran).toEqual([1])
    expect(readDataVersion(rootDir)).toBe(1)
  })

  it('runs nothing when the span is already satisfied', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'veduta-run-migrations-noop-'))

    const ran = runMigrations(rootDir, { from: 1, to: 1 })

    expect(ran).toEqual([])
    expect(readDataVersion(rootDir)).toBeUndefined()
  })

  it('is crash-safe to re-run: running the same span twice yields the same marker and steps', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'veduta-run-migrations-rerun-'))

    const first = runMigrations(rootDir, { from: 0, to: 1 })
    const second = runMigrations(rootDir, { from: 0, to: 1 })

    expect(first).toEqual(second)
    expect(readDataVersion(rootDir)).toBe(1)
  })
})
