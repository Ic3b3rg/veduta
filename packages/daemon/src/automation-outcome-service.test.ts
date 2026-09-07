import { createHash } from 'node:crypto'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  AUTOMATION_OUTCOMES_STATE_KEY,
  AutomationOutcomeStatusesSchema,
  SurfaceSchema,
  surfacePath,
  type AutomationOutcomeInput,
} from '@veduta/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AutomationOutcomeService,
  AutomationOutcomeUnavailableError,
  type AutomationOutcomeOccurrence,
} from './automation-outcome-service.ts'
import { Store } from './store.ts'

const opened: { service: AutomationOutcomeService; store: Store }[] = []

afterEach(() => {
  for (const item of opened.splice(0)) {
    item.service.close()
    item.store.close()
  }
})

describe('AutomationOutcomeService', () => {
  it('advances freshness with compact provenance and no notification for unchanged', async () => {
    const fixture = await setup()

    await fixture.service.deliver(fixture.occurrence(), {
      kind: 'unchanged',
      summary: 'No new entries',
    })

    expect(outcomeStatus(fixture)).toEqual({
      automationId: 12,
      lastCheckedAt: fixture.now().toISOString(),
      lastSuccessfulAt: fixture.now().toISOString(),
    })
    expect(fixture.service.list(fixture.spaceId)).toEqual({ revision: 0, notifications: [] })
    expect(fixture.service.history(12)).toEqual([])
    expect(fixture.store.eventLog(fixture.spaceId).slice(-1)).toMatchObject([
      {
        type: 'automation.outcome',
        payload: { automationId: 12, kind: 'unchanged' },
      },
    ])
  })

  it('represents a routine check as freshness without replacing the latest meaningful outcome', async () => {
    const fixture = await setup()
    await fixture.service.deliver(fixture.occurrence(), changed('Two new entries'))
    fixture.advance('2026-09-02T09:00:00.000Z')

    await fixture.service.deliver(fixture.occurrence('2026-09-02T09:00:00.000Z'), {
      kind: 'unchanged',
      summary: 'No further entries',
    })

    expect(outcomeStatus(fixture)).toMatchObject({
      latest: { kind: 'changed', summary: 'Two new entries' },
      lastCheckedAt: '2026-09-02T09:00:00.000Z',
      lastSuccessfulAt: '2026-09-02T09:00:00.000Z',
    })
    expect(fixture.service.list(fixture.spaceId)).toMatchObject({
      revision: 1,
      notifications: [{ occurrenceCount: 1 }],
    })
  })

  it('atomically updates one owning Surface and creates a navigable notification', async () => {
    const fixture = await setup()
    const lifecycle: unknown[] = []
    fixture.service.onLifecycle((event) => lifecycle.push(event))

    await fixture.service.deliver(fixture.occurrence(), changed('Two new entries'))

    expect(fixture.store.getSurface(fixture.surfaceId)?.state).toMatchObject({
      entries: 2,
      [AUTOMATION_OUTCOMES_STATE_KEY]: {
        '12': {
          latest: { kind: 'changed', summary: 'Two new entries' },
        },
      },
    })
    expect(fixture.service.list(fixture.spaceId)).toMatchObject({
      revision: 1,
      notifications: [
        {
          spaceId: fixture.spaceId,
          surfaceId: fixture.surfaceId,
          occurrenceCount: 1,
          href: `/app/space/automation-tests/surface/${fixture.surfaceId}`,
          state: 'unread',
        },
      ],
    })
    expect(fixture.service.history(12)).toMatchObject([{ kind: 'changed' }])
    expect(lifecycle).toHaveLength(1)
  })

  it('keeps internal outcome idempotency separate from client fast-path keys', async () => {
    const fixture = await setup()
    const targetScope = createHash('sha256')
      .update(`${fixture.spaceId}\0${fixture.surfaceId}`)
      .digest('hex')
      .slice(0, 16)
    const deliveryId = `12:2026-09-02T08:00:00.000Z:${targetScope}`
    fixture.store.applyFastAction(
      fixture.surfaceId,
      'preclaimed',
      true,
      `automation-outcome:${deliveryId}`,
    )

    await fixture.service.deliver(fixture.occurrence(), changed('Two new entries'))

    expect(fixture.store.getSurface(fixture.surfaceId)?.state).toMatchObject({
      preclaimed: true,
      entries: 2,
      [AUTOMATION_OUTCOMES_STATE_KEY]: {
        '12': { latest: { kind: 'changed', summary: 'Two new entries' } },
      },
    })
  })

  it('turns a Surface-invalid producer patch into a durable safe failure', async () => {
    const fixture = await setup()

    await fixture.service.deliver(fixture.occurrence(), {
      kind: 'changed',
      summary: 'Invalid producer update',
      coalesceKey: 'invalid-update',
      operations: [{ target: 'state', op: 'replace', path: '/missing', value: true }],
    })

    expect(outcomeStatus(fixture)).toMatchObject({
      latest: { kind: 'failed' },
      currentError: { code: 'invalid_outcome' },
    })
    expect(fixture.service.list(fixture.spaceId).notifications).toMatchObject([
      { kind: 'failed', summary: 'Automation outcome could not be applied' },
    ])
    fixture.service.close()
    opened.splice(opened.indexOf(fixture), 1)
    const restarted = new AutomationOutcomeService({
      rootDir: fixture.rootDir,
      store: fixture.store,
      now: fixture.now,
    })
    opened.push({ service: restarted, store: fixture.store })
    expect(() => restarted.recover()).not.toThrow()
  })

  it('refuses a stale content outcome after the target Surface changes during delivery retry', async () => {
    const fixture = await setup()
    const interrupted = vi
      .spyOn(fixture.store, 'commitAutomationOutcome')
      .mockImplementation(() => {
        throw new Error('simulated delivery interruption')
      })
    const occurrence = fixture.occurrence()

    await expect(fixture.service.deliver(occurrence, changed('Stale update'))).rejects.toThrow(
      'simulated delivery interruption',
    )
    interrupted.mockRestore()
    fixture.store.patchState(
      fixture.surfaceId,
      [{ target: 'state', op: 'replace', path: '/entries', value: 99 }],
      { updatedBy: 'user' },
    )

    await expect(
      fixture.service.deliver(occurrence, changed('Stale update')),
    ).resolves.toMatchObject({
      kind: 'failed',
      error: { code: 'stale_outcome' },
    })

    expect(fixture.store.getSurface(fixture.surfaceId)?.state['entries']).toBe(99)
    expect(outcomeStatus(fixture)).toMatchObject({
      latest: { kind: 'failed' },
      currentError: { code: 'stale_outcome' },
    })
    expect(fixture.service.list(fixture.spaceId).notifications).toMatchObject([
      { kind: 'failed', summary: 'Automation outcome could not be applied' },
    ])
  })

  it('clears a Pending-decision outcome as soon as its workflow becomes terminal', async () => {
    const fixture = await setup()
    const decisionId = 'update-offer:1.2.3'
    await fixture.service.deliver(fixture.occurrence(), {
      kind: 'decision-required',
      summary: 'Choose an account',
      decisionId,
    })
    fixture.advance('2026-09-02T09:00:00.000Z')

    await fixture.service.settleDecision(decisionId, 'trusted:user')
    await fixture.service.deliver(fixture.occurrence('2026-09-02T09:00:00.000Z'), {
      kind: 'unchanged',
      summary: 'The offer was already decided',
    })

    expect(outcomeStatus(fixture)).toMatchObject({
      lastCheckedAt: '2026-09-02T09:00:00.000Z',
      lastSuccessfulAt: '2026-09-02T09:00:00.000Z',
    })
    expect(outcomeStatus(fixture)).not.toHaveProperty('latest')
  })

  it('cannot publish a decision-required status after that decision becomes terminal', async () => {
    const fixture = await setup()
    const decisionId = 'update-offer:1.2.3'
    const interrupted = vi
      .spyOn(fixture.store, 'commitAutomationOutcome')
      .mockImplementation(() => {
        throw new Error('simulated pending decision delivery')
      })
    const occurrence = fixture.occurrence()
    const outcome: AutomationOutcomeInput = {
      kind: 'decision-required',
      summary: 'Choose an account',
      decisionId,
    }
    await expect(fixture.service.deliver(occurrence, outcome)).rejects.toThrow(
      'simulated pending decision delivery',
    )
    interrupted.mockRestore()

    await fixture.service.settleDecision(decisionId, 'trusted:user')
    await expect(fixture.service.deliver(occurrence, outcome)).resolves.toMatchObject({
      kind: 'unchanged',
    })

    expect(outcomeStatus(fixture)).not.toHaveProperty('latest')
  })

  it('refuses a target Surface outside the Automation owning Space', async () => {
    const fixture = await setup()
    const other = fixture.store.spacesEngine.createSpace({ name: 'Other', slug: 'other' })
    fixture.store.createSurface(surface('srf-other', other.id), 'agent')

    await expect(
      fixture.service.deliver(
        { ...fixture.occurrence(), targetSurfaceId: 'srf-other' },
        changed('Cross-Space write'),
      ),
    ).rejects.toBeInstanceOf(AutomationOutcomeUnavailableError)
    expect(fixture.service.list(other.id).notifications).toEqual([])

    await fixture.service.deliver(fixture.occurrence(), changed('Owning Space write'))
    expect(fixture.service.list(fixture.spaceId).notifications).toMatchObject([
      { summary: 'Owning Space write', surfaceId: fixture.surfaceId },
    ])
  })

  it('settles an unread notification when its target Surface is archived', async () => {
    const fixture = await setup()
    await fixture.service.deliver(fixture.occurrence(), changed('Target updated'))
    const notification = fixture.service.list(fixture.spaceId).notifications[0]!

    fixture.store.archiveSurface(fixture.surfaceId, 'user')

    expect(fixture.service.list(fixture.spaceId).notifications).toEqual([])
    expect(fixture.service.allNotifications(fixture.spaceId)).toMatchObject([
      { id: notification.id, state: 'settled' },
    ])
    expect(() => fixture.service.open(fixture.spaceId, notification.id, 'trusted:user')).toThrow(
      AutomationOutcomeUnavailableError,
    )
    expect(
      fixture.store
        .eventLog(fixture.spaceId)
        .filter((event) => event.type === 'automation.notification.settle'),
    ).toHaveLength(1)
  })

  it('coalesces equivalent unread outcomes and opens a new window after open or dismiss', async () => {
    const fixture = await setup()
    await fixture.service.deliver(fixture.occurrence(), changed('First'))
    fixture.advance('2026-09-02T09:00:00.000Z')
    await fixture.service.deliver(fixture.occurrence('2026-09-02T09:00:00.000Z'), changed('Second'))

    const coalesced = fixture.service.list(fixture.spaceId)
    expect(coalesced).toMatchObject({
      revision: 2,
      notifications: [{ summary: 'Second', occurrenceCount: 2 }],
    })
    const firstId = coalesced.notifications[0]!.id
    expect(fixture.service.open(fixture.spaceId, firstId, 'trusted:user').notification.state).toBe(
      'opened',
    )

    fixture.advance('2026-09-02T10:00:00.000Z')
    await fixture.service.deliver(fixture.occurrence('2026-09-02T10:00:00.000Z'), changed('Third'))
    const next = fixture.service.list(fixture.spaceId)
    expect(next.notifications).toHaveLength(1)
    expect(next.notifications[0]).toMatchObject({ summary: 'Third', occurrenceCount: 1 })
    expect(next.notifications[0]!.id).not.toBe(firstId)
    expect(
      fixture.service.dismiss(fixture.spaceId, next.notifications[0]!.id, 'trusted:user')
        .notification.state,
    ).toBe('dismissed')
    expect(
      fixture.store
        .eventLog(fixture.spaceId)
        .filter((event) => event.type === 'automation.notification.coalesce'),
    ).toHaveLength(1)
    expect(
      fixture.store
        .eventLog(fixture.spaceId)
        .filter((event) => event.type === 'automation.notification.dismissed'),
    ).toHaveLength(1)
  })

  it('does not scan the full Event log on the normal notification write path', async () => {
    const fixture = await setup()
    const eventLog = vi.spyOn(fixture.store, 'eventLog')

    await fixture.service.deliver(fixture.occurrence(), changed('Two new entries'))

    expect(eventLog).not.toHaveBeenCalled()
  })

  it('migrates indexes for replay, unread coalescing, and failure settlement lookups', async () => {
    const fixture = await setup()
    const db = new DatabaseSync(join(fixture.rootDir, 'automation-outcomes.sqlite'))
    const plan = (sql: string) =>
      db
        .prepare(`explain query plan ${sql}`)
        .all()
        .map((row) => String(row['detail']))
        .join('\n')

    expect(
      plan('select * from automation_outcome_notifications where last_delivery_id = 1'),
    ).toContain('automation_outcome_notifications_by_delivery')
    expect(
      plan(`select * from automation_outcome_notifications
            where automation_id = 1 and surface_id = 'surface' and kind = 'changed'
              and coalesce_key = 'key' and space_id = 'space' and state = 'unread'
            order by updated_at desc limit 1`),
    ).toContain('automation_outcome_unread_coalescing')
    expect(
      plan(`select * from automation_outcome_notifications
            where automation_id = 1 and surface_id = 'surface' and kind = 'failed'
              and state = 'unread' and space_id = 'space'
            order by updated_at, id`),
    ).toContain('automation_outcome_unread_failures')
    db.close()
  })

  it('preserves outcome provenance and records explicit notification actions as user events', async () => {
    const fixture = await setup()
    await fixture.service.deliver(
      { ...fixture.occurrence(), origin: 'untrusted:calendar' },
      changed('External <<<content changed'),
    )
    const notification = fixture.service.list(fixture.spaceId).notifications[0]!

    expect(
      fixture.store
        .eventLog(fixture.spaceId)
        .find((event) => event.type === 'automation.notification.create'),
    ).toMatchObject({ origin: 'untrusted:calendar' })

    fixture.service.open(fixture.spaceId, notification.id, 'trusted:user')
    expect(
      fixture.store
        .eventLog(fixture.spaceId)
        .find((event) => event.type === 'automation.notification.opened'),
    ).toMatchObject({ origin: 'trusted:user' })
  })

  it('redacts secret-shaped text before persisting or displaying an outcome', async () => {
    const fixture = await setup()
    await fixture.service.deliver(fixture.occurrence(), {
      kind: 'failed',
      summary: 'Feed sk-automationsecret123 failed',
      coalesceKey: 'feed-failed',
      error: {
        code: 'feed_failed',
        message: 'Authorization used Bearer automation-secret-token',
      },
    })

    const serialized = JSON.stringify({
      surface: fixture.store.getSurface(fixture.surfaceId),
      notifications: fixture.service.list(fixture.spaceId),
      events: fixture.store.eventLog(fixture.spaceId),
    })
    expect(serialized).not.toContain('automationsecret123')
    expect(serialized).not.toContain('automation-secret-token')
    expect(serialized).toContain('[redacted]')
  })

  it('retains last-valid content across failures and settles it on recovery', async () => {
    const fixture = await setup()
    await fixture.service.deliver(fixture.occurrence(), changed('Initial value'))
    fixture.advance('2026-09-02T09:00:00.000Z')
    await fixture.service.deliver(fixture.occurrence('2026-09-02T09:00:00.000Z'), failed())
    fixture.advance('2026-09-02T10:00:00.000Z')
    await fixture.service.deliver(fixture.occurrence('2026-09-02T10:00:00.000Z'), failed())

    expect(fixture.store.getSurface(fixture.surfaceId)?.state).toMatchObject({
      entries: 2,
      [AUTOMATION_OUTCOMES_STATE_KEY]: {
        '12': {
          latest: { kind: 'failed' },
          lastSuccessfulAt: '2026-09-02T08:00:00.000Z',
          currentError: { code: 'source_unavailable' },
        },
      },
    })
    expect(fixture.service.list(fixture.spaceId).notifications).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'failed', occurrenceCount: 2, state: 'unread' }),
      ]),
    )

    fixture.advance('2026-09-02T11:00:00.000Z')
    await fixture.service.deliver(fixture.occurrence('2026-09-02T11:00:00.000Z'), {
      kind: 'recovered',
      summary: 'Recovered',
      coalesceKey: 'refresh-recovered',
      operations: [{ target: 'state', op: 'replace', path: '/entries', value: 2 }],
    })

    expect(outcomeStatus(fixture)).not.toHaveProperty('currentError')
    expect(fixture.service.list(fixture.spaceId).notifications).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'changed' }),
        expect.objectContaining({ kind: 'recovered' }),
      ]),
    )
    expect(fixture.service.allNotifications(fixture.spaceId)).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'failed', state: 'settled' })]),
    )
  })

  it('promotes the first successful check after a failure to a recovery outcome', async () => {
    const fixture = await setup()
    await fixture.service.deliver(fixture.occurrence(), failed())
    fixture.advance('2026-09-02T09:00:00.000Z')

    await fixture.service.deliver(fixture.occurrence('2026-09-02T09:00:00.000Z'), {
      kind: 'unchanged',
      summary: 'Source reachable; no new entries',
    })

    expect(outcomeStatus(fixture)).toMatchObject({
      latest: { kind: 'recovered' },
      lastSuccessfulAt: '2026-09-02T09:00:00.000Z',
    })
    expect(outcomeStatus(fixture)).not.toHaveProperty('currentError')
    expect(fixture.service.list(fixture.spaceId).notifications).toEqual([
      expect.objectContaining({ kind: 'recovered', state: 'unread' }),
    ])
    expect(fixture.service.allNotifications(fixture.spaceId)).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'failed', state: 'settled' })]),
    )
  })

  it('recovers when a backup retained the Surface failure but its outcome database predates it', async () => {
    const fixture = await setup()
    await fixture.service.deliver(fixture.occurrence(), failed())
    const failureId = fixture.service.list(fixture.spaceId).notifications[0]!.id
    fixture.service.close()
    opened.splice(opened.indexOf(fixture), 1)

    const db = new DatabaseSync(join(fixture.rootDir, 'automation-outcomes.sqlite'))
    db.exec(`
      delete from automation_outcome_deliveries;
      delete from automation_outcome_delivery_tombstones;
      delete from automation_outcome_history;
      delete from automation_outcome_notifications;
      delete from automation_outcome_notification_intents;
      update automation_outcome_meta set revision = 0 where singleton = 1;
    `)
    db.close()

    const restarted = new AutomationOutcomeService({
      rootDir: fixture.rootDir,
      store: fixture.store,
      now: fixture.now,
    })
    opened.push({ service: restarted, store: fixture.store })
    restarted.recover()
    expect(restarted.list(fixture.spaceId).notifications).toMatchObject([
      { id: failureId, kind: 'failed', state: 'unread' },
    ])

    fixture.advance('2026-09-02T09:00:00.000Z')
    await restarted.deliver(fixture.occurrence('2026-09-02T09:00:00.000Z'), {
      kind: 'unchanged',
      summary: 'Source reachable; no new entries',
    })

    expect(outcomeStatus(fixture)).toMatchObject({
      latest: { kind: 'recovered' },
      lastSuccessfulAt: '2026-09-02T09:00:00.000Z',
    })
    expect(outcomeStatus(fixture)).not.toHaveProperty('currentError')
    expect(restarted.list(fixture.spaceId).notifications).toEqual([
      expect.objectContaining({ kind: 'recovered', state: 'unread' }),
    ])
    expect(restarted.allNotifications(fixture.spaceId)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: failureId, kind: 'failed', state: 'settled' }),
      ]),
    )
  })

  it('does not treat another Automation succeeding on the same Surface as recovery', async () => {
    const fixture = await setup()
    await fixture.service.deliver(fixture.occurrence(), failed())

    await fixture.service.deliver(
      { ...fixture.occurrence('2026-09-02T09:00:00.000Z'), automationId: 13 },
      { kind: 'unchanged', summary: 'Another check found no changes' },
    )

    expect(outcomeStatus(fixture, 12)).toMatchObject({
      automationId: 12,
      latest: { kind: 'failed' },
      currentError: { code: 'source_unavailable' },
    })
    expect(outcomeStatus(fixture, 13)).toMatchObject({
      automationId: 13,
    })
    expect(outcomeStatus(fixture, 13)).not.toHaveProperty('latest')
    expect(outcomeStatus(fixture, 13)).not.toHaveProperty('currentError')
    expect(fixture.service.list(fixture.spaceId).notifications).toEqual([
      expect.objectContaining({ automationId: 12, kind: 'failed' }),
    ])
  })

  it('recovers after the user has already dismissed the failure notification', async () => {
    const fixture = await setup()
    await fixture.service.deliver(fixture.occurrence(), failed())
    const failureId = fixture.service.list(fixture.spaceId).notifications[0]!.id
    fixture.service.dismiss(fixture.spaceId, failureId, 'trusted:user')

    await fixture.service.deliver(fixture.occurrence('2026-09-02T09:00:00.000Z'), {
      kind: 'unchanged',
      summary: 'Source is reachable again',
    })

    expect(outcomeStatus(fixture)).toMatchObject({
      latest: { kind: 'recovered' },
    })
    expect(outcomeStatus(fixture)).not.toHaveProperty('currentError')
    expect(fixture.service.list(fixture.spaceId).notifications).toEqual([
      expect.objectContaining({ kind: 'recovered' }),
    ])
  })

  it('settles every outstanding failure category for the recovered Automation', async () => {
    const fixture = await setup()
    await fixture.service.deliver(fixture.occurrence(), failed())
    await fixture.service.deliver(fixture.occurrence('2026-09-02T09:00:00.000Z'), {
      kind: 'failed',
      summary: 'Credentials expired',
      coalesceKey: 'credentials-expired',
      error: { code: 'credentials_expired', message: 'Reconnect the source.' },
    })
    expect(fixture.service.list(fixture.spaceId).notifications).toHaveLength(2)

    await fixture.service.deliver(fixture.occurrence('2026-09-02T10:00:00.000Z'), {
      kind: 'unchanged',
      summary: 'Source is reachable again',
    })

    expect(fixture.service.list(fixture.spaceId).notifications).toEqual([
      expect.objectContaining({ kind: 'recovered' }),
    ])
    expect(
      fixture.service
        .allNotifications(fixture.spaceId)
        .filter((notification) => notification.kind === 'failed'),
    ).toEqual([
      expect.objectContaining({ state: 'settled' }),
      expect.objectContaining({ state: 'settled' }),
    ])
  })

  it('keeps another Automation failure visible when one sharing the Surface recovers', async () => {
    const fixture = await setup()
    await fixture.service.deliver(fixture.occurrence(), failed())
    await fixture.service.deliver(
      { ...fixture.occurrence('2026-09-02T09:00:00.000Z'), automationId: 13 },
      {
        kind: 'failed',
        summary: 'Tasks refresh failed',
        coalesceKey: 'tasks-unavailable',
        error: { code: 'tasks_unavailable', message: 'The tasks source could not be reached.' },
      },
    )

    await fixture.service.deliver(fixture.occurrence('2026-09-02T10:00:00.000Z'), {
      kind: 'unchanged',
      summary: 'Calendar is reachable again',
    })

    expect(outcomeStatus(fixture, 12)).toMatchObject({ latest: { kind: 'recovered' } })
    expect(outcomeStatus(fixture, 12)).not.toHaveProperty('currentError')
    expect(outcomeStatus(fixture, 13)).toMatchObject({
      latest: { kind: 'failed' },
      currentError: { code: 'tasks_unavailable' },
    })
    expect(fixture.service.list(fixture.spaceId).notifications).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ automationId: 12, kind: 'recovered' }),
        expect.objectContaining({ automationId: 13, kind: 'failed' }),
      ]),
    )
  })

  it('scopes recovery and failure settlement to the same target Surface', async () => {
    const fixture = await setup()
    const secondSurfaceId = 'srf-automation-test-secondary'
    fixture.store.createSurface(surface(secondSurfaceId, fixture.spaceId), 'agent')
    await fixture.service.deliver(fixture.occurrence(), failed())

    await fixture.service.deliver(
      {
        ...fixture.occurrence('2026-09-02T09:00:00.000Z'),
        targetSurfaceId: secondSurfaceId,
      },
      { kind: 'unchanged', summary: 'The replacement target is current' },
    )

    expect(outcomeStatus(fixture)).toMatchObject({ latest: { kind: 'failed' } })
    expect(outcomeStatus(fixture, 12, secondSurfaceId)).not.toHaveProperty('latest')
    expect(fixture.service.list(fixture.spaceId).notifications).toEqual([
      expect.objectContaining({ kind: 'failed', surfaceId: fixture.surfaceId }),
    ])
  })

  it('recovers from a new failure that follows a decision-required occurrence', async () => {
    const fixture = await setup()
    await fixture.service.deliver(fixture.occurrence(), failed())
    await fixture.service.deliver(fixture.occurrence('2026-09-02T09:00:00.000Z'), {
      kind: 'decision-required',
      summary: 'Choose a calendar account',
      decisionId: 'approval:calendar-account',
    })
    await fixture.service.deliver(fixture.occurrence('2026-09-02T09:30:00.000Z'), failed())

    await fixture.service.deliver(fixture.occurrence('2026-09-02T10:00:00.000Z'), {
      kind: 'unchanged',
      summary: 'The calendar source is reachable',
    })

    expect(outcomeStatus(fixture)).toMatchObject({ latest: { kind: 'recovered' } })
    expect(fixture.service.list(fixture.spaceId).notifications).toEqual([
      expect.objectContaining({ kind: 'recovered' }),
    ])
  })

  it('clears a technical failure as soon as a backed decision is required', async () => {
    const fixture = await setup()
    await fixture.service.deliver(fixture.occurrence(), failed())
    fixture.advance('2026-09-02T09:00:00.000Z')
    await fixture.service.deliver(fixture.occurrence('2026-09-02T09:00:00.000Z'), {
      kind: 'decision-required',
      summary: 'Choose a calendar account',
      decisionId: 'approval:calendar-account',
    })

    expect(outcomeStatus(fixture)).toMatchObject({
      latest: { kind: 'decision-required', summary: 'Choose a calendar account' },
      lastSuccessfulAt: '2026-09-02T09:00:00.000Z',
    })
    expect(outcomeStatus(fixture)).not.toHaveProperty('currentError')
    expect(fixture.service.list(fixture.spaceId).notifications).toEqual([])
    expect(fixture.service.allNotifications(fixture.spaceId)).toMatchObject([
      { kind: 'failed', state: 'settled' },
    ])

    fixture.advance('2026-09-02T10:00:00.000Z')
    await fixture.service.deliver(fixture.occurrence('2026-09-02T10:00:00.000Z'), {
      kind: 'unchanged',
      summary: 'The calendar account is still awaiting selection',
    })
    expect(fixture.service.list(fixture.spaceId).notifications).toEqual([])
    expect(outcomeStatus(fixture)).toMatchObject({ latest: { kind: 'decision-required' } })
  })

  it('rejects a projected FACTS Surface before persisting a poison delivery', async () => {
    const fixture = await setup()
    const factsSurfaceId = fixture.store.spacesEngine.factsSurface(fixture.spaceId).id

    await expect(
      fixture.service.deliver(
        { ...fixture.occurrence(), targetSurfaceId: factsSurfaceId },
        { kind: 'unchanged', summary: 'Facts are current' },
      ),
    ).rejects.toBeInstanceOf(AutomationOutcomeUnavailableError)

    fixture.service.close()
    opened.splice(opened.indexOf(fixture), 1)
    const restarted = new AutomationOutcomeService({
      rootDir: fixture.rootDir,
      store: fixture.store,
      now: fixture.now,
    })
    opened.push({ service: restarted, store: fixture.store })
    expect(() => restarted.recover()).not.toThrow()
  })

  it('recovers idempotently across concurrent delivery and restart', async () => {
    const fixture = await setup()
    const occurrence = fixture.occurrence()
    await Promise.all([
      fixture.service.deliver(occurrence, changed('Two new entries')),
      fixture.service.deliver(occurrence, changed('Two new entries')),
    ])
    fixture.service.close()
    opened.splice(opened.indexOf(fixture), 1)

    const restarted = new AutomationOutcomeService({
      rootDir: fixture.rootDir,
      store: fixture.store,
      now: fixture.now,
    })
    opened.push({ service: restarted, store: fixture.store })
    await restarted.recover()
    await restarted.deliver(occurrence, changed('Two new entries'))

    expect(restarted.list(fixture.spaceId).notifications).toMatchObject([{ occurrenceCount: 1 }])
    expect(restarted.history(12)).toHaveLength(1)
    expect(
      fixture.store
        .eventLog(fixture.spaceId)
        .filter((event) => event.type === 'automation.outcome'),
    ).toHaveLength(1)
  })

  it('recovers a notification after interruption between its Event and durable state', async () => {
    const fixture = await setup()
    const appendEvent = fixture.store.spacesEngine.appendEvent.bind(fixture.store.spacesEngine)
    let interrupted = false
    fixture.store.spacesEngine.appendEvent = (spaceId, event) => {
      const appended = appendEvent(spaceId, event)
      if (!interrupted && event.type === 'automation.notification.create') {
        interrupted = true
        throw new Error('simulated process interruption')
      }
      return appended
    }

    await expect(
      fixture.service.deliver(fixture.occurrence(), changed('Two new entries')),
    ).rejects.toThrow('simulated process interruption')
    fixture.store.spacesEngine.appendEvent = appendEvent
    fixture.service.close()
    opened.splice(opened.indexOf(fixture), 1)

    const restarted = new AutomationOutcomeService({
      rootDir: fixture.rootDir,
      store: fixture.store,
      now: fixture.now,
    })
    opened.push({ service: restarted, store: fixture.store })
    restarted.recover()

    expect(restarted.list(fixture.spaceId).notifications).toMatchObject([
      { occurrenceCount: 1, state: 'unread' },
    ])
    expect(
      fixture.store
        .eventLog(fixture.spaceId)
        .filter((event) => event.type === 'automation.notification.create'),
    ).toHaveLength(1)
  })

  it('recovers a dismissal interrupted after its Event was appended', async () => {
    const fixture = await setup()
    await fixture.service.deliver(fixture.occurrence(), changed('Two new entries'))
    const notificationId = fixture.service.list(fixture.spaceId).notifications[0]!.id
    const appendEvent = fixture.store.spacesEngine.appendEvent.bind(fixture.store.spacesEngine)
    fixture.store.spacesEngine.appendEvent = (spaceId, event) => {
      const appended = appendEvent(spaceId, event)
      if (event.type === 'automation.notification.dismissed') {
        throw new Error('simulated dismissal interruption')
      }
      return appended
    }

    expect(() => fixture.service.dismiss(fixture.spaceId, notificationId, 'trusted:user')).toThrow(
      'simulated dismissal interruption',
    )
    fixture.store.spacesEngine.appendEvent = appendEvent
    const staleOpen = fixture.service.open(fixture.spaceId, notificationId, 'trusted:user')
    expect(staleOpen.notification.state).toBe('dismissed')
    fixture.service.close()
    opened.splice(opened.indexOf(fixture), 1)

    const restarted = new AutomationOutcomeService({
      rootDir: fixture.rootDir,
      store: fixture.store,
      now: fixture.now,
    })
    opened.push({ service: restarted, store: fixture.store })
    restarted.recover()

    expect(restarted.allNotifications(fixture.spaceId)).toMatchObject([
      { id: notificationId, state: 'dismissed' },
    ])
    expect(
      fixture.store
        .eventLog(fixture.spaceId)
        .filter((event) => event.type === 'automation.notification.dismissed'),
    ).toHaveLength(1)
  })

  it.each(['opened', 'dismissed'] as const)(
    'rebuilds %s notification state when a backup captured Events ahead of the outcome database',
    async (state) => {
      const fixture = await setup()
      await fixture.service.deliver(fixture.occurrence(), changed('Two new entries'))
      const notificationId = fixture.service.list(fixture.spaceId).notifications[0]!.id
      fixture.service[state === 'opened' ? 'open' : 'dismiss'](
        fixture.spaceId,
        notificationId,
        'trusted:user',
      )
      const eventCount = fixture.store
        .eventLog(fixture.spaceId)
        .filter((event) => event.type.startsWith('automation.notification.')).length
      fixture.service.close()
      opened.splice(opened.indexOf(fixture), 1)
      const db = new DatabaseSync(join(fixture.rootDir, 'automation-outcomes.sqlite'))
      db.exec(`
        delete from automation_outcome_notifications;
        delete from automation_outcome_notification_intents;
        update automation_outcome_meta set revision = 0 where singleton = 1;
      `)
      db.close()

      const restarted = new AutomationOutcomeService({
        rootDir: fixture.rootDir,
        store: fixture.store,
        now: fixture.now,
      })
      opened.push({ service: restarted, store: fixture.store })
      restarted.recover()

      expect(restarted.allNotifications(fixture.spaceId)).toMatchObject([
        { id: notificationId, state },
      ])
      expect(
        fixture.store
          .eventLog(fixture.spaceId)
          .filter((event) => event.type.startsWith('automation.notification.')),
      ).toHaveLength(eventCount)
    },
  )

  it('rebuilds bounded run history when a backup captured its outcome Event first', async () => {
    const fixture = await setup()
    await fixture.service.deliver(fixture.occurrence(), changed('Two new entries'))
    fixture.service.close()
    opened.splice(opened.indexOf(fixture), 1)
    const db = new DatabaseSync(join(fixture.rootDir, 'automation-outcomes.sqlite'))
    db.exec(`
      delete from automation_outcome_deliveries;
      delete from automation_outcome_delivery_tombstones;
      delete from automation_outcome_history;
    `)
    db.close()

    const restarted = new AutomationOutcomeService({
      rootDir: fixture.rootDir,
      store: fixture.store,
      now: fixture.now,
    })
    opened.push({ service: restarted, store: fixture.store })
    restarted.recover()
    restarted.recover()

    expect(restarted.history(12)).toMatchObject([
      {
        automationId: 12,
        scheduledFor: '2026-09-02T08:00:00.000Z',
        kind: 'changed',
        summary: 'Two new entries',
        at: '2026-09-02T08:00:00.000Z',
      },
    ])
  })

  it('rebuilds a notification when backup skew retained only the committed outcome Event', async () => {
    const fixture = await setup()
    const appendEvent = fixture.store.spacesEngine.appendEvent.bind(fixture.store.spacesEngine)
    fixture.store.spacesEngine.appendEvent = (spaceId, event) => {
      if (event.type === 'automation.notification.create') {
        throw new Error('simulated crash before notification Event')
      }
      return appendEvent(spaceId, event)
    }
    await expect(
      fixture.service.deliver(fixture.occurrence(), changed('Outcome committed before crash')),
    ).rejects.toThrow('simulated crash before notification Event')
    fixture.store.spacesEngine.appendEvent = appendEvent
    expect(
      fixture.store
        .eventLog(fixture.spaceId)
        .filter((event) => event.type === 'automation.outcome'),
    ).toHaveLength(1)
    expect(
      fixture.store
        .eventLog(fixture.spaceId)
        .filter((event) => event.type.startsWith('automation.notification.')),
    ).toEqual([])
    fixture.service.close()
    opened.splice(opened.indexOf(fixture), 1)
    const db = new DatabaseSync(join(fixture.rootDir, 'automation-outcomes.sqlite'))
    db.exec(`
      delete from automation_outcome_deliveries;
      delete from automation_outcome_delivery_tombstones;
      delete from automation_outcome_history;
      delete from automation_outcome_notifications;
      delete from automation_outcome_notification_intents;
      update automation_outcome_meta set revision = 0 where singleton = 1;
    `)
    db.close()

    const restarted = new AutomationOutcomeService({
      rootDir: fixture.rootDir,
      store: fixture.store,
      now: fixture.now,
    })
    opened.push({ service: restarted, store: fixture.store })
    restarted.recover()

    expect(restarted.list(fixture.spaceId).notifications).toMatchObject([
      {
        kind: 'changed',
        summary: 'Outcome committed before crash',
        surfaceId: fixture.surfaceId,
      },
    ])
    expect(
      fixture.store
        .eventLog(fixture.spaceId)
        .filter((event) => event.type === 'automation.notification.create'),
    ).toHaveLength(1)
  })

  it('does not duplicate notification Events when an archived Space is reconciled twice', async () => {
    const fixture = await setup()
    await fixture.service.deliver(fixture.occurrence(), changed('Two new entries'))
    fixture.store.archiveSpace(fixture.spaceId)
    const eventCount = fixture.store
      .eventLog(fixture.spaceId)
      .filter((event) => event.type.startsWith('automation.notification.')).length

    fixture.service.recover()
    fixture.service.recover()

    expect(
      fixture.store
        .eventLog(fixture.spaceId)
        .filter((event) => event.type.startsWith('automation.notification.')),
    ).toHaveLength(eventCount)
  })

  it('uses the durable Event watermark instead of rescanning full Space history on later boots', async () => {
    const fixture = await setup()
    await fixture.service.deliver(fixture.occurrence(), changed('Two new entries'))
    fixture.service.recover()
    fixture.service.close()
    opened.splice(opened.indexOf(fixture), 1)
    const fullLog = vi.spyOn(fixture.store, 'eventLog')
    const recentLog = vi.spyOn(fixture.store, 'eventLogSince')
    const restarted = new AutomationOutcomeService({
      rootDir: fixture.rootDir,
      store: fixture.store,
      now: fixture.now,
    })
    opened.push({ service: restarted, store: fixture.store })

    restarted.recover()

    expect(fullLog).not.toHaveBeenCalled()
    expect(recentLog).toHaveBeenCalled()
  })

  it('finishes an interrupted dismissal before opening the next coalescing window', async () => {
    const fixture = await setup()
    await fixture.service.deliver(fixture.occurrence(), changed('First update'))
    const firstId = fixture.service.list(fixture.spaceId).notifications[0]!.id
    const lifecycle: { id: string; state: string }[] = []
    fixture.service.onLifecycle((event) =>
      lifecycle.push({ id: event.notification.id, state: event.notification.state }),
    )
    const appendEvent = fixture.store.spacesEngine.appendEvent.bind(fixture.store.spacesEngine)
    fixture.store.spacesEngine.appendEvent = (spaceId, event) => {
      const appended = appendEvent(spaceId, event)
      if (event.type === 'automation.notification.dismissed') {
        throw new Error('simulated dismissal interruption')
      }
      return appended
    }
    expect(() => fixture.service.dismiss(fixture.spaceId, firstId, 'trusted:user')).toThrow(
      'simulated dismissal interruption',
    )
    fixture.store.spacesEngine.appendEvent = appendEvent

    fixture.advance('2026-09-02T09:00:00.000Z')
    await fixture.service.deliver(
      fixture.occurrence('2026-09-02T09:00:00.000Z'),
      changed('Second update'),
    )

    const unread = fixture.service.list(fixture.spaceId).notifications
    expect(unread).toMatchObject([{ summary: 'Second update', state: 'unread' }])
    expect(unread[0]?.id).not.toBe(firstId)
    expect(fixture.service.allNotifications(fixture.spaceId)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: firstId, state: 'dismissed' }),
        expect.objectContaining({ id: unread[0]?.id, state: 'unread' }),
      ]),
    )
    expect(lifecycle).toEqual([
      { id: firstId, state: 'dismissed' },
      { id: unread[0]?.id, state: 'unread' },
    ])
  })

  it('leaves an unavailable pending delivery isolated while recovering later deliveries', async () => {
    const fixture = await setup()
    const db = new DatabaseSync(join(fixture.rootDir, 'automation-outcomes.sqlite'))
    const insert = db.prepare(
      `insert into automation_outcome_deliveries
         (id, automation_id, space_id, target_surface_id, description, scheduled_for, origin, outcome_json)
       values (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    insert.run(
      '10:2026-09-02T08:30:00.000Z',
      10,
      fixture.spaceId,
      'srf-archived',
      'Archived target',
      '2026-09-02T08:30:00.000Z',
      'trusted:system',
      JSON.stringify(changed('Unavailable target update')),
    )
    insert.run(
      '12:2026-09-02T09:00:00.000Z',
      12,
      fixture.spaceId,
      fixture.surfaceId,
      'Weekly plan',
      '2026-09-02T09:00:00.000Z',
      'trusted:system',
      JSON.stringify(changed('Recovered pending update')),
    )
    db.close()
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    fixture.service.recover()

    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining('remains pending: target unavailable'),
    )
    expect(fixture.service.list(fixture.spaceId).notifications).toMatchObject([
      { summary: 'Recovered pending update' },
    ])
  })

  it('preserves legacy user state whose pre-issue key was automationOutcomes', async () => {
    const fixture = await setup()
    fixture.store.patchState(
      fixture.surfaceId,
      [{ target: 'state', op: 'add', path: '/automationOutcomes', value: { legacy: true } }],
      { updatedBy: 'agent' },
    )

    await fixture.service.deliver(fixture.occurrence(), {
      kind: 'unchanged',
      summary: 'No new entries',
    })

    expect(fixture.store.getSurface(fixture.surfaceId)?.state['automationOutcomes']).toEqual({
      legacy: true,
    })
    expect(outcomeStatus(fixture)).toMatchObject({ automationId: 12 })
  })

  it('accepts a long schema-valid Surface id without poisoning notification recovery', async () => {
    const fixture = await setup()
    const longSurfaceId = `srf-${'é'.repeat(400)}`
    fixture.store.createSurface(surface(longSurfaceId, fixture.spaceId), 'agent')

    await fixture.service.deliver(
      { ...fixture.occurrence(), targetSurfaceId: longSurfaceId },
      changed('Long target updated'),
    )

    const notification = fixture.service.list(fixture.spaceId).notifications[0]
    expect(notification?.surfaceId).toBe(longSurfaceId)
    expect(notification?.href.length).toBeGreaterThan(600)
    expect(() => fixture.service.recover()).not.toThrow()
  })

  it('rebuilds a notification whose schema-valid Surface id resembles a secret', async () => {
    const fixture = await setup()
    const surfaceId = 'sk-automationsecret123'
    fixture.store.createSurface(surface(surfaceId, fixture.spaceId), 'agent')
    await fixture.service.deliver(
      { ...fixture.occurrence(), targetSurfaceId: surfaceId },
      changed('Secret-shaped target updated'),
    )
    const event = fixture.store
      .eventLog(fixture.spaceId)
      .find((candidate) => candidate.type === 'automation.notification.create')
    expect(JSON.stringify(event)).not.toContain(surfaceId)

    fixture.service.close()
    opened.splice(opened.indexOf(fixture), 1)
    const db = new DatabaseSync(join(fixture.rootDir, 'automation-outcomes.sqlite'))
    db.exec(`
      delete from automation_outcome_notifications;
      delete from automation_outcome_notification_intents;
      update automation_outcome_meta set revision = 0 where singleton = 1;
    `)
    db.close()
    const restarted = new AutomationOutcomeService({
      rootDir: fixture.rootDir,
      store: fixture.store,
      now: fixture.now,
    })
    opened.push({ service: restarted, store: fixture.store })

    restarted.recover()

    expect(restarted.list(fixture.spaceId).notifications).toMatchObject([
      { surfaceId, href: surfacePath('automation-tests', surfaceId) },
    ])
  })

  it('settles a fallback failure before clearing its status so a crash cannot strand it', async () => {
    const fixture = await setup()
    const fallbackSurfaceId = 'srf-automation-fallback'
    fixture.store.createSurface(surface(fallbackSurfaceId, fixture.spaceId), 'job')
    await fixture.service.deliver(
      { ...fixture.occurrence(), targetSurfaceId: fallbackSurfaceId },
      {
        kind: 'failed',
        summary: 'Automation target is unavailable',
        coalesceKey: 'target_unavailable',
        error: {
          code: 'target_unavailable',
          message: 'The linked Surface is no longer available.',
        },
      },
    )

    const commit = fixture.store.commitAutomationOutcome.bind(fixture.store)
    const interrupted = vi
      .spyOn(fixture.store, 'commitAutomationOutcome')
      .mockImplementation((surfaceId, operations, options) => {
        if (
          surfaceId === fallbackSurfaceId &&
          options.idempotencyKey.startsWith('automation-outcome-target-recovered:')
        ) {
          throw new Error('simulated crash while clearing fallback status')
        }
        return commit(surfaceId, operations, options)
      })
    const restoredOccurrence = fixture.occurrence('2026-09-02T09:00:00.000Z')
    await expect(
      fixture.service.deliver(restoredOccurrence, {
        kind: 'unchanged',
        summary: 'The Automation target is available again',
      }),
    ).rejects.toThrow('simulated crash while clearing fallback status')

    expect(fixture.service.allNotifications(fixture.spaceId)).toMatchObject([
      { kind: 'failed', state: 'settled', surfaceId: fallbackSurfaceId },
    ])
    expect(outcomeStatus(fixture, 12, fallbackSurfaceId)).toMatchObject({
      currentError: { code: 'target_unavailable' },
    })

    interrupted.mockRestore()
    await fixture.service.deliver(restoredOccurrence, {
      kind: 'unchanged',
      summary: 'The Automation target is available again',
    })

    expect(outcomeStatus(fixture, 12, fallbackSurfaceId)).toBeUndefined()
    expect(fixture.service.list(fixture.spaceId).notifications).toMatchObject([
      { kind: 'recovered', surfaceId: fixture.surfaceId },
    ])
  })

  it('discovers and clears a fallback failure retained only by Surface state after backup skew', async () => {
    const fixture = await setup()
    const fallbackSurfaceId = 'srf-automation-fallback'
    fixture.store.createSurface(surface(fallbackSurfaceId, fixture.spaceId), 'job')
    await fixture.service.deliver(
      { ...fixture.occurrence(), targetSurfaceId: fallbackSurfaceId },
      {
        kind: 'failed',
        summary: 'Automation target is unavailable',
        coalesceKey: 'target_unavailable',
        error: {
          code: 'target_unavailable',
          message: 'The linked Surface is no longer available.',
        },
      },
    )
    fixture.service.close()
    opened.splice(opened.indexOf(fixture), 1)
    const db = new DatabaseSync(join(fixture.rootDir, 'automation-outcomes.sqlite'))
    db.exec(`
      delete from automation_outcome_deliveries;
      delete from automation_outcome_delivery_tombstones;
      delete from automation_outcome_history;
      delete from automation_outcome_notifications;
      delete from automation_outcome_notification_intents;
      update automation_outcome_meta set revision = 0 where singleton = 1;
    `)
    db.close()
    const restarted = new AutomationOutcomeService({
      rootDir: fixture.rootDir,
      store: fixture.store,
      now: fixture.now,
    })
    opened.push({ service: restarted, store: fixture.store })
    restarted.recover()

    fixture.advance('2026-09-02T09:00:00.000Z')
    await restarted.deliver(fixture.occurrence('2026-09-02T09:00:00.000Z'), {
      kind: 'unchanged',
      summary: 'The Automation target is available again',
    })

    expect(outcomeStatus(fixture)).toMatchObject({ latest: { kind: 'recovered' } })
    expect(outcomeStatus(fixture, 12, fallbackSurfaceId)).toBeUndefined()
    expect(restarted.list(fixture.spaceId).notifications).toMatchObject([
      { kind: 'recovered', surfaceId: fixture.surfaceId },
    ])
    expect(restarted.allNotifications(fixture.spaceId)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'failed', surfaceId: fallbackSurfaceId, state: 'settled' }),
      ]),
    )
  })

  it('bounds full delivery rows while retaining replay tombstones', async () => {
    const fixture = await setup()
    const firstOccurrence = fixture.occurrence()
    for (let index = 0; index < 80; index += 1) {
      const scheduledFor = new Date(Date.UTC(2026, 8, 2, 8, index)).toISOString()
      fixture.advance(scheduledFor)
      await fixture.service.deliver(fixture.occurrence(scheduledFor), {
        kind: 'unchanged',
        summary: `No changes ${index}`,
      })
    }
    const latestCheckedAt = fixture.now().toISOString()
    const db = new DatabaseSync(join(fixture.rootDir, 'automation-outcomes.sqlite'))
    expect(
      db.prepare('select count(*) as count from automation_outcome_deliveries').get()?.['count'],
    ).toBe(64)
    expect(
      db.prepare('select count(*) as count from automation_outcome_delivery_tombstones').get()?.[
        'count'
      ],
    ).toBe(80)

    await fixture.service.deliver(firstOccurrence, {
      kind: 'unchanged',
      summary: 'Old replay must be inert',
    })

    expect(outcomeStatus(fixture)?.lastCheckedAt).toBe(latestCheckedAt)
    expect(
      db.prepare('select count(*) as count from automation_outcome_deliveries').get()?.['count'],
    ).toBe(64)
    db.close()
  })

  it('bounds history to meaningful outcomes only', async () => {
    const fixture = await setup()
    for (let index = 0; index < 22; index += 1) {
      const scheduledFor = new Date(Date.UTC(2026, 8, 2, 8, index)).toISOString()
      fixture.advance(scheduledFor)
      const outcome: AutomationOutcomeInput =
        index === 0 ? { kind: 'unchanged', summary: 'No changes' } : changed(`Change ${index}`)
      await fixture.service.deliver(fixture.occurrence(scheduledFor), outcome)
    }

    const history = fixture.service.history(12)
    expect(history).toHaveLength(20)
    expect(history.map((entry) => entry.kind)).not.toContain('unchanged')
    expect(history[0]?.summary).toBe('Change 21')
  })
})

function changed(summary: string): AutomationOutcomeInput {
  return {
    kind: 'changed',
    summary,
    coalesceKey: 'entries',
    operations: [{ target: 'state', op: 'replace', path: '/entries', value: 2 }],
  }
}

function failed(): AutomationOutcomeInput {
  return {
    kind: 'failed',
    summary: 'Refresh failed',
    coalesceKey: 'source-unavailable',
    error: { code: 'source_unavailable', message: 'The source could not be reached.' },
  }
}

async function setup() {
  const rootDir = await mkdtemp(join(tmpdir(), 'veduta-outcomes-'))
  let current = new Date('2026-09-02T08:00:00.000Z')
  const now = () => new Date(current)
  const store = new Store({ rootDir, now })
  const space = store.spacesEngine.createSpace({
    name: 'Automation tests',
    slug: 'automation-tests',
  })
  const surfaceId = 'srf-automation-test'
  store.createSurface(surface(surfaceId, space.id), 'agent')
  const service = new AutomationOutcomeService({ rootDir, store, now })
  const fixture = {
    rootDir,
    service,
    store,
    spaceId: space.id,
    surfaceId,
    now,
    advance: (iso: string) => {
      current = new Date(iso)
    },
    occurrence: (scheduledFor = '2026-09-02T08:00:00.000Z'): AutomationOutcomeOccurrence => ({
      automationId: 12,
      spaceId: space.id,
      targetSurfaceId: surfaceId,
      description: 'Weekly plan',
      scheduledFor,
      checkedAt: scheduledFor,
      origin: 'trusted:system',
    }),
  }
  opened.push(fixture)
  return fixture
}

function surface(id: string, spaceId: string) {
  return SurfaceSchema.parse({
    id,
    spaceId,
    title: 'Weekly plan',
    tree: { id: 'root', type: 'Box', children: [] },
    state: { entries: 1 },
    freshness: { updatedAt: '2026-09-01T08:00:00.000Z', updatedBy: 'agent' },
  })
}

function outcomeStatus(
  fixture: Awaited<ReturnType<typeof setup>>,
  automationId = 12,
  surfaceId = fixture.surfaceId,
) {
  return AutomationOutcomeStatusesSchema.parse(
    fixture.store.getSurface(surfaceId)?.state[AUTOMATION_OUTCOMES_STATE_KEY],
  )[String(automationId)]
}
