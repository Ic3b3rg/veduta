import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { MemoryBudget } from './memory-config.ts'
import { MemoryHealthStore } from './memory-health.ts'

const budget: MemoryBudget = { low: 30, high: 40, hard: 60 }
const spaceId = 'spc-health'

describe('MemoryHealthStore', () => {
  let rootDir: string
  let clock: Date
  const now = () => new Date(clock.getTime())

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'veduta-memory-health-'))
    clock = new Date('2026-09-02T08:00:00.000Z')
  })

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true })
  })

  it('classifies exact boundaries and keeps Reflection pending until the projection returns to low', () => {
    const health = new MemoryHealthStore({ rootDir, budget, now })

    health.reconcile([{ spaceId, activeSize: 40 }])
    expect(health.snapshot().spaces[spaceId]).toMatchObject({
      activeSize: 40,
      watermark: 'between-low-high',
      reflectionPending: false,
      overHardRecovery: false,
    })

    health.update(spaceId, 41)
    expect(health.snapshot().spaces[spaceId]).toMatchObject({
      watermark: 'over-high',
      reflectionPending: true,
      overHardRecovery: false,
    })

    health.update(spaceId, 40)
    expect(health.snapshot().spaces[spaceId]).toMatchObject({
      watermark: 'between-low-high',
      reflectionPending: true,
    })

    health.update(spaceId, 61)
    expect(health.snapshot().spaces[spaceId]).toMatchObject({
      watermark: 'over-hard',
      reflectionPending: true,
      overHardRecovery: true,
    })

    health.update(spaceId, 30)
    expect(health.snapshot().spaces[spaceId]).toMatchObject({
      watermark: 'within-low',
      reflectionPending: false,
      overHardRecovery: false,
    })
  })

  it('persists pending hysteresis across restart and reconciles removed Spaces', () => {
    const first = new MemoryHealthStore({ rootDir, budget, now })
    first.reconcile([
      { spaceId, activeSize: 41 },
      { spaceId: 'spc-removed', activeSize: 35 },
    ])

    clock = new Date('2026-09-02T09:00:00.000Z')
    const restarted = new MemoryHealthStore({ rootDir, budget, now })
    restarted.reconcile([{ spaceId, activeSize: 35 }])

    expect(restarted.snapshot()).toEqual({
      version: 1,
      budget,
      spaces: {
        [spaceId]: {
          activeSize: 35,
          watermark: 'between-low-high',
          reflectionPending: true,
          overHardRecovery: false,
          updatedAt: '2026-09-02T09:00:00.000Z',
        },
      },
    })
    expect(JSON.parse(readFileSync(join(rootDir, 'memory-health.json'), 'utf8'))).toEqual(
      restarted.snapshot(),
    )
  })
})
