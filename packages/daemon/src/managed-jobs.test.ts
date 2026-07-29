import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { reconcileManagedJobs } from './managed-jobs.ts'
import { Scheduler } from './scheduler.ts'
import { Store } from './store.ts'

const HEALTH = 'spc-health'
const HANDLER = 'reflection'

let rootDir: string
let clock: Date
let store: Store
let scheduler: Scheduler

const now = () => new Date(clock.getTime())

beforeEach(() => {
  rootDir = mkdtempSync(join(tmpdir(), 'veduta-managed-jobs-'))
  clock = new Date('2026-07-08T13:00:00.000Z')
  store = new Store({ rootDir, now })
  scheduler = new Scheduler({ rootDir, store, now })
})

afterEach(() => {
  scheduler.stop()
})

function jobsFor(handler: string) {
  return scheduler.listAutomations(HEALTH).filter((automation) => automation.handler === handler)
}

function armedJobsFor(handler: string) {
  return jobsFor(handler).filter((job) => job.status === 'armed')
}

describe('reconcileManagedJobs', () => {
  it('creates one job per desired cron on an empty scheduler', () => {
    reconcileManagedJobs({
      scheduler,
      spaceId: HEALTH,
      handler: HANDLER,
      enabled: true,
      desired: new Map([
        ['0 4 * * *', 'Nightly Reflection at 04:00'],
        ['0 16 * * *', 'Afternoon Reflection at 16:00'],
      ]),
      timezone: 'Europe/Rome',
    })

    const jobs = armedJobsFor(HANDLER)
    expect(jobs).toHaveLength(2)
    for (const job of jobs) {
      expect(job.handler).toBe(HANDLER)
      expect(job.spaceId).toBe(HEALTH)
      expect(job.timezone).toBe('Europe/Rome')
    }
    const byCron = new Map(jobs.map((job) => [job.cron, job.description]))
    expect(byCron.get('0 4 * * *')).toBe('Nightly Reflection at 04:00')
    expect(byCron.get('0 16 * * *')).toBe('Afternoon Reflection at 16:00')
  })

  it('reconciling twice creates nothing the second time', () => {
    const desired = new Map([['0 4 * * *', 'Nightly Reflection at 04:00']])
    reconcileManagedJobs({ scheduler, spaceId: HEALTH, handler: HANDLER, enabled: true, desired })
    const firstIds = armedJobsFor(HANDLER)
      .map((job) => job.id)
      .sort()

    reconcileManagedJobs({ scheduler, spaceId: HEALTH, handler: HANDLER, enabled: true, desired })
    const secondIds = armedJobsFor(HANDLER)
      .map((job) => job.id)
      .sort()

    expect(secondIds).toEqual(firstIds)
    expect(jobsFor(HANDLER)).toHaveLength(1)
  })

  it('changing the desired cron cancels the old job and creates exactly one new one', () => {
    reconcileManagedJobs({
      scheduler,
      spaceId: HEALTH,
      handler: HANDLER,
      enabled: true,
      desired: new Map([['0 4 * * *', 'Nightly Reflection at 04:00']]),
    })
    const original = armedJobsFor(HANDLER)[0]
    expect(original).toBeDefined()

    reconcileManagedJobs({
      scheduler,
      spaceId: HEALTH,
      handler: HANDLER,
      enabled: true,
      desired: new Map([['0 5 * * *', 'Nightly Reflection at 05:00']]),
    })

    const armed = armedJobsFor(HANDLER)
    expect(armed).toHaveLength(1)
    expect(armed[0]?.cron).toBe('0 5 * * *')
    expect(scheduler.listAutomations(HEALTH).find((job) => job.id === original?.id)?.status).toBe(
      'cancelled',
    )
  })

  // The case a cron-only key would miss: the cron string does not change,
  // only the zone it is read in, so a key of the cron alone would treat the
  // old job as still wanted and leave it firing at the previous zone.
  it('changing only the timezone, cron unchanged, cancels the old job and creates one carrying the new zone', () => {
    reconcileManagedJobs({
      scheduler,
      spaceId: HEALTH,
      handler: HANDLER,
      enabled: true,
      desired: new Map([['0 4 * * *', 'Nightly Reflection at 04:00']]),
      timezone: 'Europe/Rome',
    })
    const original = armedJobsFor(HANDLER)[0]
    expect(original).toBeDefined()

    reconcileManagedJobs({
      scheduler,
      spaceId: HEALTH,
      handler: HANDLER,
      enabled: true,
      desired: new Map([['0 4 * * *', 'Nightly Reflection at 04:00']]),
      timezone: 'America/New_York',
    })

    const armed = armedJobsFor(HANDLER)
    expect(armed).toHaveLength(1)
    expect(armed[0]?.cron).toBe('0 4 * * *')
    expect(armed[0]?.timezone).toBe('America/New_York')
    expect(scheduler.listAutomations(HEALTH).find((job) => job.id === original?.id)?.status).toBe(
      'cancelled',
    )
  })

  it('collapses two duplicate armed jobs on the same key to one, the lowest id surviving', () => {
    const first = scheduler.createManagedJob({
      spaceId: HEALTH,
      cron: '0 4 * * *',
      description: 'Nightly Reflection at 04:00',
      handler: HANDLER,
    })
    const second = scheduler.createManagedJob({
      spaceId: HEALTH,
      cron: '0 4 * * *',
      description: 'Nightly Reflection at 04:00',
      handler: HANDLER,
    })
    expect(second.id).toBeGreaterThan(first.id)

    reconcileManagedJobs({
      scheduler,
      spaceId: HEALTH,
      handler: HANDLER,
      enabled: true,
      desired: new Map([['0 4 * * *', 'Nightly Reflection at 04:00']]),
    })

    const armed = armedJobsFor(HANDLER)
    expect(armed).toHaveLength(1)
    expect(armed[0]?.id).toBe(first.id)
    expect(scheduler.listAutomations(HEALTH).find((job) => job.id === second.id)?.status).toBe(
      'cancelled',
    )
  })

  it('leaves a survivor the user switched off disabled across a reconcile', () => {
    const desired = new Map([['0 4 * * *', 'Nightly Reflection at 04:00']])
    reconcileManagedJobs({ scheduler, spaceId: HEALTH, handler: HANDLER, enabled: true, desired })
    const job = armedJobsFor(HANDLER)[0]
    expect(job).toBeDefined()
    if (!job) throw new Error('expected a job')

    scheduler.setEnabled(job.id, false, 'tool')
    expect(scheduler.listAutomations(HEALTH).find((j) => j.id === job.id)?.enabled).toBe(false)

    reconcileManagedJobs({ scheduler, spaceId: HEALTH, handler: HANDLER, enabled: true, desired })

    const afterReconcile = scheduler.listAutomations(HEALTH).find((j) => j.id === job.id)
    expect(afterReconcile?.status).toBe('armed')
    expect(afterReconcile?.enabled).toBe(false)
    expect(armedJobsFor(HANDLER)).toHaveLength(1)
  })

  it('enabled: false cancels every armed job of the handler and creates nothing', () => {
    const desired = new Map([
      ['0 4 * * *', 'Nightly Reflection at 04:00'],
      ['0 16 * * *', 'Afternoon Reflection at 16:00'],
    ])
    reconcileManagedJobs({ scheduler, spaceId: HEALTH, handler: HANDLER, enabled: true, desired })
    expect(armedJobsFor(HANDLER)).toHaveLength(2)

    reconcileManagedJobs({ scheduler, spaceId: HEALTH, handler: HANDLER, enabled: false, desired })

    expect(armedJobsFor(HANDLER)).toHaveLength(0)
    const all = jobsFor(HANDLER)
    expect(all).toHaveLength(2)
    expect(all.every((job) => job.status === 'cancelled')).toBe(true)
  })

  it('leaves jobs belonging to a different handler untouched', () => {
    const other = scheduler.createManagedJob({
      spaceId: HEALTH,
      cron: '0 6 * * *',
      description: 'Heartbeat sweep at 06:00 UTC',
      handler: 'heartbeat',
    })

    reconcileManagedJobs({
      scheduler,
      spaceId: HEALTH,
      handler: HANDLER,
      enabled: true,
      desired: new Map([['0 4 * * *', 'Nightly Reflection at 04:00']]),
    })

    const untouched = scheduler.listAutomations(HEALTH).find((job) => job.id === other.id)
    expect(untouched?.status).toBe('armed')
    expect(untouched?.handler).toBe('heartbeat')
    expect(untouched?.cron).toBe('0 6 * * *')
  })
})
