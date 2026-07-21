import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  NotificationCenter,
  type NotificationInput,
  type NotificationStats,
} from './notification-center.ts'
import { NotificationsConfigSchema, type NotificationsConfig } from './notifications-config.ts'
import { PushStore } from './push-store.ts'
import { Store } from './store.ts'
import { untrustedOrigin } from './taint.ts'
import type {
  PushPayload,
  PushSendResult,
  PushSubscriptionInput,
  PushTransport,
} from './web-push-transport.ts'

/** Space seeded by `seedSpaces()` (`seed.ts`): id `spc-health`, slug `health`, name `Health`. */
const HEALTH = 'spc-health'
/** Owned by HEALTH in the seed data — used for deep-link ownership tests. */
const HEALTH_SURFACE = 'srf-goal'

class FakeTransport implements PushTransport {
  calls: Array<{ subscription: PushSubscriptionInput; payload: PushPayload }> = []
  results: PushSendResult[] = []
  /** When true, `send()` never resolves — lets a test inspect the outbox mid-delivery. */
  hang = false

  async send(subscription: PushSubscriptionInput, payload: PushPayload): Promise<PushSendResult> {
    this.calls.push({ subscription, payload })
    if (this.hang) return new Promise(() => {})
    return this.results.shift() ?? 'ok'
  }
}

/** Lets pending microtasks (the fire-and-forget delivery pass) settle before assertions. */
function flushAsync(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

function pushInput(
  overrides: Partial<Extract<NotificationInput, { level: 'push' }>> = {},
): NotificationInput {
  return {
    level: 'push',
    spaceId: HEALTH,
    text: 'Something happened',
    justification: 'because the Agent decided so',
    ...overrides,
  }
}

let rootDir: string
let clock: Date
const now = () => new Date(clock.getTime())

let store: Store
let pushStore: PushStore
let transport: FakeTransport
let attentionCalls: Array<{ spaceId: string; count: number; revision: number }>
let statsEmits: number

function config(overrides: Partial<NotificationsConfig> = {}): NotificationsConfig {
  return NotificationsConfigSchema.parse({
    defaultDailyPushBudget: 3,
    spaceBudgets: {},
    quietHours: null,
    digestThreshold: 3,
    timezone: 'UTC',
    ...overrides,
  })
}

function newCenter(overrides: Partial<NotificationsConfig> = {}): NotificationCenter {
  return new NotificationCenter({
    store,
    pushStore,
    transport,
    config: config(overrides),
    now,
    onAttention: (spaceId, count, revision) => attentionCalls.push({ spaceId, count, revision }),
    onStats: () => {
      statsEmits += 1
    },
  })
}

function addSubscription(endpoint = 'https://push.example/a'): void {
  pushStore.upsertSubscription({ endpoint, p256dh: 'p1', auth: 'a1' })
}

function notificationEvents(spaceId: string) {
  return store.eventLog(spaceId).filter((event) => event.type === 'notification')
}

function seenEvents(spaceId: string) {
  return store.eventLog(spaceId).filter((event) => event.type === 'notification.seen')
}

beforeEach(() => {
  rootDir = mkdtempSync(join(tmpdir(), 'veduta-notification-center-'))
  clock = new Date('2026-07-08T12:00:00.000Z')
  store = new Store({ rootDir, now })
  pushStore = new PushStore({ rootDir })
  transport = new FakeTransport()
  attentionCalls = []
  statsEmits = 0
})

afterEach(() => {
  pushStore.close()
  rmSync(rootDir, { recursive: true, force: true })
})

describe('badge', () => {
  it('increments attention, appends one notification event, and sends nothing', () => {
    const center = newCenter()
    center.notify({ level: 'badge', spaceId: HEALTH, text: 'Groceries updated' })

    expect(attentionCalls).toEqual([{ spaceId: HEALTH, count: 1, revision: 1 }])
    expect(transport.calls).toHaveLength(0)

    const events = notificationEvents(HEALTH)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      origin: 'trusted:system',
      payload: { level: 'badge', outcome: 'badge' },
    })
    expect(events[0]?.text).toContain('Groceries updated')
    center.dispose()
  })
})

describe('push - happy path, taint and deep links', () => {
  it('fans a push out to every subscription and logs one decision event with justification/url/automationId', async () => {
    const center = newCenter({ defaultDailyPushBudget: 5 })
    addSubscription('https://push.example/a')
    addSubscription('https://push.example/b')

    center.notify(
      pushInput({
        text: 'A'.repeat(200),
        justification: 'Agent-armed timer reached its deadline',
        automationId: 42,
        surfaceId: HEALTH_SURFACE,
      }),
    )
    await flushAsync()

    expect(transport.calls).toHaveLength(2)
    for (const call of transport.calls) {
      expect(call.payload.title).toBe('Health')
      expect(call.payload.body).toBe('A'.repeat(140))
      expect(call.payload.url).toBe('/app/space/health/surface/srf-goal')
    }

    expect(attentionCalls).toEqual([{ spaceId: HEALTH, count: 1, revision: 1 }])

    const events = notificationEvents(HEALTH)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      origin: 'trusted:system',
      payload: {
        level: 'push',
        outcome: 'push',
        justification: 'Agent-armed timer reached its deadline',
        url: '/app/space/health/surface/srf-goal',
        automationId: 42,
      },
    })
    center.dispose()
  })

  it('throws a TypeError for an empty justification, before any state changes', () => {
    const center = newCenter()
    expect(() => center.notify(pushInput({ justification: '   ' }))).toThrow(TypeError)
    expect(attentionCalls).toHaveLength(0)
    expect(notificationEvents(HEALTH)).toHaveLength(0)
    center.dispose()
  })

  it('ignores a surfaceId owned by a different Space and falls back to url "/"', async () => {
    const work = store.spacesEngine.createSpace({ name: 'Work' })
    const center = newCenter({ defaultDailyPushBudget: 5 })
    addSubscription()

    center.notify(pushInput({ spaceId: work.id, surfaceId: HEALTH_SURFACE }))
    await flushAsync()

    expect(transport.calls).toHaveLength(1)
    expect(transport.calls[0]?.payload.url).toBe('/')
    const events = notificationEvents(work.id)
    expect(events[0]?.payload?.['url']).toBe('/')
    center.dispose()
  })

  it('falls back to url "/" when no surfaceId is given', async () => {
    const center = newCenter({ defaultDailyPushBudget: 5 })
    addSubscription()
    center.notify(pushInput())
    await flushAsync()
    expect(transport.calls[0]?.payload.url).toBe('/')
    center.dispose()
  })

  it('untrusted origin gets a generic body, but the decision event keeps the untrusted origin', async () => {
    const center = newCenter({ defaultDailyPushBudget: 5 })
    addSubscription()
    center.notify(pushInput({ origin: untrustedOrigin('gmail'), text: 'Sensitive raw content' }))
    await flushAsync()

    expect(transport.calls[0]?.payload.body).toBe('New update in Health')
    expect(transport.calls[0]?.payload.body).not.toContain('Sensitive raw content')

    const events = notificationEvents(HEALTH)
    expect(events[0]?.origin).toBe('untrusted:gmail')
    center.dispose()
  })
})

describe('interruption budget', () => {
  it('a limit of 1 sends once then degrades, while attention keeps incrementing', async () => {
    const center = newCenter({ defaultDailyPushBudget: 1 })
    addSubscription()

    center.notify(pushInput({ text: 'first' }))
    await flushAsync()
    expect(transport.calls).toHaveLength(1)

    center.notify(pushInput({ text: 'second' }))
    await flushAsync()
    expect(transport.calls).toHaveLength(1)

    expect(attentionCalls).toEqual([
      { spaceId: HEALTH, count: 1, revision: 1 },
      { spaceId: HEALTH, count: 2, revision: 2 },
    ])

    const events = notificationEvents(HEALTH)
    expect(events).toHaveLength(2)
    expect(events[0]?.payload?.['outcome']).toBe('push')
    expect(events[1]?.payload?.['outcome']).toBe('degraded')
    center.dispose()
  })
})

describe('quiet hours', () => {
  const QUIET_WINDOW = { start: '22:00', end: '08:00' }

  it('defers a non-urgent push, consumes no budget, and sends nothing', () => {
    clock = new Date('2026-07-08T23:00:00.000Z') // inside the 22:00-08:00 window
    const center = newCenter({ quietHours: QUIET_WINDOW, defaultDailyPushBudget: 5 })
    addSubscription()

    center.notify(pushInput())

    expect(transport.calls).toHaveLength(0)
    expect(pushStore.deferredCount()).toBe(1)
    expect(pushStore.budgetCounters(HEALTH, '2026-07-08')).toEqual({ sent: 0, degraded: 0 })
    expect(attentionCalls).toEqual([{ spaceId: HEALTH, count: 1, revision: 1 }])

    const events = notificationEvents(HEALTH)
    expect(events[0]?.payload?.['outcome']).toBe('queued')
    center.dispose()
  })

  it('urgent pushes bypass the quiet window and are sent immediately', async () => {
    clock = new Date('2026-07-08T23:00:00.000Z')
    const center = newCenter({ quietHours: QUIET_WINDOW, defaultDailyPushBudget: 5 })
    addSubscription()

    center.notify(pushInput({ urgent: true }))
    await flushAsync()

    expect(transport.calls).toHaveLength(1)
    expect(pushStore.deferredCount()).toBe(0)
    expect(pushStore.budgetCounters(HEALTH, '2026-07-08')).toEqual({ sent: 1, degraded: 0 })
    center.dispose()
  })
})

describe('digest flush', () => {
  it('flushes deferred items at or below the digest threshold as individual pushes', async () => {
    const center = newCenter({ digestThreshold: 3, defaultDailyPushBudget: 5, quietHours: null })
    addSubscription()
    pushStore.insertDeferred(
      { spaceId: HEALTH, title: 'Health', body: 'update 1', url: '/1' },
      now(),
    )
    pushStore.insertDeferred(
      { spaceId: HEALTH, title: 'Health', body: 'update 2', url: '/2' },
      now(),
    )

    center.start()
    await flushAsync()

    expect(transport.calls).toHaveLength(2)
    expect(transport.calls.map((call) => call.payload.body).sort()).toEqual([
      'update 1',
      'update 2',
    ])
    expect(pushStore.budgetCounters(HEALTH, '2026-07-08')).toEqual({ sent: 2, degraded: 0 })
    center.dispose()
  })

  it('coalesces more-than-threshold survivors into exactly one digest push per subscription', async () => {
    const center = newCenter({ digestThreshold: 3, defaultDailyPushBudget: 10, quietHours: null })
    addSubscription('https://push.example/a')
    addSubscription('https://push.example/b')
    for (let i = 0; i < 4; i += 1) {
      pushStore.insertDeferred(
        { spaceId: HEALTH, title: 'Health', body: `update ${i}`, url: `/${i}` },
        now(),
      )
    }

    center.start()
    await flushAsync()

    expect(transport.calls).toHaveLength(2) // one digest per subscription, not one per survivor
    for (const call of transport.calls) {
      expect(call.payload).toEqual({
        title: 'Veduta',
        body: '4 updates while you were away',
        url: '/',
      })
    }
    center.dispose()
  })

  it('the digest swap replaces every individual outbox row with exactly one row per subscription', () => {
    const center = newCenter({ digestThreshold: 3, defaultDailyPushBudget: 10, quietHours: null })
    addSubscription('https://push.example/a')
    addSubscription('https://push.example/b')
    for (let i = 0; i < 4; i += 1) {
      pushStore.insertDeferred(
        { spaceId: HEALTH, title: 'Health', body: `update ${i}`, url: `/${i}` },
        now(),
      )
    }
    // A transport that never resolves: `deliverPending`'s fire-and-forget
    // pass claims the outbox but stalls on the first send, so the table
    // still reflects the digest swap's outcome when inspected below,
    // before any row has actually been delivered or deleted.
    transport.hang = true

    center.start()

    const rows = pushStore.claimDueOutbox(now())
    expect(rows).toHaveLength(2) // one digest row per subscription, not one per survivor
    expect(rows.map((row) => row.endpoint).sort()).toEqual([
      'https://push.example/a',
      'https://push.example/b',
    ])
    for (const row of rows) {
      expect(row).toMatchObject({ title: 'Veduta', body: '4 updates while you were away' })
    }
    // None of the four individual per-survivor rows remain.
    expect(rows.some((row) => row.body.startsWith('update '))).toBe(false)
    center.dispose()
  })

  it('a zero-budget Space degrades at flush, silently, and never enters the digest count', async () => {
    const center = newCenter({
      digestThreshold: 3,
      defaultDailyPushBudget: 5,
      spaceBudgets: { 'spc-zero-budget': 0 },
      quietHours: null,
    })
    addSubscription()
    pushStore.insertDeferred({ spaceId: HEALTH, title: 'Health', body: 'a', url: '/a' }, now())
    pushStore.insertDeferred({ spaceId: HEALTH, title: 'Health', body: 'b', url: '/b' }, now())
    pushStore.insertDeferred({ spaceId: HEALTH, title: 'Health', body: 'c', url: '/c' }, now())
    pushStore.insertDeferred(
      { spaceId: 'spc-zero-budget', title: 'Zero', body: 'z', url: '/z' },
      now(),
    )

    center.start()
    await flushAsync()

    // 3 survivors (<= threshold): individual sends, the zero-budget item excluded.
    expect(transport.calls).toHaveLength(3)
    expect(transport.calls.map((call) => call.payload.body).sort()).toEqual(['a', 'b', 'c'])
    expect(pushStore.budgetCounters('spc-zero-budget', '2026-07-08')).toEqual({
      sent: 0,
      degraded: 1,
    })
    center.dispose()
  })

  it('boot start() with deferred rows outside the quiet window flushes immediately', async () => {
    clock = new Date('2026-07-08T12:00:00.000Z') // well outside 22:00-08:00
    pushStore.insertDeferred(
      { spaceId: HEALTH, title: 'Health', body: 'catch-up', url: '/x' },
      now(),
    )
    addSubscription()
    const center = newCenter({
      quietHours: { start: '22:00', end: '08:00' },
      defaultDailyPushBudget: 5,
      digestThreshold: 3,
    })

    center.start()
    await flushAsync()

    expect(transport.calls).toHaveLength(1)
    expect(transport.calls[0]?.payload.body).toBe('catch-up')
    expect(pushStore.deferredCount()).toBe(0)
    center.dispose()
  })
})

describe('outbox delivery', () => {
  it('deletes the subscription and outbox rows for a "gone" endpoint', async () => {
    const center = newCenter({ defaultDailyPushBudget: 5 })
    addSubscription()
    transport.results = ['gone']

    center.notify(pushInput())
    await flushAsync()

    expect(transport.calls).toHaveLength(1)
    expect(pushStore.listSubscriptions()).toEqual([])
    expect(pushStore.claimDueOutbox(new Date(clock.getTime() + 1))).toEqual([])
    center.dispose()
  })

  it('retries a transient error via bumped next_attempt_at, then succeeds', async () => {
    const center = newCenter({ defaultDailyPushBudget: 5 })
    addSubscription()
    transport.results = ['error']

    center.notify(pushInput())
    await flushAsync()
    center.dispose()
    expect(transport.calls).toHaveLength(1)
    expect(pushStore.claimDueOutbox(new Date(clock.getTime() + 1))).toEqual([]) // not yet due

    transport.results = ['ok']
    clock = new Date(clock.getTime() + 31_000)
    center.start()
    await flushAsync()

    expect(transport.calls).toHaveLength(2)
    expect(pushStore.claimDueOutbox(new Date(clock.getTime() + 1))).toEqual([])
    center.dispose()
  })

  it('drops the row after exhausting attempts, warning with the hostname only', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const center = newCenter({ defaultDailyPushBudget: 5 })
    addSubscription()
    transport.results = ['error', 'error', 'error', 'error', 'error']

    center.notify(pushInput())
    await flushAsync()
    center.dispose()
    expect(transport.calls).toHaveLength(1)

    for (let i = 0; i < 4; i += 1) {
      clock = new Date(clock.getTime() + 130_000)
      center.start()
      await flushAsync()
      center.dispose()
    }

    expect(transport.calls).toHaveLength(5)
    expect(pushStore.claimDueOutbox(new Date(clock.getTime() + 1_000_000))).toEqual([])
    expect(warn).toHaveBeenCalled()
    const lastWarning = warn.mock.calls.at(-1)?.[0]
    expect(String(lastWarning)).not.toContain('https://push.example/a')
    expect(String(lastWarning)).toContain('push.example')
    warn.mockRestore()
  })

  it('single-flight: two rapid notify() calls never double-send the same outbox row', async () => {
    const center = newCenter({ defaultDailyPushBudget: 5 })
    addSubscription()

    center.notify(pushInput({ text: 'first' }))
    center.notify(pushInput({ text: 'second' }))
    await flushAsync()

    // The second notify()'s delivery pass no-ops (single-flight guard) — only the
    // first row is sent this tick; the second is still queued in the outbox.
    expect(transport.calls).toHaveLength(1)
    expect(pushStore.claimDueOutbox(new Date(clock.getTime() + 1))).toHaveLength(1)

    center.start()
    await flushAsync()

    expect(transport.calls).toHaveLength(2)
    expect(new Set(transport.calls.map((call) => call.payload.body)).size).toBe(2)
    center.dispose()
  })
})

describe('markSeen', () => {
  it('is a no-op returning null when attention is already zero', () => {
    const center = newCenter()
    expect(center.markSeen(HEALTH)).toBeNull()
    expect(seenEvents(HEALTH)).toHaveLength(0)
    expect(attentionCalls).toHaveLength(0)
    center.dispose()
  })

  it('clears attention, appends notification.seen, and emits onAttention', () => {
    const center = newCenter()
    center.notify({ level: 'badge', spaceId: HEALTH, text: 'x' })
    attentionCalls = []

    const result = center.markSeen(HEALTH)

    expect(result).toEqual({ count: 0, revision: 2 })
    expect(attentionCalls).toEqual([{ spaceId: HEALTH, count: 0, revision: 2 }])
    const events = seenEvents(HEALTH)
    expect(events).toHaveLength(1)
    expect(events[0]?.origin).toBe('trusted:user')
    center.dispose()
  })
})

describe('stats', () => {
  it('covers every non-archived Space, zeros included, scoped to the configured-timezone day', () => {
    const work = store.spacesEngine.createSpace({ name: 'Work' })
    const center = newCenter({ defaultDailyPushBudget: 5 })
    addSubscription()

    center.notify(pushInput({ text: 'sent one' }))

    const stats: NotificationStats = center.stats()
    expect(stats.perSpace).toEqual(
      expect.arrayContaining([
        { spaceId: HEALTH, sentToday: 1, degradedToday: 0 },
        { spaceId: work.id, sentToday: 0, degradedToday: 0 },
      ]),
    )
    expect(stats.queuedCount).toBe(0)
    center.dispose()
  })

  it('resets sentToday on the next configured-timezone day', () => {
    const center = newCenter({ defaultDailyPushBudget: 5 })
    addSubscription()
    center.notify(pushInput())
    expect(center.stats().perSpace.find((s) => s.spaceId === HEALTH)?.sentToday).toBe(1)

    clock = new Date(clock.getTime() + 24 * 60 * 60 * 1000)
    expect(center.stats().perSpace.find((s) => s.spaceId === HEALTH)?.sentToday).toBe(0)
    center.dispose()
  })

  it('queuedCount reflects the deferred queue', () => {
    const center = newCenter({
      quietHours: { start: '22:00', end: '08:00' },
      defaultDailyPushBudget: 5,
    })
    clock = new Date('2026-07-08T23:00:00.000Z')
    addSubscription()
    center.notify(pushInput())
    expect(center.stats().queuedCount).toBe(1)
    center.dispose()
  })
})

describe('onStats coalescing', () => {
  it('emits once for a synchronous burst of notify() calls', async () => {
    const center = newCenter({ defaultDailyPushBudget: 5 })
    addSubscription()

    center.notify(pushInput({ text: 'a' }))
    center.notify(pushInput({ text: 'b' }))
    expect(statsEmits).toBe(0) // not yet flushed — still inside the synchronous burst

    await Promise.resolve()
    expect(statsEmits).toBe(1)

    await flushAsync()
    center.dispose()
  })
})
