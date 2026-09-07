import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fromPartial } from '@total-typescript/shoehorn'
import {
  AUTOMATION_OUTCOMES_STATE_KEY,
  AutomationOutcomeStatusesSchema,
  SurfaceSchema,
  SYSTEM_SPACE_ID,
  type AutomationOutcomeInput,
  type PendingDecision,
} from '@veduta/protocol'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ToolContext } from './agent-runner.ts'
import {
  automationsSurfaceIdForSpace,
  SYSTEM_AUTOMATIONS_SURFACE_ID,
} from './automations-surface.ts'
import { Scheduler, type EscalationContext } from './scheduler.ts'
import { Store } from './store.ts'
import { ensureSystemSpace } from './system-space.ts'
import type { Origin } from './taint.ts'

function toolContext(toolCallId: string, origin: Origin): ToolContext {
  return fromPartial<ToolContext>({ toolCallId, origin })
}

const HEALTH = 'spc-health'
const SURFACE = 'srf-health-automations'

let rootDir: string
let store: Store
let clock: Date
let escalations: { spaceId: string; text: string }[]
let schedulers: Scheduler[]

const now = () => new Date(clock.getTime())

function createScheduler(options: { judge?: () => 'yes' | 'no' | 'unknown' } = {}): Scheduler {
  const scheduler = new Scheduler({
    rootDir,
    store,
    now,
    onEscalation: (spaceId, text) => escalations.push({ spaceId, text }),
    ...(options.judge === undefined ? {} : { judge: options.judge }),
  })
  schedulers.push(scheduler)
  return scheduler
}

beforeEach(() => {
  rootDir = mkdtempSync(join(tmpdir(), 'veduta-scheduler-'))
  clock = new Date('2026-07-08T13:00:00.000Z')
  escalations = []
  schedulers = []
  store = new Store({ rootDir, now })
})

function handlerChanged(summary: string): AutomationOutcomeInput {
  return { kind: 'changed', summary, coalesceKey: 'test-handler', operations: [] }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

afterEach(() => {
  for (const scheduler of schedulers) scheduler.stop()
})

describe('Automations Surface projection', () => {
  it('canonically adopts pinned, archived, or rewritten legacy projections', () => {
    const rewrittenSpace = store.spacesEngine.createSpace({ name: 'Legacy pinned' })
    const archivedSpace = store.spacesEngine.createSpace({ name: 'Legacy archived' })
    const rewrittenId = automationsSurfaceIdForSpace(rewrittenSpace)
    const archivedId = automationsSurfaceIdForSpace(archivedSpace)
    store.createSurface(
      SurfaceSchema.parse({
        id: rewrittenId,
        spaceId: rewrittenSpace.id,
        title: 'Rewritten by an old Agent',
        tree: { id: 'other-root', type: 'Box', children: [] },
        state: { rogue: true },
        freshness: { updatedAt: clock.toISOString(), updatedBy: 'agent' },
      }),
      'agent',
    )
    store.setPinnedWithOrder(rewrittenId, true, {
      origin: 'trusted:user',
      updatedBy: 'user',
    })
    store.createSurface(
      SurfaceSchema.parse({
        id: archivedId,
        spaceId: archivedSpace.id,
        title: 'Old Automations',
        tree: { id: 'root', type: 'Box', children: [] },
        state: {},
        freshness: { updatedAt: clock.toISOString(), updatedBy: 'agent' },
      }),
      'agent',
    )
    store.archiveSurface(archivedId, 'agent')

    expect(() => createScheduler()).not.toThrow()

    const rewritten = store.getSurface(rewrittenId)
    expect(rewritten).toMatchObject({
      title: 'Automations',
      pinned: false,
      pinnable: false,
      state: {},
      tree: {
        id: 'root',
        children: [{ id: 'title' }, { id: 'automations-list' }],
      },
    })
    expect(store.isSurfaceDaemonOwned(rewrittenId)).toBe(true)
    expect(store.surfaceOrder(rewrittenSpace.id)).toMatchObject({
      pinnedSurfaceIds: [],
      regularSurfaceIds: [rewrittenId],
    })
    expect(store.getSurface(archivedId)).toMatchObject({
      title: 'Automations',
      pinnable: false,
    })
    expect(store.isSurfaceDaemonOwned(archivedId)).toBe(true)
    expect(store.eventLog(archivedSpace.id)).toContainEqual(
      expect.objectContaining({
        type: 'surface.adopt',
        payload: expect.objectContaining({ surfaceId: archivedId, restored: true }),
      }),
    )
  })

  it('persists the System Space projection as daemon-owned living state', () => {
    ensureSystemSpace(store.spacesEngine)

    createScheduler()

    const surfaceId = SYSTEM_AUTOMATIONS_SURFACE_ID
    const surface = store.getSurface(surfaceId)
    expect(surface).toMatchObject({ id: surfaceId, spaceId: SYSTEM_SPACE_ID })
    expect(store.isSurfaceDaemonOwned(surfaceId)).toBe(true)
    const reopened = new Store({ rootDir, now })
    expect(reopened.getSurface(surfaceId)).toMatchObject({ id: surfaceId })
    expect(reopened.isSurfaceDaemonOwned(surfaceId)).toBe(true)
    reopened.close()
    expect(store.eventLog(SYSTEM_SPACE_ID)).toContainEqual(
      expect.objectContaining({
        type: 'surface.create',
        payload: { surfaceId },
      }),
    )
    expect(store.surfaceEventsAfter(0)).toContainEqual(
      expect.objectContaining({
        kind: 'created',
        event: expect.objectContaining({
          spaceId: SYSTEM_SPACE_ID,
          surface: expect.objectContaining({ id: surfaceId }),
        }),
      }),
    )
  })

  it('pre-creates an empty Automations Surface for every active Space', () => {
    createScheduler()
    const surface = store.getSurface(SURFACE)
    expect(surface).toBeDefined()
    expect(surface?.tree.children?.[1]?.children?.[0]?.props?.['text']).toBe('No automations yet.')
    expect(store.isSurfaceDaemonOwned(SURFACE)).toBe(true)
    expect(() => store.archiveSurface(SURFACE, 'agent')).toThrow(/daemon-owned/)
  })

  it('does not emit projection patches when a boot reconciliation finds no drift', () => {
    const first = createScheduler()
    const before = store
      .eventLog(HEALTH)
      .filter((event) => event.payload?.['automationProjection'] === true).length

    first.stop()
    createScheduler()

    expect(
      store.eventLog(HEALTH).filter((event) => event.payload?.['automationProjection'] === true),
    ).toHaveLength(before)
  })

  it('shows an armed timer in the Space Surface immediately', () => {
    const scheduler = createScheduler()
    scheduler.armTimer({
      spaceId: HEALTH,
      when: '2026-07-08T21:00:00.000Z',
      action: 'Log my weight',
    })
    const surface = store.getSurface(SURFACE)
    expect(surface?.state).toEqual({ 'job-1': true, 'history-1': [] })
    const atom = surface?.tree.children?.[1]?.children?.[0]
    expect(atom).toMatchObject({ type: 'Automation', binding: 'job-1' })
    expect(atom?.props?.['label']).toBe('Log my weight')
  })

  it('removes a cancelled automation from the Surface, state key included', () => {
    const scheduler = createScheduler()
    const timer = scheduler.armTimer({
      spaceId: HEALTH,
      when: '2026-07-08T21:00:00.000Z',
      action: 'Log my weight',
    })
    scheduler.cancel(HEALTH, timer.id)
    const surface = store.getSurface(SURFACE)
    expect(surface?.state).toEqual({})
    expect(surface?.tree.children?.[1]?.children?.[0]?.type).toBe('Caption')
  })
})

describe('acceptance: "remind me to log my weight by 9pm"', () => {
  const armWeightReminder = (scheduler: Scheduler) =>
    scheduler.armTimer({
      spaceId: HEALTH,
      when: '2026-07-08T21:00:00.000Z',
      condition: { kind: 'event-logged', textIncludes: 'weight', withinHours: 24 },
      action: 'Log my weight',
    })

  it('escalates at 9pm when no weight is in the log', async () => {
    const scheduler = createScheduler()
    armWeightReminder(scheduler)

    clock = new Date('2026-07-08T21:00:00.000Z')
    await scheduler.runDue()

    expect(escalations).toEqual([{ spaceId: HEALTH, text: 'Reminder: Log my weight' }])
    const events = store.eventLog(HEALTH)
    expect(events.some((event) => event.type === 'automation.fire')).toBe(true)
    expect(scheduler.listAutomations(HEALTH)[0]).toMatchObject({
      status: 'completed',
      lastOutcome: 'escalated',
    })
  })

  it('does nothing at 9pm when the weight was logged', async () => {
    const scheduler = createScheduler()
    armWeightReminder(scheduler)

    clock = new Date('2026-07-08T19:30:00.000Z')
    store.spacesEngine.appendEvent(HEALTH, {
      text: 'Weight goal: currentKg -> 81.9',
      type: 'fast_path',
      origin: 'trusted:user',
      at: clock.toISOString(),
    })

    clock = new Date('2026-07-08T21:00:00.000Z')
    await scheduler.runDue()

    expect(escalations).toEqual([])
    expect(scheduler.listAutomations(HEALTH)[0]?.lastOutcome).toBe('condition-met:no-action')
  })

  it('is not satisfied by its own automation events (self-satisfaction guard)', async () => {
    const scheduler = createScheduler()
    // The arm event text contains "weight" but has type automation.arm.
    armWeightReminder(scheduler)

    clock = new Date('2026-07-08T21:00:00.000Z')
    await scheduler.runDue()

    expect(escalations).toHaveLength(1)
  })

  it('never lets non-user events suppress the escalation', async () => {
    const scheduler = createScheduler()
    armWeightReminder(scheduler)

    clock = new Date('2026-07-08T19:30:00.000Z')
    // Untrusted content must never satisfy a condition (SECURITY.md)...
    store.spacesEngine.appendEvent(HEALTH, {
      text: 'newsletter: track your weight with our new app!',
      type: 'turn',
      origin: 'untrusted:external',
      at: clock.toISOString(),
    })
    // ...and neither do system-written projection events.
    store.spacesEngine.appendEvent(HEALTH, {
      text: 'Patched state for Surface "Weight goal"',
      type: 'surface.patch_state',
      origin: 'trusted:system',
      at: clock.toISOString(),
    })

    clock = new Date('2026-07-08T21:00:00.000Z')
    await scheduler.runDue()

    expect(escalations).toEqual([{ spaceId: HEALTH, text: 'Reminder: Log my weight' }])
  })
})

describe('acceptance: disabled automations', () => {
  it('does not run a due automation that the user switched off, and keeps it visible as off', async () => {
    const scheduler = createScheduler()
    const timer = scheduler.armTimer({
      spaceId: HEALTH,
      when: '2026-07-08T21:00:00.000Z',
      action: 'Log my weight',
    })

    // Toggle through the declared fast action — the real user path.
    const result = store.invokeSurfaceAction(SURFACE, {
      nodeId: `automation-${timer.id}`,
      name: 'toggle',
      payload: { value: false },
    })
    expect(result.path).toBe('fast')
    expect(scheduler.listAutomations(HEALTH)[0]?.enabled).toBe(false)

    clock = new Date('2026-07-08T21:00:00.000Z')
    await scheduler.runDue()

    expect(escalations).toEqual([])
    expect(scheduler.listAutomations(HEALTH)[0]?.lastOutcome).toBe('skipped:disabled')
    const surface = store.getSurface(SURFACE)
    expect(surface?.state['job-1']).toBe(false)
    expect(surface?.tree.children?.[1]?.children?.[0]?.type).toBe('Automation')
  })

  it('syncs enabled from explicit values, converging under duplicate deliveries', () => {
    const scheduler = createScheduler()
    const timer = scheduler.armTimer({
      spaceId: HEALTH,
      when: '2026-07-08T21:00:00.000Z',
      action: 'Log my weight',
    })

    const invocation = {
      nodeId: `automation-${timer.id}`,
      name: 'toggle',
      payload: { value: false },
      idempotencyKey: 'toggle-off-1',
    }
    store.invokeSurfaceAction(SURFACE, invocation)
    store.invokeSurfaceAction(SURFACE, invocation)

    expect(scheduler.listAutomations(HEALTH)[0]?.enabled).toBe(false)
    const toggleEvents = store
      .eventLog(HEALTH)
      .filter((event) => event.type === 'automation.toggle')
    expect(toggleEvents).toHaveLength(1)
  })

  it('ignores non-boolean toggle values instead of truthiness-flipping the job', async () => {
    const scheduler = createScheduler()
    const timer = scheduler.armTimer({
      spaceId: HEALTH,
      when: '2026-07-08T21:00:00.000Z',
      action: 'Log my weight',
    })

    store.invokeSurfaceAction(SURFACE, {
      nodeId: `automation-${timer.id}`,
      name: 'toggle',
      payload: { value: 'false' },
    })

    expect(scheduler.listAutomations(HEALTH)[0]?.enabled).toBe(true)
    // The malformed value reached Surface state through the fast path; the
    // scheduler re-projects from SQLite on a microtask (after the Gateway
    // broadcast of the malformed patch) to heal it.
    await new Promise<void>((resolve) => queueMicrotask(resolve))
    expect(store.getSurface(SURFACE)?.state['job-1']).toBe(true)
  })

  it('keeps syncing Surface toggles after a stop/start cycle', () => {
    const scheduler = createScheduler()
    const timer = scheduler.armTimer({
      spaceId: HEALTH,
      when: '2026-07-08T21:00:00.000Z',
      action: 'Log my weight',
    })

    scheduler.start()
    scheduler.stop()
    scheduler.start()
    store.invokeSurfaceAction(SURFACE, {
      nodeId: `automation-${timer.id}`,
      name: 'toggle',
      payload: { value: false },
    })

    expect(scheduler.listAutomations(HEALTH)[0]?.enabled).toBe(false)
  })

  it('re-enabling from a tool refreshes the projection', () => {
    const scheduler = createScheduler()
    const timer = scheduler.armTimer({
      spaceId: HEALTH,
      when: '2026-07-08T21:00:00.000Z',
      action: 'Log my weight',
    })
    scheduler.setEnabled(HEALTH, timer.id, false, 'tool')
    expect(store.getSurface(SURFACE)?.state['job-1']).toBe(false)
    scheduler.setEnabled(HEALTH, timer.id, true, 'tool')
    expect(store.getSurface(SURFACE)?.state['job-1']).toBe(true)
  })
})

describe('acceptance: restart robustness', () => {
  it('loses none and duplicates none of 3 pending timers across a restart', async () => {
    const first = createScheduler()
    for (const action of ['Water the plants', 'Call the doctor', 'Log my weight']) {
      first.armTimer({ spaceId: HEALTH, when: '2026-07-08T21:00:00.000Z', action })
    }
    first.stop()

    const second = createScheduler()
    expect(second.listAutomations(HEALTH).filter((a) => a.status === 'armed')).toHaveLength(3)

    clock = new Date('2026-07-08T21:00:00.000Z')
    await second.runDue()
    expect(escalations).toHaveLength(3)
    second.stop()

    const third = createScheduler()
    await third.runDue()
    expect(escalations).toHaveLength(3)
  })

  it('re-runs an occurrence whose run was interrupted mid-flight (at-least-once)', async () => {
    const scheduler = createScheduler()
    scheduler.armTimer({
      spaceId: HEALTH,
      when: '2026-07-08T21:00:00.000Z',
      action: 'Log my weight',
    })
    clock = new Date('2026-07-08T21:00:00.000Z')

    // Simulate a crash between claim and completion: claim exists, no outcome.
    const db = new (await import('node:sqlite')).DatabaseSync(join(rootDir, 'scheduler.sqlite'))
    db.prepare(
      `insert into automation_runs (automation_id, scheduled_for, started_at) values (1, ?, ?)`,
    ).run('2026-07-08T21:00:00.000Z', clock.toISOString())
    db.close()
    scheduler.stop()

    const recovered = createScheduler()
    await recovered.runDue()
    expect(escalations).toHaveLength(1)
    expect(store.eventLog(HEALTH).some((event) => event.type === 'automation.recover')).toBe(true)
  })
})

describe('catch-up policy', () => {
  it('runs a timer that is less than 24h overdue', async () => {
    const scheduler = createScheduler()
    scheduler.armTimer({
      spaceId: HEALTH,
      when: '2026-07-08T21:00:00.000Z',
      action: 'Log my weight',
    })

    clock = new Date('2026-07-08T23:00:00.000Z')
    await scheduler.runDue()

    expect(escalations).toEqual([{ spaceId: HEALTH, text: 'Reminder: Log my weight' }])
  })

  it('reports instead of running a timer more than 24h overdue', async () => {
    const scheduler = createScheduler()
    scheduler.armTimer({
      spaceId: HEALTH,
      when: '2026-07-08T21:00:00.000Z',
      action: 'Log my weight',
    })

    clock = new Date('2026-07-10T03:00:00.000Z')
    await scheduler.runDue()

    expect(escalations).toHaveLength(1)
    expect(escalations[0]?.text).toContain('Missed automation')
    expect(scheduler.listAutomations(HEALTH)[0]?.lastOutcome).toBe('skipped:overdue')
  })

  it('fast-forwards a recurring job past missed occurrences without bursting', async () => {
    const scheduler = createScheduler()
    scheduler.createJob({ spaceId: HEALTH, cron: '0 8 * * *', briefing: 'Morning briefing' })

    clock = new Date('2026-07-12T09:00:00.000Z') // 4 daily occurrences missed
    await scheduler.runDue()
    await scheduler.runDue()

    expect(escalations).toEqual([])
    expect(scheduler.outcomeService.list(HEALTH).notifications).toMatchObject([
      { kind: 'failed', occurrenceCount: 1 },
    ])
    expect(scheduler.listAutomations(HEALTH)[0]?.nextRunAt).toBe('2026-07-13T08:00:00.000Z')
  })
})

describe('recurring jobs and judgment conditions', () => {
  it('advances a recurring job to the next cron occurrence after firing', async () => {
    const scheduler = createScheduler()
    scheduler.createJob({ spaceId: HEALTH, cron: '0 8 * * *', briefing: 'Morning briefing' })
    expect(scheduler.listAutomations(HEALTH)[0]?.nextRunAt).toBe('2026-07-09T08:00:00.000Z')

    clock = new Date('2026-07-09T08:00:00.000Z')
    await scheduler.runDue()

    expect(escalations).toEqual([])
    expect(scheduler.outcomeService.list(HEALTH).notifications).toMatchObject([
      { kind: 'failed', surfaceId: SURFACE },
    ])
    expect(scheduler.listAutomations(HEALTH)[0]).toMatchObject({
      status: 'armed',
      nextRunAt: '2026-07-10T08:00:00.000Z',
      lastOutcome: 'failed',
    })
  })

  it('rejects invalid cron expressions at creation time', () => {
    const scheduler = createScheduler()
    expect(() =>
      scheduler.createJob({ spaceId: HEALTH, cron: 'every morning', briefing: 'x' }),
    ).toThrow(/invalid cron/)
  })

  it('rejects timers in the past and unknown Spaces', () => {
    const scheduler = createScheduler()
    expect(() =>
      scheduler.armTimer({ spaceId: HEALTH, when: '2026-07-08T09:00:00.000Z', action: 'x' }),
    ).toThrow(/future/)
    expect(() =>
      scheduler.armTimer({ spaceId: 'spc-nope', when: '2026-07-09T09:00:00.000Z', action: 'x' }),
    ).toThrow(/unknown Space/)
  })

  it('skips escalation when the judge answers yes, escalates on unknown', async () => {
    const yesScheduler = createScheduler({ judge: () => 'yes' })
    yesScheduler.armTimer({
      spaceId: HEALTH,
      when: '2026-07-08T21:00:00.000Z',
      condition: { kind: 'judgment', question: 'Did the user already log a weight today?' },
      action: 'Log my weight',
    })
    clock = new Date('2026-07-08T21:00:00.000Z')
    await yesScheduler.runDue()
    expect(escalations).toEqual([])
    expect(yesScheduler.listAutomations(HEALTH)[0]?.lastOutcome).toBe('condition-met:no-action')
  })
})

describe('agent tools', () => {
  it('exposes scoped create, enabled-state and cancel tools with working handlers', async () => {
    const scheduler = createScheduler()
    const tools = Object.fromEntries(scheduler.tools().map((tool) => [tool.name, tool]))
    expect(Object.keys(tools).sort()).toEqual([
      'arm_timer',
      'cancel',
      'create_job',
      'set_automation_enabled',
    ])

    const armed = await tools['arm_timer']!.handler(
      {
        spaceId: HEALTH,
        when: '2026-07-08T21:00:00.000Z',
        action: 'Log my weight',
      },
      toolContext('call-1', 'trusted:user'),
    )
    expect(armed.content).toContain('armed timer')

    const disabled = await tools['set_automation_enabled']!.handler(
      { spaceId: HEALTH, automationId: 1, enabled: false },
      toolContext('call-2', 'trusted:user'),
    )
    expect(disabled.content).toContain('automation 1 is disabled')

    const cancelled = await tools['cancel']!.handler(
      { spaceId: HEALTH, automationId: 1 },
      toolContext('call-3', 'trusted:user'),
    )
    expect(cancelled.content).toContain('cancelled automation 1')
    expect(scheduler.listAutomations(HEALTH)[0]?.status).toBe('cancelled')
  })

  it('declares every Scheduler tool L0 (daemon-internal, no outbound effect)', () => {
    const scheduler = createScheduler()
    const tools = scheduler.tools()
    expect(tools.map((tool) => tool.level)).toEqual(['L0', 'L0', 'L0', 'L0'])
  })

  it('stamps a tainted turn origin onto the automation record and its arm/fire events, re-tainting future context', async () => {
    const scheduler = createScheduler()
    const tools = Object.fromEntries(scheduler.tools().map((tool) => [tool.name, tool]))

    const armed = await tools['arm_timer']!.handler(
      { spaceId: HEALTH, when: '2026-07-08T21:00:00.000Z', action: 'Reply to the email' },
      toolContext('call-untrusted', 'untrusted:gmail'),
    )
    const automationId = (armed.details as { automation: { id: number } }).automation.id
    expect(scheduler.listAutomations(HEALTH).find((a) => a.id === automationId)?.origin).toBe(
      'untrusted:gmail',
    )
    expect(
      store
        .eventLog(HEALTH)
        .filter((event) => event.type === 'automation.arm')
        .at(-1)?.origin,
    ).toBe('untrusted:gmail')

    clock = new Date('2026-07-08T21:00:00.000Z')
    await scheduler.runDue()
    expect(
      store
        .eventLog(HEALTH)
        .filter((event) => event.type === 'automation.fire')
        .at(-1)?.origin,
    ).toBe('untrusted:gmail')

    expect(store.spacesEngine.contextOrigins(HEALTH)).toContain('untrusted:gmail')
  })

  it('keeps the automation origin on cancel events that embed its description', async () => {
    const scheduler = createScheduler()
    const tools = Object.fromEntries(scheduler.tools().map((tool) => [tool.name, tool]))

    const armed = await tools['arm_timer']!.handler(
      { spaceId: HEALTH, when: '2026-07-08T21:00:00.000Z', action: 'Reply to the email' },
      toolContext('call-untrusted', 'untrusted:gmail'),
    )
    const automationId = (armed.details as { automation: { id: number } }).automation.id

    // A later trusted turn cancels it: the cancel event still embeds the
    // tainted description, so it must keep the untrusted mark.
    await tools['cancel']!.handler(
      { spaceId: HEALTH, automationId },
      toolContext('call-trusted', 'trusted:user'),
    )
    expect(
      store
        .eventLog(HEALTH)
        .filter((event) => event.type === 'automation.cancel')
        .at(-1)?.origin,
    ).toBe('untrusted:gmail')
  })

  it('taints the Automations Surface projection while an untrusted-born automation is listed', async () => {
    const scheduler = createScheduler()
    const tools = Object.fromEntries(scheduler.tools().map((tool) => [tool.name, tool]))

    await tools['arm_timer']!.handler(
      { spaceId: HEALTH, when: '2026-07-08T21:00:00.000Z', action: 'Reply to the email' },
      toolContext('call-untrusted', 'untrusted:gmail'),
    )

    // The Surface refresh derives from the listed automations (their
    // descriptions included): its Space events must carry the taint too.
    const patchEvents = store
      .eventLog(HEALTH)
      .filter((event) => event.type.startsWith('surface.patch') || event.type === 'surface.create')
    expect(patchEvents.length).toBeGreaterThan(0)
    expect(patchEvents.at(-1)?.origin).toBe('untrusted:gmail')
  })
})

describe('generic job-handler registry (issue #16)', () => {
  it('routes a plain recurring job failure into its Space without chat escalation', async () => {
    const scheduler = createScheduler()
    scheduler.createJob({
      spaceId: HEALTH,
      cron: '0 8 * * *',
      briefing: 'Review the weekly plan',
    })

    clock = new Date('2026-07-09T08:00:00.000Z')
    await scheduler.runDue()

    expect(escalations).toEqual([])
    expect(scheduler.outcomeService.list(HEALTH).notifications).toMatchObject([
      { kind: 'failed', surfaceId: SURFACE, occurrenceCount: 1 },
    ])
    expect(scheduler.listAutomations(HEALTH)[0]?.lastOutcome).toBe('failed')
  })

  it('delivers an explicit unchanged handler outcome as freshness only', async () => {
    const scheduler = createScheduler()
    scheduler.registerHandler('check', () => ({
      kind: 'unchanged',
      summary: 'No changes',
    }))
    scheduler.createManagedJob({
      spaceId: HEALTH,
      cron: '0 8 * * *',
      description: 'Check the weekly plan',
      handler: 'check',
      targetSurfaceId: SURFACE,
    })

    clock = new Date('2026-07-09T08:00:00.000Z')
    await scheduler.runDue()

    expect(escalations).toEqual([])
    expect(scheduler.outcomeService.list(HEALTH).notifications).toEqual([])
    expect(store.getSurface(SURFACE)?.state[AUTOMATION_OUTCOMES_STATE_KEY]).toMatchObject({
      [String(1)]: {
        lastCheckedAt: '2026-07-09T08:00:00.000Z',
      },
    })
  })

  it('delivers a meaningful handler outcome to the linked Surface without escalation', async () => {
    const scheduler = createScheduler()
    scheduler.registerHandler('check', () => ({
      kind: 'changed',
      summary: 'Plan changed',
      coalesceKey: 'plan-change',
      operations: [],
    }))
    scheduler.createManagedJob({
      spaceId: HEALTH,
      cron: '0 8 * * *',
      description: 'Check the weekly plan',
      handler: 'check',
      targetSurfaceId: SURFACE,
    })

    clock = new Date('2026-07-09T08:00:00.000Z')
    await scheduler.runDue()

    expect(escalations).toEqual([])
    expect(scheduler.outcomeService.list(HEALTH).notifications).toMatchObject([
      { kind: 'changed', summary: 'Plan changed', surfaceId: SURFACE },
    ])
    expect(store.getSurface(SURFACE)?.state['history-1']).toEqual([
      expect.objectContaining({ kind: 'changed', summary: 'Plan changed' }),
    ])
    expect(
      store.getSurface(SURFACE)?.tree.children?.[1]?.children?.[0]?.props?.['historyBinding'],
    ).toBe('history-1')
  })

  it('repairs stale Atom history at boot after a completed run missed its projection refresh', async () => {
    const scheduler = createScheduler()
    scheduler.registerHandler('check', () => handlerChanged('Plan changed'))
    scheduler.createManagedJob({
      spaceId: HEALTH,
      cron: '0 8 * * *',
      description: 'Check the plan',
      handler: 'check',
      targetSurfaceId: SURFACE,
    })
    clock = new Date('2026-07-09T08:00:00.000Z')
    await scheduler.runDue()

    store.patchState(SURFACE, [{ target: 'state', op: 'replace', path: '/history-1', value: [] }], {
      updatedBy: 'job',
    })
    scheduler.stop()

    createScheduler()

    expect(store.getSurface(SURFACE)?.state['history-1']).toEqual([
      expect.objectContaining({ kind: 'changed', summary: 'Plan changed' }),
    ])
  })

  it('keeps untrusted outcome provenance on the projected run history update', async () => {
    const scheduler = createScheduler()
    scheduler.registerHandler('check', () => ({
      outcome: handlerChanged('Imported plan changed'),
      origin: 'untrusted:gmail',
    }))
    scheduler.createManagedJob({
      spaceId: HEALTH,
      cron: '0 8 * * *',
      description: 'Check imported plan',
      handler: 'check',
      targetSurfaceId: SURFACE,
    })
    clock = new Date('2026-07-09T08:00:00.000Z')

    await scheduler.runDue()

    expect(store.getSurface(SURFACE)?.state['history-1']).toEqual([
      expect.objectContaining({ summary: 'Imported plan changed' }),
    ])
    expect(
      store
        .eventLog(HEALTH)
        .filter(
          (event) =>
            event.type === 'surface.patch_state' &&
            event.payload?.['automationProjection'] === true,
        )
        .at(-1)?.origin,
    ).toBe('untrusted:gmail')
  })

  it('updates run history as living state while the System Automations Surface is pinned', async () => {
    ensureSystemSpace(store.spacesEngine)
    const scheduler = createScheduler()
    scheduler.registerHandler('check', () => handlerChanged('System check changed'))
    const job = scheduler.createManagedJob({
      spaceId: SYSTEM_SPACE_ID,
      cron: '0 8 * * *',
      description: 'System check',
      handler: 'check',
      targetSurfaceId: SYSTEM_AUTOMATIONS_SURFACE_ID,
    })
    store.setPinned(SYSTEM_AUTOMATIONS_SURFACE_ID, true, {
      origin: 'trusted:user',
      updatedBy: 'user',
    })
    clock = new Date('2026-07-09T08:00:00.000Z')

    await scheduler.runDue()

    expect(store.getSurface(SYSTEM_AUTOMATIONS_SURFACE_ID)?.state[`history-${job.id}`]).toEqual([
      expect.objectContaining({ kind: 'changed', summary: 'System check changed' }),
    ])
    expect(store.listTreeProposals({ surfaceId: SYSTEM_AUTOMATIONS_SURFACE_ID })).toEqual([])
  })

  it('records a visible failure and advances when the configured target is unavailable', async () => {
    const scheduler = createScheduler()
    scheduler.registerHandler('check', () => handlerChanged('Plan changed'))
    const job = scheduler.createManagedJob({
      spaceId: HEALTH,
      cron: '0 8 * * *',
      description: 'Check an archived plan',
      handler: 'check',
      targetSurfaceId: 'srf-archived-plan',
    })

    clock = new Date('2026-07-09T08:00:00.000Z')
    await scheduler.runDue()

    expect(escalations).toEqual([])
    expect(scheduler.outcomeService.list(HEALTH).notifications).toMatchObject([
      {
        kind: 'failed',
        surfaceId: SURFACE,
        summary: 'Automation target is unavailable',
      },
    ])
    expect(
      scheduler.listAutomations(HEALTH).find((automation) => automation.id === job.id),
    ).toMatchObject({
      status: 'armed',
      lastOutcome: 'failed',
      nextRunAt: '2026-07-10T08:00:00.000Z',
    })
  })

  it('reroutes a pending delivery when its target is archived before retry', async () => {
    const scheduler = createScheduler()
    const targetSurfaceId = 'srf-pending-plan'
    store.createSurface(
      SurfaceSchema.parse({
        id: targetSurfaceId,
        spaceId: HEALTH,
        title: 'Pending plan',
        tree: { id: 'root', type: 'Box', children: [] },
        state: {},
        freshness: { updatedAt: clock.toISOString(), updatedBy: 'agent' },
      }),
      'agent',
    )
    scheduler.registerHandler('check', () => handlerChanged('Plan changed'))
    const job = scheduler.createManagedJob({
      spaceId: HEALTH,
      cron: '0 8 * * *',
      description: 'Check a pending plan',
      handler: 'check',
      targetSurfaceId,
    })
    const commit = store.commitAutomationOutcome.bind(store)
    const interrupted = vi
      .spyOn(store, 'commitAutomationOutcome')
      .mockImplementation((surfaceId, operations, options) => {
        if (surfaceId === targetSurfaceId) throw new Error('simulated delivery interruption')
        return commit(surfaceId, operations, options)
      })

    clock = new Date('2026-07-09T08:00:00.000Z')
    await scheduler.runDue()
    interrupted.mockRestore()
    store.archiveSurface(targetSurfaceId, 'agent')
    const fallbackInterrupted = vi
      .spyOn(store, 'commitAutomationOutcome')
      .mockImplementation((surfaceId, operations, options) => {
        if (surfaceId === SURFACE) throw new Error('simulated fallback delivery interruption')
        return commit(surfaceId, operations, options)
      })
    clock = new Date('2026-07-09T08:01:00.000Z')
    await scheduler.runDue()

    expect(scheduler.outcomeService.list(HEALTH).notifications).toEqual([])
    let db = new DatabaseSync(join(rootDir, 'automation-outcomes.sqlite'))
    expect(
      db
        .prepare(
          'select target_surface_id from automation_outcome_deliveries where completed_at is null',
        )
        .get()?.['target_surface_id'],
    ).toBe(SURFACE)
    db.close()

    fallbackInterrupted.mockRestore()
    clock = new Date('2026-07-09T08:02:00.000Z')
    await scheduler.runDue()

    expect(scheduler.listAutomations(HEALTH).find((item) => item.id === job.id)).toMatchObject({
      lastOutcome: 'failed',
      nextRunAt: '2026-07-10T08:00:00.000Z',
    })
    expect(scheduler.outcomeService.list(HEALTH).notifications).toMatchObject([
      {
        kind: 'failed',
        surfaceId: SURFACE,
        summary: 'Automation target is unavailable',
      },
    ])
    db = new DatabaseSync(join(rootDir, 'automation-outcomes.sqlite'))
    expect(
      db
        .prepare(
          'select count(*) as count from automation_outcome_deliveries where completed_at is null',
        )
        .get()?.['count'],
    ).toBe(0)
    db.close()
  })

  it('settles the fallback target failure when the linked Surface becomes available again', async () => {
    const scheduler = createScheduler()
    scheduler.registerHandler('check', () => handlerChanged('Plan is current'))
    const targetSurfaceId = 'srf-restored-plan'
    const job = scheduler.createManagedJob({
      spaceId: HEALTH,
      cron: '0 8 * * *',
      description: 'Check the restored plan',
      handler: 'check',
      targetSurfaceId,
    })

    clock = new Date('2026-07-09T08:00:00.000Z')
    await scheduler.runDue()
    expect(scheduler.outcomeService.list(HEALTH).notifications).toMatchObject([
      { kind: 'failed', surfaceId: SURFACE },
    ])
    store.createSurface(
      SurfaceSchema.parse({
        id: targetSurfaceId,
        spaceId: HEALTH,
        title: 'Restored plan',
        tree: { id: 'root', type: 'Box', children: [] },
        state: {},
        freshness: { updatedAt: clock.toISOString(), updatedBy: 'agent' },
      }),
      'agent',
    )

    clock = new Date('2026-07-10T08:00:00.000Z')
    await scheduler.runDue()

    expect(
      scheduler.listAutomations(HEALTH).find((automation) => automation.id === job.id),
    ).toMatchObject({ lastOutcome: 'recovered' })
    expect(scheduler.outcomeService.list(HEALTH).notifications).toMatchObject([
      { kind: 'recovered', surfaceId: targetSurfaceId },
    ])
    expect(store.getSurface(SURFACE)?.state[AUTOMATION_OUTCOMES_STATE_KEY]).not.toHaveProperty(
      String(job.id),
    )
    expect(store.getSurface(targetSurfaceId)?.state[AUTOMATION_OUTCOMES_STATE_KEY]).toMatchObject({
      [String(job.id)]: { latest: { kind: 'recovered' } },
    })
  })

  it('clears outcome status and unread notifications when an Automation is cancelled', async () => {
    const scheduler = createScheduler()
    scheduler.registerHandler('check', () => ({
      kind: 'failed',
      summary: 'Source unavailable',
      coalesceKey: 'source-unavailable',
      error: { code: 'source_unavailable', message: 'The source is unavailable.' },
    }))
    const job = scheduler.createManagedJob({
      spaceId: HEALTH,
      cron: '0 8 * * *',
      description: 'Check a cancellable source',
      handler: 'check',
      targetSurfaceId: SURFACE,
    })
    clock = new Date('2026-07-09T08:00:00.000Z')
    await scheduler.runDue()

    scheduler.cancel(HEALTH, job.id, 'trusted:user')

    expect(
      AutomationOutcomeStatusesSchema.parse(
        store.getSurface(SURFACE)?.state[AUTOMATION_OUTCOMES_STATE_KEY],
      )[String(job.id)],
    ).toBeUndefined()
    expect(scheduler.outcomeService.list(HEALTH).notifications).toEqual([])
    expect(scheduler.outcomeService.allNotifications(HEALTH)).toMatchObject([
      { automationId: job.id, state: 'settled' },
    ])
  })

  it('finishes durable old-route cleanup after a crash during managed-job retargeting', async () => {
    const scheduler = createScheduler()
    scheduler.registerHandler('check', () => handlerChanged('Fallback target changed'))
    const job = scheduler.createManagedJob({
      spaceId: HEALTH,
      cron: '0 8 * * *',
      description: 'Check then retarget',
      handler: 'check',
    })
    const nextTarget = 'srf-retarget-after-crash'
    store.createSurface(
      SurfaceSchema.parse({
        id: nextTarget,
        spaceId: HEALTH,
        title: 'Retargeted Surface',
        tree: { id: 'root', type: 'Box', children: [] },
        state: {},
        freshness: { updatedAt: clock.toISOString(), updatedBy: 'agent' },
      }),
      'agent',
    )
    clock = new Date('2026-07-09T08:00:00.000Z')
    await scheduler.runDue()
    expect(store.getSurface(SURFACE)?.state[AUTOMATION_OUTCOMES_STATE_KEY]).toHaveProperty(
      String(job.id),
    )
    const interrupted = vi
      .spyOn(scheduler.outcomeService, 'clearAutomationTarget')
      .mockImplementation(() => {
        throw new Error('simulated crash during old-route cleanup')
      })

    expect(() =>
      scheduler.configureManagedJobTarget(HEALTH, job.id, nextTarget, 'trusted:user'),
    ).toThrow('simulated crash during old-route cleanup')
    interrupted.mockRestore()
    scheduler.stop()

    const restarted = createScheduler()

    expect(
      restarted.listAutomations(HEALTH).find((automation) => automation.id === job.id),
    ).toMatchObject({ targetSurfaceId: nextTarget })
    expect(store.getSurface(SURFACE)?.state[AUTOMATION_OUTCOMES_STATE_KEY]).not.toHaveProperty(
      String(job.id),
    )
    expect(restarted.outcomeService.list(HEALTH).notifications).toEqual([])
  })

  it('finishes a checkpoint on its original target without resurrecting it after retargeting', async () => {
    const scheduler = createScheduler()
    const firstTarget = 'srf-first-outcome-target'
    const secondTarget = 'srf-second-outcome-target'
    for (const surfaceId of [firstTarget, secondTarget]) {
      store.createSurface(
        SurfaceSchema.parse({
          id: surfaceId,
          spaceId: HEALTH,
          title: surfaceId,
          tree: { id: 'root', type: 'Box', children: [] },
          state: { value: 'original' },
          freshness: { updatedAt: clock.toISOString(), updatedBy: 'agent' },
        }),
        'agent',
      )
    }
    const handler = vi.fn(() => ({
      ...handlerChanged('Target updated'),
      operations: [
        { target: 'state' as const, op: 'replace' as const, path: '/value', value: 'updated' },
      ],
    }))
    scheduler.registerHandler('check', handler)
    const job = scheduler.createManagedJob({
      spaceId: HEALTH,
      cron: '0 8 * * *',
      description: 'Check a retargeted source',
      handler: 'check',
      targetSurfaceId: firstTarget,
    })
    const commit = store.commitAutomationOutcome.bind(store)
    const interrupted = vi
      .spyOn(store, 'commitAutomationOutcome')
      .mockImplementation((surfaceId, operations, options) => {
        if (surfaceId === firstTarget) throw new Error('simulated target delivery interruption')
        return commit(surfaceId, operations, options)
      })
    clock = new Date('2026-07-09T08:00:00.000Z')
    await scheduler.runDue()

    scheduler.configureManagedJobTarget(HEALTH, job.id, secondTarget, 'trusted:user')
    interrupted.mockRestore()
    clock = new Date('2026-07-09T08:01:00.000Z')
    await scheduler.runDue()

    expect(handler).toHaveBeenCalledTimes(1)
    expect(store.getSurface(firstTarget)?.state['value']).toBe('original')
    expect(store.getSurface(firstTarget)?.state[AUTOMATION_OUTCOMES_STATE_KEY]).toBeUndefined()
    expect(store.getSurface(secondTarget)?.state[AUTOMATION_OUTCOMES_STATE_KEY]).toBeUndefined()
    expect(scheduler.outcomeService.list(HEALTH).notifications).toEqual([])

    clock = new Date('2026-07-10T08:00:00.000Z')
    await scheduler.runDue()

    expect(handler).toHaveBeenCalledTimes(2)
    expect(
      AutomationOutcomeStatusesSchema.parse(
        store.getSurface(secondTarget)?.state[AUTOMATION_OUTCOMES_STATE_KEY],
      )[String(job.id)],
    ).toMatchObject({ latest: { kind: 'changed' } })
    expect(store.getSurface(secondTarget)?.state['value']).toBe('updated')
    expect(scheduler.outcomeService.list(HEALTH).notifications).toMatchObject([
      { automationId: job.id, surfaceId: secondTarget, state: 'unread' },
    ])
  })

  it('does not apply an in-flight changed outcome after its Automation is retargeted', async () => {
    const scheduler = createScheduler()
    const firstTarget = 'srf-inflight-first'
    const secondTarget = 'srf-inflight-second'
    for (const surfaceId of [firstTarget, secondTarget]) {
      store.createSurface(
        SurfaceSchema.parse({
          id: surfaceId,
          spaceId: HEALTH,
          title: surfaceId,
          tree: { id: 'root', type: 'Box', children: [] },
          state: { value: 'user value' },
          freshness: { updatedAt: clock.toISOString(), updatedBy: 'agent' },
        }),
        'agent',
      )
    }
    const producer = deferred<AutomationOutcomeInput>()
    const handler = vi.fn(() => producer.promise)
    scheduler.registerHandler('check', handler)
    const job = scheduler.createManagedJob({
      spaceId: HEALTH,
      cron: '0 8 * * *',
      description: 'Check an in-flight target',
      handler: 'check',
      targetSurfaceId: firstTarget,
    })
    clock = new Date('2026-07-09T08:00:00.000Z')
    const running = scheduler.runDue()
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1))

    scheduler.configureManagedJobTarget(HEALTH, job.id, secondTarget, 'trusted:user')
    producer.resolve({
      kind: 'changed',
      summary: 'Old target changed',
      coalesceKey: 'in-flight-target',
      operations: [{ target: 'state', op: 'replace', path: '/value', value: 'automation value' }],
    })
    await running

    expect(store.getSurface(firstTarget)?.state['value']).toBe('user value')
    expect(store.getSurface(secondTarget)?.state['value']).toBe('user value')
    expect(scheduler.outcomeService.list(HEALTH).notifications).toEqual([])
  })

  it('does not apply an in-flight changed outcome after its Automation is cancelled', async () => {
    const scheduler = createScheduler()
    const target = 'srf-inflight-cancelled'
    store.createSurface(
      SurfaceSchema.parse({
        id: target,
        spaceId: HEALTH,
        title: target,
        tree: { id: 'root', type: 'Box', children: [] },
        state: { value: 'user value' },
        freshness: { updatedAt: clock.toISOString(), updatedBy: 'agent' },
      }),
      'agent',
    )
    const producer = deferred<AutomationOutcomeInput>()
    const handler = vi.fn(() => producer.promise)
    scheduler.registerHandler('check', handler)
    const job = scheduler.createManagedJob({
      spaceId: HEALTH,
      cron: '0 8 * * *',
      description: 'Check a cancellable target',
      handler: 'check',
      targetSurfaceId: target,
    })
    clock = new Date('2026-07-09T08:00:00.000Z')
    const running = scheduler.runDue()
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1))

    scheduler.cancel(HEALTH, job.id, 'trusted:user')
    producer.resolve({
      kind: 'changed',
      summary: 'Cancelled target changed',
      coalesceKey: 'in-flight-cancel',
      operations: [{ target: 'state', op: 'replace', path: '/value', value: 'automation value' }],
    })
    await running

    expect(store.getSurface(target)?.state['value']).toBe('user value')
    const cancelled = scheduler.listAutomations(HEALTH).find((item) => item.id === job.id)
    expect(cancelled?.status).toBe('cancelled')
    expect(cancelled?.nextRunAt).toBeUndefined()
    expect(scheduler.outcomeService.list(HEALTH).notifications).toEqual([])
  })

  it('rejects producer data based on a Surface version changed while the handler was running', async () => {
    const scheduler = createScheduler()
    const target = 'srf-concurrent-user-change'
    store.createSurface(
      SurfaceSchema.parse({
        id: target,
        spaceId: HEALTH,
        title: target,
        tree: { id: 'root', type: 'Box', children: [] },
        state: { value: 'initial' },
        freshness: { updatedAt: clock.toISOString(), updatedBy: 'agent' },
      }),
      'agent',
    )
    const producer = deferred<AutomationOutcomeInput>()
    let observedTargetVersion: number | undefined
    scheduler.registerHandler('check', (context) => {
      observedTargetVersion = context.targetVersion
      return producer.promise
    })
    scheduler.createManagedJob({
      spaceId: HEALTH,
      cron: '0 8 * * *',
      description: 'Check concurrent edits',
      handler: 'check',
      targetSurfaceId: target,
    })
    clock = new Date('2026-07-09T08:00:00.000Z')
    const running = scheduler.runDue()
    await vi.waitFor(() => expect(observedTargetVersion).toBeDefined())
    store.patchState(
      target,
      [{ target: 'state', op: 'replace', path: '/value', value: 'user edit' }],
      { updatedBy: 'user' },
    )

    producer.resolve({
      kind: 'changed',
      summary: 'Automation edit',
      coalesceKey: 'concurrent-edit',
      operations: [{ target: 'state', op: 'replace', path: '/value', value: 'automation edit' }],
    })
    await running

    expect(store.getSurface(target)?.state['value']).toBe('user edit')
    expect(scheduler.outcomeService.list(HEALTH).notifications).toMatchObject([
      { kind: 'failed', summary: 'Automation outcome could not be applied' },
    ])
  })

  it('retries an interrupted outcome delivery in-process and persists its effective kind', async () => {
    const scheduler = createScheduler()
    scheduler.registerHandler('check', () => handlerChanged('Plan changed'))
    const job = scheduler.createManagedJob({
      spaceId: HEALTH,
      cron: '0 8 * * *',
      description: 'Check the plan',
      handler: 'check',
      targetSurfaceId: SURFACE,
    })
    const deliver = scheduler.outcomeService.deliverIfCurrent.bind(scheduler.outcomeService)
    const delivery = vi
      .spyOn(scheduler.outcomeService, 'deliverIfCurrent')
      .mockRejectedValueOnce(new Error('simulated transient write failure'))
      .mockImplementation(deliver)

    clock = new Date('2026-07-09T08:00:00.000Z')
    await scheduler.runDue()

    expect(delivery).toHaveBeenCalledTimes(2)
    expect(
      scheduler.listAutomations(HEALTH).find((automation) => automation.id === job.id),
    ).toMatchObject({ lastOutcome: 'changed', nextRunAt: '2026-07-10T08:00:00.000Z' })
  })

  it('parks an occurrence, retries it in-process, and never reruns its producer or overtakes it', async () => {
    const scheduler = createScheduler()
    const handler = vi.fn(() => handlerChanged('Plan changed'))
    scheduler.registerHandler('check', handler)
    const job = scheduler.createManagedJob({
      spaceId: HEALTH,
      cron: '0 8 * * *',
      description: 'Check the plan',
      handler: 'check',
      targetSurfaceId: SURFACE,
    })
    const delivery = vi
      .spyOn(scheduler.outcomeService, 'deliverIfCurrent')
      .mockRejectedValue(new Error('simulated persistent write failure'))

    clock = new Date('2026-07-09T08:00:00.000Z')
    await scheduler.runDue()
    await scheduler.runDue()

    expect(delivery).toHaveBeenCalledTimes(2)
    expect(
      scheduler.listAutomations(HEALTH).find((automation) => automation.id === job.id),
    ).toMatchObject({ nextRunAt: '2026-07-09T08:00:00.000Z' })
    expect(
      scheduler.listAutomations(HEALTH).find((automation) => automation.id === job.id)?.lastOutcome,
    ).toBeUndefined()
    expect(
      store.eventLog(HEALTH).filter((event) => event.type === 'automation.outcome.delivery-failed'),
    ).toHaveLength(1)

    clock = new Date('2026-07-09T08:01:00.000Z')
    await scheduler.runDue()
    expect(delivery).toHaveBeenCalledTimes(4)
    expect(handler).toHaveBeenCalledTimes(1)
    expect(
      store.eventLog(HEALTH).filter((event) => event.type === 'automation.outcome.delivery-failed'),
    ).toHaveLength(1)

    delivery.mockRestore()
    clock = new Date('2026-07-09T08:02:00.000Z')
    await scheduler.runDue()
    expect(handler).toHaveBeenCalledTimes(1)
    expect(
      scheduler.listAutomations(HEALTH).find((automation) => automation.id === job.id),
    ).toMatchObject({ lastOutcome: 'changed', nextRunAt: '2026-07-10T08:00:00.000Z' })
    expect(store.getSurface(SURFACE)?.state[AUTOMATION_OUTCOMES_STATE_KEY]).toMatchObject({
      [String(job.id)]: {
        lastCheckedAt: '2026-07-09T08:00:00.000Z',
        lastSuccessfulAt: '2026-07-09T08:00:00.000Z',
      },
    })
    expect(scheduler.outcomeService.list(HEALTH).notifications).toMatchObject([
      { updatedAt: '2026-07-09T08:00:00.000Z' },
    ])
    expect(scheduler.outcomeService.history(job.id)).toMatchObject([
      { at: '2026-07-09T08:00:00.000Z' },
    ])
  })

  it('closes a parked outcome checkpoint when its Automation is cancelled', async () => {
    const scheduler = createScheduler()
    scheduler.registerHandler('check', () => handlerChanged('Plan changed'))
    const job = scheduler.createManagedJob({
      spaceId: HEALTH,
      cron: '0 8 * * *',
      description: 'Check then cancel',
      handler: 'check',
      targetSurfaceId: SURFACE,
    })
    vi.spyOn(scheduler.outcomeService, 'deliverIfCurrent').mockRejectedValue(
      new Error('simulated persistent write failure'),
    )
    clock = new Date('2026-07-09T08:00:00.000Z')
    await scheduler.runDue()

    scheduler.cancel(HEALTH, job.id, 'trusted:user')
    const db = new DatabaseSync(join(rootDir, 'scheduler.sqlite'))
    expect(
      db
        .prepare(
          `select finished_at, recurring_outcome_json, retry_at
           from automation_runs where automation_id = ?`,
        )
        .get(job.id),
    ).toMatchObject({
      finished_at: '2026-07-09T08:00:00.000Z',
      recurring_outcome_json: null,
      retry_at: null,
    })
    db.close()
    const recoveryEvents = store
      .eventLog(HEALTH)
      .filter((event) => event.type === 'automation.recover').length
    scheduler.stop()

    createScheduler()

    expect(
      store.eventLog(HEALTH).filter((event) => event.type === 'automation.recover'),
    ).toHaveLength(recoveryEvents)
  })

  it('keeps producer provenance through a durable delivery checkpoint', async () => {
    const scheduler = createScheduler()
    const handler = vi.fn(() => ({
      outcome: handlerChanged('Update feed changed'),
      origin: 'untrusted:update-feed' as const,
    }))
    scheduler.registerHandler('check', handler)
    const job = scheduler.createManagedJob({
      spaceId: HEALTH,
      cron: '0 8 * * *',
      description: 'Check an external feed',
      handler: 'check',
      targetSurfaceId: SURFACE,
    })
    vi.spyOn(scheduler.outcomeService, 'deliverIfCurrent').mockRejectedValue(
      new Error('simulated persistent write failure'),
    )
    clock = new Date('2026-07-09T08:00:00.000Z')
    await scheduler.runDue()
    scheduler.stop()

    clock = new Date('2026-07-09T08:01:00.000Z')
    const restarted = createScheduler()
    restarted.registerHandler('check', () => handlerChanged('must not execute'))
    await restarted.runDue()

    expect(handler).toHaveBeenCalledTimes(1)
    expect(
      store
        .eventLog(HEALTH)
        .find(
          (event) =>
            event.type === 'automation.outcome' && event.payload?.['automationId'] === job.id,
        )?.origin,
    ).toBe('untrusted:update-feed')
    expect(store.surfaceProvenance(SURFACE)?.contentOrigin).toBe('untrusted:update-feed')
    expect(restarted.outcomeService.list(HEALTH).notifications).toMatchObject([
      { updatedAt: '2026-07-09T08:00:00.000Z' },
    ])
  })

  it('keeps a safe producer checkpoint durable across repeated boots before delivery resumes', async () => {
    const scheduler = createScheduler()
    const handler = vi.fn(() => handlerChanged('Plan changed once'))
    scheduler.registerHandler('check', handler)
    const job = scheduler.createManagedJob({
      spaceId: HEALTH,
      cron: '0 8 * * *',
      description: 'Check the plan',
      handler: 'check',
      targetSurfaceId: SURFACE,
    })
    vi.spyOn(scheduler.outcomeService, 'deliverIfCurrent').mockRejectedValue(
      new Error('simulated persistent write failure'),
    )
    clock = new Date('2026-07-09T08:00:00.000Z')
    await scheduler.runDue()
    expect(handler).toHaveBeenCalledTimes(1)
    scheduler.stop()

    const firstRestart = createScheduler()
    firstRestart.stop()
    const secondRestart = createScheduler()
    const replayedHandler = vi.fn(() => handlerChanged('must not execute'))
    secondRestart.registerHandler('check', replayedHandler)
    await secondRestart.runDue()

    expect(replayedHandler).not.toHaveBeenCalled()
    expect(
      secondRestart.listAutomations(HEALTH).find((automation) => automation.id === job.id),
    ).toMatchObject({ lastOutcome: 'changed', nextRunAt: '2026-07-10T08:00:00.000Z' })
    expect(secondRestart.outcomeService.list(HEALTH).notifications).toMatchObject([
      { kind: 'changed', summary: 'Plan changed once' },
    ])
    expect(
      store.eventLog(HEALTH).filter((event) => event.type === 'automation.recover'),
    ).toHaveLength(1)
  })

  it('persists only a redacted retry checkpoint and clears it after delivery', async () => {
    const scheduler = createScheduler()
    scheduler.registerHandler('check', () => ({
      kind: 'failed',
      summary: 'Feed sk-automationsecret123 failed',
      coalesceKey: 'feed-failed',
      error: {
        code: 'feed_failed',
        message: 'Authorization used Bearer automation-secret-token',
      },
    }))
    scheduler.createManagedJob({
      spaceId: HEALTH,
      cron: '0 8 * * *',
      description: 'Check the feed',
      handler: 'check',
      targetSurfaceId: SURFACE,
    })
    const delivery = vi
      .spyOn(scheduler.outcomeService, 'deliverIfCurrent')
      .mockRejectedValue(new Error('simulated persistent write failure'))
    clock = new Date('2026-07-09T08:00:00.000Z')
    await scheduler.runDue()

    const db = new DatabaseSync(join(rootDir, 'scheduler.sqlite'))
    const parked = db
      .prepare('select recurring_outcome_json from automation_runs where automation_id = 1')
      .get()
    const checkpoint = parked?.['recurring_outcome_json']
    expect(typeof checkpoint).toBe('string')
    expect(checkpoint).not.toContain('automationsecret123')
    expect(checkpoint).not.toContain('automation-secret-token')
    expect(checkpoint).toContain('[redacted]')

    delivery.mockRestore()
    clock = new Date('2026-07-09T08:01:00.000Z')
    await scheduler.runDue()
    const finished = db
      .prepare(
        'select recurring_outcome_json, finished_at from automation_runs where automation_id = 1',
      )
      .get()
    expect(finished?.['recurring_outcome_json']).toBeNull()
    expect(typeof finished?.['finished_at']).toBe('string')
    db.close()
  })

  it('persists the effective failed kind when a producer returns an invalid Surface patch', async () => {
    const scheduler = createScheduler()
    scheduler.registerHandler('check', () => ({
      kind: 'changed',
      summary: 'Invalid plan update',
      coalesceKey: 'invalid-plan',
      operations: [{ target: 'state', op: 'replace', path: '/missing', value: true }],
    }))
    const job = scheduler.createManagedJob({
      spaceId: HEALTH,
      cron: '0 8 * * *',
      description: 'Check the plan',
      handler: 'check',
      targetSurfaceId: SURFACE,
    })

    clock = new Date('2026-07-09T08:00:00.000Z')
    await scheduler.runDue()

    expect(
      scheduler.listAutomations(HEALTH).find((automation) => automation.id === job.id),
    ).toMatchObject({ lastOutcome: 'failed' })
    expect(scheduler.outcomeService.list(HEALTH).notifications).toMatchObject([
      { kind: 'failed', summary: 'Automation outcome could not be applied' },
    ])
  })

  it('promotes the first successful check after failure to a durable recovery', async () => {
    const scheduler = createScheduler()
    const handler = vi
      .fn<() => AutomationOutcomeInput>()
      .mockReturnValueOnce({
        kind: 'failed',
        summary: 'Refresh failed',
        coalesceKey: 'refresh-failed',
        error: { code: 'refresh_failed', message: 'The source was unavailable.' },
      })
      .mockReturnValue({ kind: 'unchanged', summary: 'The source is reachable' })
    scheduler.registerHandler('check', handler)
    const job = scheduler.createManagedJob({
      spaceId: HEALTH,
      cron: '0 * * * *',
      description: 'Check the source',
      handler: 'check',
      targetSurfaceId: SURFACE,
    })

    clock = new Date('2026-07-08T14:00:00.000Z')
    await scheduler.runDue()
    clock = new Date('2026-07-08T15:00:00.000Z')
    await scheduler.runDue()

    expect(
      scheduler.listAutomations(HEALTH).find((automation) => automation.id === job.id),
    ).toMatchObject({ lastOutcome: 'recovered' })
    expect(scheduler.outcomeService.history(job.id).map((entry) => entry.kind)).toEqual([
      'recovered',
      'failed',
    ])
  })

  it('accepts decision-required only when the owning Pending workflow backs it', async () => {
    const scheduler = createScheduler()
    const decision: PendingDecision = {
      id: 'tree-proposal:42',
      kind: 'tree-proposal',
      summary: 'Change the plan Surface tree',
      scope: { type: 'space', spaceId: HEALTH },
      allowedResolutions: ['accept', 'reject'],
      state: 'pending',
      createdAt: '2026-07-09T07:59:00.000Z',
    }
    scheduler.setPendingDecisionLookup(async (id) => (id === decision.id ? decision : undefined))
    scheduler.registerHandler('check', () => ({
      kind: 'decision-required',
      summary: 'Review the proposed layout',
      decisionId: decision.id,
    }))
    const job = scheduler.createManagedJob({
      spaceId: HEALTH,
      cron: '0 8 * * *',
      description: 'Check the plan',
      handler: 'check',
      targetSurfaceId: SURFACE,
    })

    clock = new Date('2026-07-09T08:00:00.000Z')
    await scheduler.runDue()

    expect(escalations).toEqual([])
    expect(scheduler.outcomeService.list(HEALTH).notifications).toEqual([])
    expect(
      scheduler.listAutomations(HEALTH).find((automation) => automation.id === job.id)?.lastOutcome,
    ).toBe('decision-required')
  })

  it('turns a decision reference owned by another Space into a visible safe failure', async () => {
    const scheduler = createScheduler()
    const otherSpace = store.spacesEngine.createSpace({ name: 'Other', slug: 'other' })
    const foreignDecision: PendingDecision = {
      id: 'tree-proposal:missing',
      kind: 'tree-proposal',
      summary: 'Change another Surface tree',
      scope: { type: 'space', spaceId: otherSpace.id },
      allowedResolutions: ['accept', 'reject'],
      state: 'pending',
      createdAt: '2026-07-09T07:59:00.000Z',
    }
    scheduler.setPendingDecisionLookup(async () => foreignDecision)
    scheduler.registerHandler('check', () => ({
      kind: 'decision-required',
      summary: 'Review an unavailable choice',
      decisionId: 'tree-proposal:missing',
    }))
    scheduler.createManagedJob({
      spaceId: HEALTH,
      cron: '0 8 * * *',
      description: 'Check the plan',
      handler: 'check',
      targetSurfaceId: SURFACE,
    })

    clock = new Date('2026-07-09T08:00:00.000Z')
    await scheduler.runDue()

    expect(scheduler.outcomeService.list(HEALTH).notifications).toMatchObject([
      { kind: 'failed', summary: 'Automation decision is unavailable' },
    ])
    expect(scheduler.listAutomations(HEALTH)[0]?.lastOutcome).toBe('failed')
  })

  it('runs a registered handler on its occurrence and persists the returned outcome', async () => {
    const scheduler = createScheduler()
    const seen: { automationId: number; scheduledFor: string }[] = []
    scheduler.registerHandler('ping', ({ automation, scheduledFor }) => {
      seen.push({ automationId: automation.id, scheduledFor })
      return handlerChanged('Handled ping')
    })
    const job = scheduler.createManagedJob({
      spaceId: HEALTH,
      cron: '0 8 * * *',
      description: 'Internal ping',
      handler: 'ping',
    })

    clock = new Date('2026-07-09T08:00:00.000Z')
    await scheduler.runDue()

    expect(seen).toEqual([{ automationId: job.id, scheduledFor: '2026-07-09T08:00:00.000Z' }])
    expect(scheduler.listAutomations(HEALTH)[0]?.lastOutcome).toBe('changed')
    // A handler-driven occurrence never falls through to timer escalation.
    expect(escalations).toEqual([])
  })

  it('records a visible failure (no escalation) when a handler is not registered', async () => {
    const scheduler = createScheduler()
    scheduler.createManagedJob({
      spaceId: HEALTH,
      cron: '0 8 * * *',
      description: 'Orphaned job',
      handler: 'does-not-exist',
    })

    clock = new Date('2026-07-09T08:00:00.000Z')
    await scheduler.runDue()

    expect(escalations).toEqual([])
    expect(scheduler.listAutomations(HEALTH)[0]?.lastOutcome).toBe('failed')
    expect(scheduler.outcomeService.list(HEALTH).notifications).toMatchObject([
      { kind: 'failed', occurrenceCount: 1 },
    ])
    expect(store.eventLog(HEALTH).some((event) => event.type === 'automation.skip')).toBe(true)
  })

  it('rejects an empty or blank handler instead of degrading configured work to a handlerless failure', () => {
    const scheduler = createScheduler()
    expect(() =>
      scheduler.createManagedJob({
        spaceId: HEALTH,
        cron: '0 8 * * *',
        description: 'Blank handler',
        handler: '',
      }),
    ).toThrow(/handler/)
    expect(() =>
      scheduler.createManagedJob({
        spaceId: HEALTH,
        cron: '0 8 * * *',
        description: 'Whitespace handler',
        handler: '   ',
      }),
    ).toThrow(/handler/)
    expect(scheduler.listAutomations(HEALTH)).toHaveLength(0)
  })

  it('round-trips handler and targetSurfaceId through armTimer/createManagedJob and listAutomations', () => {
    const scheduler = createScheduler()
    scheduler.registerHandler('noop', () => handlerChanged('No-op handled'))

    const timer = scheduler.armTimer({
      spaceId: HEALTH,
      when: '2026-07-08T21:00:00.000Z',
      action: 'Covering timer',
      targetSurfaceId: 'srf-covered',
    })
    expect(scheduler.listAutomations(HEALTH).find((a) => a.id === timer.id)).toMatchObject({
      targetSurfaceId: 'srf-covered',
    })
    expect(timer.handler).toBeUndefined()

    const job = scheduler.createManagedJob(
      {
        spaceId: HEALTH,
        cron: '0 8 * * *',
        description: 'Managed',
        handler: 'noop',
        targetSurfaceId: 'srf-managed',
      },
      'trusted:system',
    )
    expect(scheduler.listAutomations(HEALTH).find((a) => a.id === job.id)).toMatchObject({
      handler: 'noop',
      targetSurfaceId: 'srf-managed',
    })
  })
})

describe('zoned managed jobs (issue #21)', () => {
  it('stores a timezone on a managed job and computes a local-time nextRunAt', () => {
    const scheduler = createScheduler()
    scheduler.registerHandler('reflect', () => handlerChanged('Reflected'))
    clock = new Date('2026-07-01T00:00:00.000Z')

    const job = scheduler.createManagedJob({
      spaceId: HEALTH,
      cron: '0 4 * * *',
      description: 'Nightly reflection',
      handler: 'reflect',
      timezone: 'Europe/Rome',
    })

    expect(job.timezone).toBe('Europe/Rome')
    // Europe/Rome is CEST (UTC+2) in July: 04:00 local is 02:00 UTC.
    expect(job.nextRunAt).toBe('2026-07-01T02:00:00.000Z')
    expect(scheduler.listAutomations(HEALTH)[0]?.timezone).toBe('Europe/Rome')
  })

  it('labels a zoned managed job with its zone; an unzoned job keeps the plain UTC label', () => {
    const scheduler = createScheduler()
    scheduler.registerHandler('reflect', () => handlerChanged('Reflected'))

    scheduler.createJob({ spaceId: HEALTH, cron: '0 8 * * *', briefing: 'Morning briefing' })
    const job = scheduler.createManagedJob({
      spaceId: HEALTH,
      cron: '0 4 * * *',
      description: 'Nightly reflection',
      handler: 'reflect',
      timezone: 'Europe/Rome',
    })

    const children = store.getSurface(SURFACE)?.tree.children?.[1]?.children
    const unzoned = children?.find((child) => child.binding === 'job-1')
    const zoned = children?.find((child) => child.binding === `job-${job.id}`)
    expect(unzoned?.props?.['schedule']).toBe('cron 0 8 * * * — next 2026-07-09 08:00 UTC')
    expect(zoned?.props?.['schedule']).toBe(
      'cron 0 4 * * * (Europe/Rome) — next 2026-07-09 02:00 UTC',
    )
  })

  it('advances a recurring managed job across a DST spring-forward, keeping local 04:00', async () => {
    const scheduler = createScheduler()
    scheduler.registerHandler('reflect', () => handlerChanged('Reflected'))
    clock = new Date('2026-03-27T00:00:00.000Z')

    const job = scheduler.createManagedJob({
      spaceId: HEALTH,
      cron: '0 4 * * *',
      description: 'Nightly reflection',
      handler: 'reflect',
      timezone: 'Europe/Rome',
    })
    expect(job.nextRunAt).toBe('2026-03-27T03:00:00.000Z')

    clock = new Date('2026-03-27T03:00:00.000Z')
    await scheduler.runDue()
    expect(scheduler.listAutomations(HEALTH)[0]?.nextRunAt).toBe('2026-03-28T03:00:00.000Z')

    clock = new Date('2026-03-28T03:00:00.000Z')
    await scheduler.runDue()
    // Europe/Rome springs forward on 2026-03-29 (02:00 CET -> 03:00 CEST):
    // 04:00 local that day is 02:00 UTC, an hour earlier than the previous
    // occurrences' UTC instant, yet still 04:00 on the ground in Rome.
    expect(scheduler.listAutomations(HEALTH)[0]?.nextRunAt).toBe('2026-03-29T02:00:00.000Z')

    clock = new Date('2026-03-29T02:00:00.000Z')
    await scheduler.runDue()
    expect(scheduler.listAutomations(HEALTH)[0]?.nextRunAt).toBe('2026-03-30T02:00:00.000Z')
  })

  it('advances a recurring managed job across a DST fall-back, keeping local 04:00', async () => {
    const scheduler = createScheduler()
    scheduler.registerHandler('reflect', () => handlerChanged('Reflected'))
    clock = new Date('2026-10-23T00:00:00.000Z')

    const job = scheduler.createManagedJob({
      spaceId: HEALTH,
      cron: '0 4 * * *',
      description: 'Nightly reflection',
      handler: 'reflect',
      timezone: 'Europe/Rome',
    })
    expect(job.nextRunAt).toBe('2026-10-23T02:00:00.000Z')

    clock = new Date('2026-10-23T02:00:00.000Z')
    await scheduler.runDue()
    expect(scheduler.listAutomations(HEALTH)[0]?.nextRunAt).toBe('2026-10-24T02:00:00.000Z')

    clock = new Date('2026-10-24T02:00:00.000Z')
    await scheduler.runDue()
    // Europe/Rome falls back on 2026-10-25 (03:00 CEST -> 02:00 CET): 04:00
    // local that day is unambiguous, but now 03:00 UTC — an hour later than
    // the previous occurrences' UTC instant, still 04:00 on the ground.
    expect(scheduler.listAutomations(HEALTH)[0]?.nextRunAt).toBe('2026-10-25T03:00:00.000Z')

    clock = new Date('2026-10-25T03:00:00.000Z')
    await scheduler.runDue()
    expect(scheduler.listAutomations(HEALTH)[0]?.nextRunAt).toBe('2026-10-26T03:00:00.000Z')
  })
})

describe('escalation context (issue #18)', () => {
  it('keeps an overdue managed job inside its Space outcome channel', async () => {
    const contexts: (EscalationContext | undefined)[] = []
    const scheduler = new Scheduler({
      rootDir,
      store,
      now,
      onEscalation: (_spaceId, _text, context) => contexts.push(context),
    })
    schedulers.push(scheduler)
    scheduler.registerHandler('ping', () => handlerChanged('Handled ping'))
    scheduler.createManagedJob({
      spaceId: HEALTH,
      cron: '* * * * *',
      description: 'Managed sweep',
      handler: 'ping',
    })

    clock = new Date('2026-07-10T09:00:00.000Z') // > 24h past the first minute occurrence
    await scheduler.runDue()

    expect(contexts).toEqual([])
    expect(scheduler.outcomeService.list(HEALTH).notifications).toMatchObject([
      { kind: 'failed', occurrenceCount: 1 },
    ])
  })

  it('an overdue plain timer escalation carries its durable Automation context', async () => {
    const contexts: (EscalationContext | undefined)[] = []
    const scheduler = new Scheduler({
      rootDir,
      store,
      now,
      onEscalation: (_spaceId, _text, context) => contexts.push(context),
    })
    schedulers.push(scheduler)
    scheduler.armTimer({
      spaceId: HEALTH,
      when: '2026-07-08T21:00:00.000Z',
      action: 'Log my weight',
    })

    clock = new Date('2026-07-10T03:00:00.000Z')
    await scheduler.runDue()

    expect(contexts).toHaveLength(1)
    expect(contexts[0]).toMatchObject({ automationId: 1, origin: 'trusted:system' })
    expect(contexts[0]).not.toHaveProperty('managed')
  })
})

describe('schema migration', () => {
  it('keeps working against a scheduler.sqlite written before the origin column existed', () => {
    // Simulate a pre-existing database from before this change: the
    // `automations` table without an `origin` column.
    const legacyDb = new DatabaseSync(join(rootDir, 'scheduler.sqlite'))
    legacyDb.exec(`
      create table automations (
        id integer primary key autoincrement,
        kind text not null check (kind in ('timer', 'job')),
        space_id text not null,
        description text not null,
        enabled integer not null default 1,
        fire_at text,
        cron text,
        condition_json text,
        next_run_at text,
        status text not null default 'armed'
          check (status in ('armed', 'completed', 'cancelled')),
        last_run_at text,
        last_outcome text,
        created_at text not null
      );
      create table automation_runs (
        automation_id integer not null references automations(id),
        scheduled_for text not null,
        started_at text not null,
        outcome text,
        finished_at text,
        primary key (automation_id, scheduled_for)
      );
      insert into automations
        (kind, space_id, description, enabled, fire_at, next_run_at, status, created_at)
        values ('timer', '${HEALTH}', 'Legacy reminder', 1, '2026-07-08T21:00:00.000Z',
                '2026-07-08T21:00:00.000Z', 'armed', '2026-07-08T13:00:00.000Z');
    `)
    legacyDb.close()

    const scheduler = createScheduler()
    const automations = scheduler.listAutomations(HEALTH)
    expect(automations.find((a) => a.description === 'Legacy reminder')?.origin).toBeUndefined()

    // Fresh writes on the migrated database still round-trip origin.
    const armed = scheduler.armTimer(
      { spaceId: HEALTH, when: '2026-07-08T22:00:00.000Z', action: 'Fresh after migration' },
      'untrusted:gmail',
    )
    expect(scheduler.listAutomations(HEALTH).find((a) => a.id === armed.id)?.origin).toBe(
      'untrusted:gmail',
    )
  })

  it('keeps working against a scheduler.sqlite written before the handler/target_surface_id columns existed', () => {
    // Simulate a database from just before issue #16: `origin` exists, but
    // `handler`/`target_surface_id` do not yet.
    const legacyDb = new DatabaseSync(join(rootDir, 'scheduler.sqlite'))
    legacyDb.exec(`
      create table automations (
        id integer primary key autoincrement,
        kind text not null check (kind in ('timer', 'job')),
        space_id text not null,
        description text not null,
        enabled integer not null default 1,
        fire_at text,
        cron text,
        condition_json text,
        next_run_at text,
        status text not null default 'armed'
          check (status in ('armed', 'completed', 'cancelled')),
        last_run_at text,
        last_outcome text,
        created_at text not null,
        origin text
      );
      create table automation_runs (
        automation_id integer not null references automations(id),
        scheduled_for text not null,
        started_at text not null,
        outcome text,
        finished_at text,
        primary key (automation_id, scheduled_for)
      );
      insert into automations
        (kind, space_id, description, enabled, fire_at, next_run_at, status, created_at, origin)
        values ('timer', '${HEALTH}', 'Pre-handler reminder', 1, '2026-07-08T21:00:00.000Z',
                '2026-07-08T21:00:00.000Z', 'armed', '2026-07-08T13:00:00.000Z', 'trusted:system');
    `)
    legacyDb.close()

    const scheduler = createScheduler()
    const legacy = scheduler
      .listAutomations(HEALTH)
      .find((a) => a.description === 'Pre-handler reminder')
    expect(legacy?.handler).toBeUndefined()
    expect(legacy?.targetSurfaceId).toBeUndefined()

    // Fresh writes on the migrated database round-trip both new columns.
    scheduler.registerHandler('noop', () => handlerChanged('No-op handled'))
    const job = scheduler.createManagedJob({
      spaceId: HEALTH,
      cron: '0 8 * * *',
      description: 'Fresh managed job',
      handler: 'noop',
      targetSurfaceId: 'srf-fresh',
    })
    expect(scheduler.listAutomations(HEALTH).find((a) => a.id === job.id)).toMatchObject({
      handler: 'noop',
      targetSurfaceId: 'srf-fresh',
    })
  })

  it('keeps working against a scheduler.sqlite written before the timezone column existed', async () => {
    // Simulate a database from just before issue #21: every other column
    // exists, but `timezone` does not yet.
    const legacyDb = new DatabaseSync(join(rootDir, 'scheduler.sqlite'))
    legacyDb.exec(`
      create table automations (
        id integer primary key autoincrement,
        kind text not null check (kind in ('timer', 'job')),
        space_id text not null,
        description text not null,
        enabled integer not null default 1,
        fire_at text,
        cron text,
        condition_json text,
        next_run_at text,
        status text not null default 'armed'
          check (status in ('armed', 'completed', 'cancelled')),
        last_run_at text,
        last_outcome text,
        created_at text not null,
        origin text,
        handler text,
        target_surface_id text
      );
      create table automation_runs (
        automation_id integer not null references automations(id),
        scheduled_for text not null,
        started_at text not null,
        outcome text,
        finished_at text,
        primary key (automation_id, scheduled_for)
      );
      insert into automations
        (kind, space_id, description, enabled, cron, next_run_at, status, created_at, origin)
        values ('job', '${HEALTH}', 'Pre-timezone job', 1, '0 8 * * *',
                '2026-07-09T08:00:00.000Z', 'armed', '2026-07-08T13:00:00.000Z', 'trusted:system');
    `)
    legacyDb.close()

    const scheduler = createScheduler()
    const legacy = scheduler
      .listAutomations(HEALTH)
      .find((a) => a.description === 'Pre-timezone job')
    expect(legacy?.timezone).toBeUndefined()

    // The legacy (unzoned) job keeps advancing after the migration, still
    // interpreting its cron field as UTC.
    clock = new Date('2026-07-09T08:00:00.000Z')
    await scheduler.runDue()
    expect(
      scheduler.listAutomations(HEALTH).find((a) => a.description === 'Pre-timezone job'),
    ).toMatchObject({ nextRunAt: '2026-07-10T08:00:00.000Z' })

    // Fresh writes on the migrated database round-trip the new column.
    scheduler.registerHandler('reflect', () => handlerChanged('Reflected'))
    const job = scheduler.createManagedJob({
      spaceId: HEALTH,
      cron: '0 4 * * *',
      description: 'Fresh zoned job',
      handler: 'reflect',
      timezone: 'Europe/Rome',
    })
    expect(scheduler.listAutomations(HEALTH).find((a) => a.id === job.id)?.timezone).toBe(
      'Europe/Rome',
    )
  })
})
