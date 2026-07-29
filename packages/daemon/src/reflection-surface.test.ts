import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SurfaceSchema } from '@veduta/protocol'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  reflectionSurface,
  reflectionSurfaceId,
  ReflectionSurfaceManager,
  type ReflectionSource,
} from './reflection-surface.ts'
import type { ReflectionRunReport } from './reflection.ts'
import { Store } from './store.ts'

const HEALTH = 'spc-health'
const HEALTH_SLUG = 'health'

let rootDir: string
let clock: Date
const now = () => new Date(clock.getTime())
let store: Store

beforeEach(() => {
  rootDir = mkdtempSync(join(tmpdir(), 'veduta-reflection-surface-'))
  clock = new Date('2026-07-08T04:05:00.000Z')
  store = new Store({ rootDir, now })
})

afterEach(() => {
  rmSync(rootDir, { recursive: true, force: true })
})

function sampleReport(overrides: Partial<ReflectionRunReport> = {}): ReflectionRunReport {
  return {
    spaceId: HEALTH,
    windowFrom: '2026-07-07T04:00:00.000Z',
    windowTo: '2026-07-08T04:00:00.000Z',
    eventCount: 3,
    summaries: ['Logged two meals and a workout.'],
    insights: ['Energy dips mid-afternoon most days.'],
    consolidated: 2,
    reactivated: 0,
    droppedWithoutEvidence: 0,
    demoted: 1,
    activeSize: 1800,
    underBudget: true,
    ...overrides,
  }
}

describe('reflectionSurface', () => {
  it('validates against SurfaceSchema and shows the empty state before any run', () => {
    const surface = reflectionSurface(
      { id: HEALTH, slug: HEALTH_SLUG },
      undefined,
      4000,
      clock.toISOString(),
    )
    expect(() => SurfaceSchema.parse(surface)).not.toThrow()
    expect(surface.id).toBe(reflectionSurfaceId(HEALTH_SLUG))
    expect(JSON.stringify(surface)).toContain('No Reflection has run yet.')
  })

  it('validates and lists the summaries, insights and counts after a run', () => {
    const report = sampleReport()
    const surface = reflectionSurface(
      { id: HEALTH, slug: HEALTH_SLUG },
      report,
      4000,
      clock.toISOString(),
    )
    expect(() => SurfaceSchema.parse(surface)).not.toThrow()
    const text = JSON.stringify(surface)
    expect(text).toContain('Logged two meals and a workout.')
    expect(text).toContain('Energy dips mid-afternoon most days.')
    expect(text).toContain('"label":"Consolidated","value":"2"')
    expect(text).toContain('"label":"Demoted","value":"1"')
    expect(text).toContain('"label":"Active vs budget","value":"1800/4000"')
    expect(text).toContain(report.windowFrom)
    expect(text).toContain(report.windowTo)
  })

  it('shows a distinct "nothing to distill" notice for a run over an empty window, not the pre-first-run empty state', () => {
    const report = sampleReport({ summaries: [], insights: [], consolidated: 0, demoted: 0 })
    const surface = reflectionSurface(
      { id: HEALTH, slug: HEALTH_SLUG },
      report,
      4000,
      clock.toISOString(),
    )
    const text = JSON.stringify(surface)
    expect(text).toContain('Nothing to distill from last night.')
    expect(text).not.toContain('No Reflection has run yet.')
  })
})

describe('ReflectionSurfaceManager', () => {
  it('start() pre-creates the empty-state Surface for every active, non-System Space', () => {
    const source: ReflectionSource = { lastReport: () => undefined }
    const manager = new ReflectionSurfaceManager({ store, reflection: source, low: 4000, now })
    manager.start()

    const surface = store.getSurface(reflectionSurfaceId(HEALTH_SLUG))
    expect(surface).toBeDefined()
    expect(JSON.stringify(surface)).toContain('No Reflection has run yet.')
  })

  it("refresh(spaceId) rebuilds the Surface from the Reflection's latest report for that Space", () => {
    // A mutable holder rather than a reassigned `let`: the Surface must be
    // built at `start()` while no report exists yet, and rebuilt by
    // `refresh` once one does, so the source has to be able to answer
    // differently on the two calls.
    const latest: { report?: ReflectionRunReport } = {}
    const source: ReflectionSource = {
      lastReport: (spaceId) => (spaceId === HEALTH ? latest.report : undefined),
    }
    const manager = new ReflectionSurfaceManager({ store, reflection: source, low: 4000, now })
    manager.start()

    latest.report = sampleReport()
    manager.refresh(HEALTH)

    const surface = store.getSurface(reflectionSurfaceId(HEALTH_SLUG))
    const text = JSON.stringify(surface)
    expect(text).toContain('Logged two meals and a workout.')
    expect(text).toContain('Energy dips mid-afternoon most days.')
    expect(text).toContain('"label":"Consolidated","value":"2"')
  })
})
