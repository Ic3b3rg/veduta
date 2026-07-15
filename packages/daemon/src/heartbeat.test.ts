import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SurfaceSchema, type Surface } from '@veduta/protocol'
import { fromPartial } from '@total-typescript/shoehorn'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ModelRef } from './agent-runner.ts'
import { HeartbeatConfigSchema, type HeartbeatConfig } from './heartbeat-config.ts'
import { Heartbeat, type HeartbeatOptions } from './heartbeat.ts'
import { ModelRouter, type RoutingConfig } from './model-routing.ts'
import { Scheduler, type Automation } from './scheduler.ts'
import { Store } from './store.ts'
import { ensureSystemSpace, SYSTEM_SPACE_ID } from './system-space.ts'

const HEALTH = 'spc-health'

const routingConfig: RoutingConfig = {
  tiers: {
    triage: [{ provider: 'mock', modelId: 'triage-mock' }],
    reasoning: [{ provider: 'mock', modelId: 'reasoning-mock' }],
  },
  // Keyless "mock" provider (no entry here): the router resolves it without a secret.
  providerKeys: {},
  dailyCapUsd: { triage: 5, reasoning: 20 },
}

function heartbeatConfig(overrides: Partial<HeartbeatConfig> = {}): HeartbeatConfig {
  return HeartbeatConfigSchema.parse({
    enabled: true,
    times: ['06:00', '18:00'],
    staleAfterHours: 24,
    ...overrides,
  })
}

let rootDir: string
let clock: Date
const now = () => new Date(clock.getTime())

let store: Store
let scheduler: Scheduler
let router: ModelRouter
let escalations: { spaceId: string; text: string }[]

/**
 * `Store.createSurface` always stamps `freshness.updatedAt` to the current
 * clock at creation time (see `SurfaceEngine.surfaceForWrite`) — there is
 * no way to backdate it directly. Tests that need a stale Surface create
 * it at the current fake-clock instant, then advance `clock` forward, the
 * same way a real Surface goes stale: time moves on, nothing touches it.
 */
function planSurface(overrides: { id?: string; title?: string } = {}): Surface {
  const title = overrides.title ?? "Today's plan"
  return SurfaceSchema.parse({
    id: overrides.id ?? 'srf-todays-plan',
    spaceId: HEALTH,
    title,
    tree: {
      id: 'root',
      type: 'Box',
      children: [{ id: 'title', type: 'Title', props: { text: title } }],
    },
    state: {},
    freshness: { updatedAt: clock.toISOString(), updatedBy: 'agent' },
  })
}

const HOUR_MS = 60 * 60 * 1000

function makeHeartbeat(options: {
  complete: HeartbeatOptions['complete']
  config?: Partial<HeartbeatConfig>
  onSwept?: () => void
}): Heartbeat {
  return new Heartbeat({
    store,
    scheduler,
    router,
    config: heartbeatConfig(options.config),
    complete: options.complete,
    now,
    onEscalation: (spaceId, text) => escalations.push({ spaceId, text }),
    ...(options.onSwept === undefined ? {} : { onSwept: options.onSwept }),
  })
}

beforeEach(() => {
  rootDir = mkdtempSync(join(tmpdir(), 'veduta-heartbeat-'))
  clock = new Date('2026-07-08T06:00:00.000Z')
  escalations = []
  store = new Store({ rootDir, now })
  ensureSystemSpace(store.spacesEngine)
  scheduler = new Scheduler({ rootDir, store, now })
  router = new ModelRouter({ config: routingConfig, now, sleep: async () => {} })
})

afterEach(() => {
  scheduler.stop()
  rmSync(rootDir, { recursive: true, force: true })
})

describe('buildChecklist', () => {
  it('flags a stale time-sensitive Surface with no coverage, and excludes FACTS/Automations Surfaces', () => {
    store.createSurface(planSurface(), 'agent')
    clock = new Date(clock.getTime() + 25 * HOUR_MS)
    const heartbeat = makeHeartbeat({ complete: async () => ({ text: '{"status":"nothing"}' }) })

    const checklist = heartbeat.buildChecklist()
    const healthEntry = checklist.spaces.find((entry) => entry.spaceId === HEALTH)
    expect(healthEntry?.surfaces).toContainEqual({
      surfaceId: 'srf-todays-plan',
      isStale: true,
      ageHours: 25,
      isTimeSensitive: true,
      hasCoverage: false,
    })

    const flaggedIds = checklist.spaces.flatMap((entry) => entry.surfaces.map((s) => s.surfaceId))
    expect(flaggedIds).not.toContain('srf-health-facts')
    expect(flaggedIds).not.toContain('srf-health-automations')
  })

  it('is not stale below the threshold (still flagged while uncovered and time-sensitive)', () => {
    store.createSurface(planSurface({ id: 'srf-recent-plan' }), 'agent')
    clock = new Date(clock.getTime() + 20 * HOUR_MS)
    const heartbeat = makeHeartbeat({ complete: async () => ({ text: '{"status":"nothing"}' }) })

    const entry = heartbeat.buildChecklist().spaces.find((space) => space.spaceId === HEALTH)
    const surfaceEntry = entry?.surfaces.find((s) => s.surfaceId === 'srf-recent-plan')
    expect(surfaceEntry).toMatchObject({
      isStale: false,
      isTimeSensitive: true,
      hasCoverage: false,
    })
  })

  it('marks a Surface covered by an armed timer as hasCoverage (still flagged while stale)', () => {
    store.createSurface(planSurface(), 'agent')
    scheduler.armTimer({
      spaceId: HEALTH,
      when: new Date(clock.getTime() + 60 * HOUR_MS).toISOString(),
      action: 'check the plan',
      targetSurfaceId: 'srf-todays-plan',
    })
    clock = new Date(clock.getTime() + 25 * HOUR_MS)
    const heartbeat = makeHeartbeat({ complete: async () => ({ text: '{"status":"nothing"}' }) })

    const entry = heartbeat.buildChecklist().spaces.find((space) => space.spaceId === HEALTH)
    const surfaceEntry = entry?.surfaces.find((s) => s.surfaceId === 'srf-todays-plan')
    expect(surfaceEntry).toMatchObject({ isStale: true, hasCoverage: true })
  })
})

describe('acceptance criteria', () => {
  it('#1 makes exactly one triage call and zero reasoning calls when there is nothing to do', async () => {
    const heartbeat = makeHeartbeat({ complete: async () => ({ text: '{"status":"nothing"}' }) })

    const outcome = await heartbeat.runSweep()

    expect(outcome).toBe('nothing')
    expect(router.callLog().filter((call) => call.purpose === 'heartbeat')).toHaveLength(1)
    expect(router.callLog().filter((call) => call.purpose === 'heartbeat-reasoning')).toHaveLength(
      0,
    )
  })

  it('#2 arms an idempotent coverage timer and escalates a stale, uncovered Surface', async () => {
    const surface = planSurface()
    store.createSurface(surface, 'agent')
    clock = new Date(clock.getTime() + 25 * HOUR_MS)

    const heartbeat = makeHeartbeat({
      complete: async (model: ModelRef, prompt: string) => {
        if (model.tier === 'triage') {
          // Fails if runSweep ever stops feeding this sweep's actual
          // checklist to the triage prompt.
          expect(prompt).toContain(surface.id)
          return {
            text: JSON.stringify({
              status: 'concerns',
              concerns: [
                { spaceId: HEALTH, surfaceId: surface.id, kind: 'uncovered-time-sensitive' },
              ],
            }),
          }
        }
        return {
          text: JSON.stringify({
            decisions: [
              { spaceId: HEALTH, surfaceId: surface.id, action: 'arm-timer' },
              { spaceId: HEALTH, surfaceId: surface.id, action: 'escalate' },
            ],
          }),
        }
      },
    })

    // Precondition: the stale Surface is actually present in the checklist
    // before the sweep runs, so the assertion above is not trivially true.
    const preSweepEntry = heartbeat
      .buildChecklist()
      .spaces.find((entry) => entry.spaceId === HEALTH)
    expect(preSweepEntry?.surfaces.map((s) => s.surfaceId)).toContain(surface.id)

    const first = await heartbeat.runSweep()
    expect(first).toBe('acted')
    expect(scheduler.listAutomations(HEALTH)).toEqual(
      expect.arrayContaining([
        expect.objectContaining(
          fromPartial<Automation>({ status: 'armed', enabled: true, targetSurfaceId: surface.id }),
        ),
      ]),
    )
    expect(escalations).toHaveLength(1)
    expect(escalations[0]?.spaceId).toBe(HEALTH)

    const armedAfterFirst = scheduler
      .listAutomations(HEALTH)
      .filter(
        (automation) => automation.targetSurfaceId === surface.id && automation.status === 'armed',
      )
    expect(armedAfterFirst).toHaveLength(1)

    // A second sweep must not arm a duplicate timer: the Surface is already covered.
    const second = await heartbeat.runSweep()
    expect(second).toBe('acted')
    const armedAfterSecond = scheduler
      .listAutomations(HEALTH)
      .filter(
        (automation) => automation.targetSurfaceId === surface.id && automation.status === 'armed',
      )
    expect(armedAfterSecond).toHaveLength(1)
  })

  it('#3 enabled:false arms nothing, causes zero router calls across scheduled instants, and runSweep short-circuits', async () => {
    const heartbeat = new Heartbeat({
      store,
      scheduler,
      router,
      config: heartbeatConfig({ enabled: false }),
      complete: async () => ({ text: '{"status":"nothing"}' }),
      now,
    })
    heartbeat.register()
    heartbeat.reconcileJobs()

    expect(
      scheduler
        .listAutomations(SYSTEM_SPACE_ID)
        .filter(
          (automation) => automation.handler === 'heartbeat' && automation.status === 'armed',
        ),
    ).toHaveLength(0)

    // Advance the clock across both configured heartbeat instants and drive the scheduler.
    clock = new Date('2026-07-09T19:00:00.000Z')
    await scheduler.runDue()

    expect(
      router
        .callLog()
        .filter((call) => call.purpose === 'heartbeat' || call.purpose === 'heartbeat-reasoning'),
    ).toHaveLength(0)

    await expect(heartbeat.runSweep()).resolves.toBe('skipped:disabled')
  })

  it('drops a triage concern naming a Surface the checklist did not observe (hallucination/injection guard)', async () => {
    // Fresh (not stale) and not time-sensitive: buildChecklist never flags
    // it, so a triage concern naming it must be dropped, not acted on.
    const groceryList = SurfaceSchema.parse({
      id: 'srf-grocery-list',
      spaceId: HEALTH,
      title: 'Grocery list',
      tree: { id: 'root', type: 'Box', children: [] },
      state: {},
      freshness: { updatedAt: clock.toISOString(), updatedBy: 'agent' },
    })
    store.createSurface(groceryList, 'agent')

    const heartbeat = makeHeartbeat({
      complete: async (model: ModelRef) => {
        if (model.tier === 'triage') {
          return {
            text: JSON.stringify({
              status: 'concerns',
              concerns: [{ spaceId: HEALTH, surfaceId: groceryList.id, kind: 'stale-surface' }],
            }),
          }
        }
        return { text: JSON.stringify({ decisions: [] }) }
      },
    })

    // Precondition: this existing Surface is not in the checklist.
    const preSweepEntry = heartbeat
      .buildChecklist()
      .spaces.find((entry) => entry.spaceId === HEALTH)
    expect(preSweepEntry?.surfaces.map((s) => s.surfaceId) ?? []).not.toContain(groceryList.id)

    const outcome = await heartbeat.runSweep()

    expect(outcome).toBe('nothing')
    expect(escalations).toHaveLength(0)
    expect(
      scheduler.listAutomations(HEALTH).filter((a) => a.targetSurfaceId === groceryList.id),
    ).toHaveLength(0)
    expect(router.callLog().filter((call) => call.purpose === 'heartbeat-reasoning')).toHaveLength(
      0,
    )
  })

  it('records skipped-capped (not a throw) when the reasoning tier cap is exhausted mid-sweep', async () => {
    const surface = planSurface()
    store.createSurface(surface, 'agent')
    clock = new Date(clock.getTime() + 25 * HOUR_MS)

    // The reasoning tier is over cap before the sweep starts; triage itself
    // is still allowed, so the cap is only crossed mid-sweep.
    router.recordSpend({ provider: 'mock', modelId: 'reasoning-mock', tier: 'reasoning' }, 999)

    const heartbeat = makeHeartbeat({
      complete: async (model: ModelRef) => {
        if (model.tier === 'triage') {
          return {
            text: JSON.stringify({
              status: 'concerns',
              concerns: [
                { spaceId: HEALTH, surfaceId: surface.id, kind: 'uncovered-time-sensitive' },
              ],
            }),
          }
        }
        throw new Error('reasoning tier must never actually execute: the cap check throws first')
      },
    })

    const outcome = await heartbeat.runSweep()

    expect(outcome).toBe('skipped-capped')
    expect(
      scheduler.listAutomations(HEALTH).filter((a) => a.targetSurfaceId === surface.id),
    ).toHaveLength(0)
  })

  it('skips a capped sweep without ever calling complete', async () => {
    router.recordSpend({ provider: 'mock', modelId: 'triage-mock', tier: 'triage' }, 999)
    let calls = 0
    const heartbeat = makeHeartbeat({
      complete: async () => {
        calls += 1
        return { text: '{"status":"nothing"}' }
      },
    })

    const outcome = await heartbeat.runSweep()

    expect(outcome).toBe('skipped-capped')
    expect(calls).toBe(0)
  })
})

describe('reconcileJobs', () => {
  it('creates one managed job per configured time when enabled, and never touches an existing job again', () => {
    const heartbeat = makeHeartbeat({ complete: async () => ({ text: '{"status":"nothing"}' }) })
    heartbeat.reconcileJobs()

    const jobs = scheduler
      .listAutomations(SYSTEM_SPACE_ID)
      .filter((automation) => automation.handler === 'heartbeat')
    expect(jobs).toHaveLength(2)
    expect(jobs.map((job) => job.cron).sort()).toEqual(['0 18 * * *', '0 6 * * *'])

    // A user toggles one job off; a second reconcile must not re-enable it or duplicate it.
    const firstJob = jobs[0]
    if (firstJob) scheduler.setEnabled(firstJob.id, false, 'tool')
    heartbeat.reconcileJobs()

    const afterSecondReconcile = scheduler
      .listAutomations(SYSTEM_SPACE_ID)
      .filter((automation) => automation.handler === 'heartbeat')
    expect(afterSecondReconcile).toHaveLength(2)
    expect(afterSecondReconcile.find((job) => job.id === firstJob?.id)?.enabled).toBe(false)
  })

  it('converges to exactly the new desired schedule when config.times changes', () => {
    const heartbeat = makeHeartbeat({ complete: async () => ({ text: '{"status":"nothing"}' }) })
    heartbeat.reconcileJobs()
    const original = scheduler
      .listAutomations(SYSTEM_SPACE_ID)
      .filter((automation) => automation.handler === 'heartbeat')
    expect(original).toHaveLength(2)

    const reconfigured = makeHeartbeat({
      complete: async () => ({ text: '{"status":"nothing"}' }),
      config: { times: ['09:00'] },
    })
    reconfigured.reconcileJobs()

    const armed = scheduler
      .listAutomations(SYSTEM_SPACE_ID)
      .filter((automation) => automation.handler === 'heartbeat' && automation.status === 'armed')
    expect(armed).toHaveLength(1)
    expect(armed[0]?.cron).toBe('0 9 * * *')

    const original06and18 = original.filter((job) => job.cron !== '0 9 * * *')
    for (const job of original06and18) {
      expect(
        scheduler.listAutomations(SYSTEM_SPACE_ID).find((automation) => automation.id === job.id)
          ?.status,
      ).toBe('cancelled')
    }
  })
})

describe('metrics', () => {
  it('counts two direct sweeps at the same instant and reports nothingRatio/avgCostUsd', async () => {
    // Two direct runSweep() calls carry NO occurrence, so they are inherently
    // unique and must both count even at the same wall-clock instant — the
    // old wall-clock dedup would have wrongly merged them.
    const nothingHeartbeat = makeHeartbeat({
      complete: async () => ({ text: '{"status":"nothing"}', costUsd: 0.01 }),
    })
    await nothingHeartbeat.runSweep()

    const surface = planSurface({ id: 'srf-metrics-plan' })
    store.createSurface(surface, 'agent')
    const actingHeartbeat = makeHeartbeat({
      complete: async (model: ModelRef) => {
        if (model.tier === 'triage') {
          return {
            text: JSON.stringify({
              status: 'concerns',
              concerns: [{ spaceId: HEALTH, surfaceId: surface.id, kind: 'stale-surface' }],
            }),
            costUsd: 0.02,
          }
        }
        return {
          text: JSON.stringify({
            decisions: [{ spaceId: HEALTH, surfaceId: surface.id, action: 'ignore' }],
          }),
          costUsd: 0.03,
        }
      },
    })
    await actingHeartbeat.runSweep()

    const metrics = nothingHeartbeat.metrics()
    expect(metrics.sweeps).toBe(2)
    expect(metrics.nothing).toBe(1)
    expect(metrics.acted).toBe(1)
    expect(metrics.nothingRatio).toBeCloseTo(0.5)
    expect(metrics.avgCostUsd).toBeCloseTo((0.01 + 0.05) / 2)
  })

  it('dedups an at-least-once recovery re-run by scheduler occurrence, not wall-clock', async () => {
    const heartbeat = makeHeartbeat({
      complete: async () => ({ text: '{"status":"nothing"}' }),
    })
    // Two genuine direct sweeps (no occurrence) — each counts.
    await heartbeat.runSweep()
    await heartbeat.runSweep()

    // One scheduled occurrence, recorded twice at DIFFERENT wall-clocks: the
    // original run, then a boot-recovery re-run of the identical scheduled
    // instant. Same payload.occurrence ⇒ must collapse to a single sweep.
    const occurrence = 'hb-occ-1'
    const appendOccurrenceSweep = (at: string) =>
      store.spacesEngine.appendEvent(SYSTEM_SPACE_ID, {
        type: 'heartbeat.sweep',
        text: 'Heartbeat sweep: nothing',
        origin: 'trusted:system',
        payload: { outcome: 'nothing', at, occurrence },
        at,
      })
    appendOccurrenceSweep('2026-07-08T06:00:00.000Z')
    appendOccurrenceSweep('2026-07-08T06:07:31.000Z')

    // 2 direct sweeps + 1 collapsed occurrence (the two copies count once).
    expect(heartbeat.metrics().sweeps).toBe(3)
  })
})
