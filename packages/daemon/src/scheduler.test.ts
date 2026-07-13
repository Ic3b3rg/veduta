import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fromPartial } from '@total-typescript/shoehorn'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ToolContext } from './agent-runner.ts'
import { Scheduler } from './scheduler.ts'
import { Store } from './store.ts'
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

afterEach(() => {
  for (const scheduler of schedulers) scheduler.stop()
})

describe('Automations Surface projection', () => {
  it('pre-creates an empty Automations Surface for every active Space', () => {
    createScheduler()
    const surface = store.getSurface(SURFACE)
    expect(surface).toBeDefined()
    expect(surface?.tree.children?.[1]?.children?.[0]?.props?.['text']).toBe('No automations yet.')
  })

  it('shows an armed timer in the Space Surface immediately', () => {
    const scheduler = createScheduler()
    scheduler.armTimer({
      spaceId: HEALTH,
      when: '2026-07-08T21:00:00.000Z',
      action: 'Log my weight',
    })
    const surface = store.getSurface(SURFACE)
    expect(surface?.state).toEqual({ 'job-1': true })
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
    scheduler.cancel(timer.id)
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
    scheduler.setEnabled(timer.id, false, 'tool')
    expect(store.getSurface(SURFACE)?.state['job-1']).toBe(false)
    scheduler.setEnabled(timer.id, true, 'tool')
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

    expect(escalations).toHaveLength(1)
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

    expect(escalations).toEqual([{ spaceId: HEALTH, text: 'Scheduled briefing: Morning briefing' }])
    expect(scheduler.listAutomations(HEALTH)[0]).toMatchObject({
      status: 'armed',
      nextRunAt: '2026-07-10T08:00:00.000Z',
      lastOutcome: 'escalated',
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
  it('exposes arm_timer, create_job and cancel with working handlers', async () => {
    const scheduler = createScheduler()
    const tools = Object.fromEntries(scheduler.tools().map((tool) => [tool.name, tool]))
    expect(Object.keys(tools).sort()).toEqual(['arm_timer', 'cancel', 'create_job'])

    const armed = await tools['arm_timer']!.handler(
      {
        spaceId: HEALTH,
        when: '2026-07-08T21:00:00.000Z',
        action: 'Log my weight',
      },
      toolContext('call-1', 'trusted:user'),
    )
    expect(armed.content).toContain('armed timer')

    const cancelled = await tools['cancel']!.handler(
      { automationId: 1 },
      toolContext('call-2', 'trusted:user'),
    )
    expect(cancelled.content).toContain('cancelled automation 1')
    expect(scheduler.listAutomations(HEALTH)[0]?.status).toBe('cancelled')
  })

  it('declares arm_timer, create_job and cancel L0 (daemon-internal, no outbound effect)', () => {
    const scheduler = createScheduler()
    const tools = scheduler.tools()
    expect(tools.map((tool) => tool.level)).toEqual(['L0', 'L0', 'L0'])
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
    await tools['cancel']!.handler({ automationId }, toolContext('call-trusted', 'trusted:user'))
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
})
