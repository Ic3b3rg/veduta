import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PushStore } from './push-store.ts'

let rootDir: string
let store: PushStore

beforeEach(() => {
  rootDir = mkdtempSync(join(tmpdir(), 'veduta-push-store-'))
  store = new PushStore({ rootDir })
})

afterEach(() => {
  store.close()
})

describe('subscriptions', () => {
  it('round-trips upsert/list', () => {
    expect(store.listSubscriptions()).toEqual([])
    store.upsertSubscription({ endpoint: 'https://push.example/a', p256dh: 'p1', auth: 'a1' })
    store.upsertSubscription({
      endpoint: 'https://push.example/b',
      p256dh: 'p2',
      auth: 'a2',
      deviceId: 'device-1',
    })
    expect(store.listSubscriptions().length).toBe(2)
    expect(store.listSubscriptions()).toEqual([
      { endpoint: 'https://push.example/a', p256dh: 'p1', auth: 'a1' },
      { endpoint: 'https://push.example/b', p256dh: 'p2', auth: 'a2', deviceId: 'device-1' },
    ])
  })

  it('upsert replaces an existing endpoint row, including device binding', () => {
    store.upsertSubscription({
      endpoint: 'https://push.example/a',
      p256dh: 'p1',
      auth: 'a1',
      deviceId: 'device-1',
    })
    store.upsertSubscription({
      endpoint: 'https://push.example/a',
      p256dh: 'p1-new',
      auth: 'a1-new',
    })
    expect(store.listSubscriptions().length).toBe(1)
    expect(store.listSubscriptions()).toEqual([
      { endpoint: 'https://push.example/a', p256dh: 'p1-new', auth: 'a1-new' },
    ])
  })

  it('deletes a subscription by endpoint', () => {
    store.upsertSubscription({ endpoint: 'https://push.example/a', p256dh: 'p1', auth: 'a1' })
    store.deleteSubscription('https://push.example/a')
    expect(store.listSubscriptions().length).toBe(0)
  })

  it('deletes all subscriptions for a device', () => {
    store.upsertSubscription({
      endpoint: 'https://push.example/a',
      p256dh: 'p1',
      auth: 'a1',
      deviceId: 'device-1',
    })
    store.upsertSubscription({
      endpoint: 'https://push.example/b',
      p256dh: 'p2',
      auth: 'a2',
      deviceId: 'device-1',
    })
    store.upsertSubscription({
      endpoint: 'https://push.example/c',
      p256dh: 'p3',
      auth: 'a3',
      deviceId: 'device-2',
    })
    store.deleteSubscriptionsByDevice('device-1')
    expect(store.listSubscriptions().map((s) => s.endpoint)).toEqual(['https://push.example/c'])
  })
})

describe('space attention', () => {
  it('reads zeros when absent', () => {
    expect(store.getAttention('spc-a')).toEqual({ count: 0, revision: 0 })
  })

  it('increments count and revision strictly monotonically per Space', () => {
    expect(store.incrementAttention('spc-a')).toEqual({ count: 1, revision: 1 })
    expect(store.incrementAttention('spc-a')).toEqual({ count: 2, revision: 2 })
    expect(store.incrementAttention('spc-a')).toEqual({ count: 3, revision: 3 })
    expect(store.getAttention('spc-a')).toEqual({ count: 3, revision: 3 })
  })

  it('tracks separate Spaces independently', () => {
    store.incrementAttention('spc-a')
    store.incrementAttention('spc-b')
    store.incrementAttention('spc-b')
    expect(store.getAttention('spc-a')).toEqual({ count: 1, revision: 1 })
    expect(store.getAttention('spc-b')).toEqual({ count: 2, revision: 2 })
  })

  it('clear resets count to 0 and bumps revision', () => {
    store.incrementAttention('spc-a')
    store.incrementAttention('spc-a')
    const cleared = store.clearAttention('spc-a')
    expect(cleared).toEqual({ count: 0, revision: 3 })
    expect(store.getAttention('spc-a')).toEqual({ count: 0, revision: 3 })
  })

  it('clearing an already-zero Space is a no-op returning null', () => {
    expect(store.clearAttention('spc-never-touched')).toBeNull()
    store.incrementAttention('spc-a')
    store.clearAttention('spc-a')
    // Second clear on an already-cleared Space must also no-op.
    expect(store.clearAttention('spc-a')).toBeNull()
    expect(store.getAttention('spc-a')).toEqual({ count: 0, revision: 2 })
  })

  it('increment after clear keeps the revision monotonic', () => {
    store.incrementAttention('spc-a')
    store.clearAttention('spc-a')
    expect(store.incrementAttention('spc-a')).toEqual({ count: 1, revision: 3 })
  })
})

describe('push budget', () => {
  // The budget gate is only reachable through commitPush/flushDeferredItem
  // (the production paths); an empty row list makes commitPush a pure gate.
  const gate = (spaceId: string, day: string, limit: number) =>
    store.commitPush({ spaceId, day, limit, rows: [], now: new Date(`${day}T12:00:00.000Z`) })
      .outcome

  it('respects the limit atomically: limit 1 sends once then degrades', () => {
    expect(gate('spc-a', '2026-07-08', 1)).toBe('sent')
    expect(gate('spc-a', '2026-07-08', 1)).toBe('degraded')
    expect(gate('spc-a', '2026-07-08', 1)).toBe('degraded')
    expect(store.budgetCounters('spc-a', '2026-07-08')).toEqual({ sent: 1, degraded: 2 })
  })

  it('a different day resets the budget', () => {
    gate('spc-a', '2026-07-08', 1)
    gate('spc-a', '2026-07-08', 1)
    expect(gate('spc-a', '2026-07-09', 1)).toBe('sent')
    expect(store.budgetCounters('spc-a', '2026-07-09')).toEqual({ sent: 1, degraded: 0 })
    expect(store.budgetCounters('spc-a', '2026-07-08')).toEqual({ sent: 1, degraded: 1 })
  })

  it('budgetCounters reads zeros when absent', () => {
    expect(store.budgetCounters('spc-never', '2026-07-08')).toEqual({ sent: 0, degraded: 0 })
  })

  it('supports a zero budget: every call degrades', () => {
    expect(gate('spc-a', '2026-07-08', 0)).toBe('degraded')
    expect(store.budgetCounters('spc-a', '2026-07-08')).toEqual({ sent: 0, degraded: 1 })
  })
})

describe('commitPush (atomic budget gate + outbox fan-out)', () => {
  it('sent: consumes budget and inserts one outbox row per given row, returning their ids', () => {
    const now = new Date('2026-07-08T12:00:00.000Z')
    const result = store.commitPush({
      spaceId: 'spc-a',
      day: '2026-07-08',
      limit: 5,
      rows: [
        { endpoint: 'https://push.example/a', title: 't', body: 'b', url: '/' },
        { endpoint: 'https://push.example/b', title: 't', body: 'b', url: '/' },
      ],
      now,
    })
    expect(result.outcome).toBe('sent')
    expect(result.outboxIds).toHaveLength(2)
    expect(store.budgetCounters('spc-a', '2026-07-08')).toEqual({ sent: 1, degraded: 0 })
    const due = store.claimDueOutbox(now)
    expect(due.map((row) => row.id).sort()).toEqual([...result.outboxIds].sort())
  })

  it('degraded: inserts no outbox rows and returns an empty outboxIds', () => {
    const now = new Date('2026-07-08T12:00:00.000Z')
    const result = store.commitPush({
      spaceId: 'spc-a',
      day: '2026-07-08',
      limit: 0,
      rows: [{ endpoint: 'https://push.example/a', title: 't', body: 'b', url: '/' }],
      now,
    })
    expect(result).toEqual({ outcome: 'degraded', outboxIds: [] })
    expect(store.budgetCounters('spc-a', '2026-07-08')).toEqual({ sent: 0, degraded: 1 })
    expect(store.claimDueOutbox(now)).toEqual([])
  })

  it('honors the limit across repeated calls: sends until the limit, then degrades', () => {
    const now = new Date('2026-07-08T12:00:00.000Z')
    const rows = [{ endpoint: 'https://push.example/a', title: 't', body: 'b', url: '/' }]
    expect(
      store.commitPush({ spaceId: 'spc-a', day: '2026-07-08', limit: 1, rows, now }).outcome,
    ).toBe('sent')
    expect(
      store.commitPush({ spaceId: 'spc-a', day: '2026-07-08', limit: 1, rows, now }).outcome,
    ).toBe('degraded')
    expect(store.budgetCounters('spc-a', '2026-07-08')).toEqual({ sent: 1, degraded: 1 })
    // Only the first (sent) call's row landed in the outbox.
    expect(store.claimDueOutbox(now)).toHaveLength(1)
  })
})

// Outbox rows only materialize through commitPush/flushDeferredItem in
// production — tests seed them the same way (unbounded budget, throwaway Space).
function seedOutbox(
  rows: Array<{ endpoint: string; title: string; body: string; url: string }>,
  now: Date,
): number[] {
  return store.commitPush({
    spaceId: 'spc-seed',
    day: now.toISOString().slice(0, 10),
    limit: Number.MAX_SAFE_INTEGER,
    rows,
    now,
  }).outboxIds
}

describe('push outbox', () => {
  it('claims only due rows, honoring next_attempt_at', () => {
    const now = new Date('2026-07-08T12:00:00.000Z')
    seedOutbox([{ endpoint: 'https://push.example/a', title: 't', body: 'b', url: '/' }], now)
    const before = new Date('2026-07-08T11:59:59.000Z')
    expect(store.claimDueOutbox(before)).toEqual([])
    const due = store.claimDueOutbox(now)
    expect(due).toHaveLength(1)
    expect(due[0]).toMatchObject({
      endpoint: 'https://push.example/a',
      title: 't',
      body: 'b',
      url: '/',
      attempts: 0,
    })
  })

  it('writes one row per endpoint', () => {
    const now = new Date('2026-07-08T12:00:00.000Z')
    seedOutbox(
      [
        { endpoint: 'https://push.example/a', title: 't', body: 'b', url: '/' },
        { endpoint: 'https://push.example/b', title: 't', body: 'b', url: '/' },
      ],
      now,
    )
    expect(store.claimDueOutbox(now)).toHaveLength(2)
  })

  it('bumpOutboxAttempt schedules linear backoff: 30s, 60s, 90s, then drops at 5', () => {
    const now = new Date('2026-07-08T12:00:00.000Z')
    seedOutbox([{ endpoint: 'https://push.example/a', title: 't', body: 'b', url: '/' }], now)
    const [row] = store.claimDueOutbox(now)
    const id = row!.id

    expect(store.bumpOutboxAttempt(id, now)).toBe('retry')
    let claimed = store.claimDueOutbox(new Date(now.getTime() + 30_000 - 1))
    expect(claimed).toEqual([])
    claimed = store.claimDueOutbox(new Date(now.getTime() + 30_000))
    expect(claimed).toHaveLength(1)
    expect(claimed[0]!.attempts).toBe(1)

    expect(store.bumpOutboxAttempt(id, now)).toBe('retry')
    claimed = store.claimDueOutbox(new Date(now.getTime() + 60_000))
    expect(claimed).toHaveLength(1)
    expect(claimed[0]!.attempts).toBe(2)

    expect(store.bumpOutboxAttempt(id, now)).toBe('retry')
    claimed = store.claimDueOutbox(new Date(now.getTime() + 90_000))
    expect(claimed).toHaveLength(1)
    expect(claimed[0]!.attempts).toBe(3)

    expect(store.bumpOutboxAttempt(id, now)).toBe('retry')
    expect(store.claimDueOutbox(new Date(now.getTime() + 120_000))[0]!.attempts).toBe(4)

    // 5th bump reaches the max attempts and drops the row.
    expect(store.bumpOutboxAttempt(id, now)).toBe('dropped')
    expect(store.claimDueOutbox(new Date(now.getTime() + 1_000_000))).toEqual([])
  })

  it('bumpOutboxAttempt on an already-deleted row is a no-op drop', () => {
    expect(store.bumpOutboxAttempt(999, new Date())).toBe('dropped')
  })

  it('deleteOutbox removes a row by id', () => {
    const now = new Date('2026-07-08T12:00:00.000Z')
    seedOutbox([{ endpoint: 'https://push.example/a', title: 't', body: 'b', url: '/' }], now)
    const [row] = store.claimDueOutbox(now)
    store.deleteOutbox(row!.id)
    expect(store.claimDueOutbox(now)).toEqual([])
  })

  it('deleteOutboxByEndpoint removes every row for that endpoint', () => {
    const now = new Date('2026-07-08T12:00:00.000Z')
    seedOutbox(
      [
        { endpoint: 'https://push.example/a', title: 't1', body: 'b', url: '/' },
        { endpoint: 'https://push.example/a', title: 't2', body: 'b', url: '/' },
        { endpoint: 'https://push.example/b', title: 't3', body: 'b', url: '/' },
      ],
      now,
    )
    store.deleteOutboxByEndpoint('https://push.example/a')
    const remaining = store.claimDueOutbox(now)
    expect(remaining).toHaveLength(1)
    expect(remaining[0]!.endpoint).toBe('https://push.example/b')
  })

  it('earliestOutboxAttemptAt reflects the soonest pending row, or null when empty', () => {
    expect(store.earliestOutboxAttemptAt()).toBeNull()
    const now = new Date('2026-07-08T12:00:00.000Z')
    seedOutbox([{ endpoint: 'https://push.example/a', title: 't', body: 'b', url: '/' }], now)
    seedOutbox(
      [{ endpoint: 'https://push.example/b', title: 't', body: 'b', url: '/' }],
      new Date(now.getTime() + 60_000),
    )
    expect(store.earliestOutboxAttemptAt()).toEqual(now)
  })

  it('an empty row list leaves the outbox empty', () => {
    seedOutbox([], new Date('2026-07-08T12:00:00.000Z'))
    expect(store.earliestOutboxAttemptAt()).toBeNull()
  })
})

describe('replaceOutbox (atomic digest swap)', () => {
  it('deletes the given ids and inserts the new rows together, leaving no trace of the old ones', () => {
    const now = new Date('2026-07-08T12:00:00.000Z')
    const ids = seedOutbox(
      [
        { endpoint: 'https://push.example/a', title: 'old1', body: 'b', url: '/1' },
        { endpoint: 'https://push.example/b', title: 'old2', body: 'b', url: '/2' },
      ],
      now,
    )
    store.replaceOutbox(
      ids,
      [{ endpoint: 'https://push.example/a', title: 'digest', body: 'b', url: '/' }],
      now,
    )
    const remaining = store.claimDueOutbox(now)
    expect(remaining).toHaveLength(1)
    expect(remaining[0]).toMatchObject({ title: 'digest', endpoint: 'https://push.example/a' })
    expect(remaining.some((row) => ids.includes(row.id))).toBe(false)
  })
})

describe('push deferred (quiet-hours digest queue)', () => {
  it('listDeferred reads every queued row without consuming it', () => {
    const now = new Date('2026-07-08T23:00:00.000Z')
    store.insertDeferred({ spaceId: 'spc-a', title: 't1', body: 'b1', url: '/1' }, now)
    store.insertDeferred({ spaceId: 'spc-b', title: 't2', body: 'b2', url: '/2' }, now)
    expect(store.deferredCount()).toBe(2)

    const listed = store.listDeferred()
    expect(listed).toHaveLength(2)
    expect(listed.map((d) => d.spaceId)).toEqual(['spc-a', 'spc-b'])
    // Read-only: the queue stays intact until flushDeferredItem settles each row.
    expect(store.deferredCount()).toBe(2)
  })
})

describe('flushDeferredItem (atomic per-item flush)', () => {
  it('sent: inserts outbox rows and deletes the deferred row', () => {
    const now = new Date('2026-07-08T23:00:00.000Z')
    store.insertDeferred({ spaceId: 'spc-a', title: 't', body: 'b', url: '/1' }, now)
    const [deferred] = store.listDeferred()

    const result = store.flushDeferredItem(deferred!.id, {
      spaceId: 'spc-a',
      day: '2026-07-08',
      limit: 5,
      rows: [{ endpoint: 'https://push.example/a', title: 't', body: 'b', url: '/1' }],
      now,
    })

    expect(result.outcome).toBe('sent')
    expect(result.outboxIds).toHaveLength(1)
    expect(store.listDeferred()).toEqual([])
    expect(store.claimDueOutbox(now)).toHaveLength(1)
    expect(store.budgetCounters('spc-a', '2026-07-08')).toEqual({ sent: 1, degraded: 0 })
  })

  it('degraded: inserts no outbox rows but still deletes the deferred row', () => {
    const now = new Date('2026-07-08T23:00:00.000Z')
    store.insertDeferred({ spaceId: 'spc-a', title: 't', body: 'b', url: '/1' }, now)
    const [deferred] = store.listDeferred()

    const result = store.flushDeferredItem(deferred!.id, {
      spaceId: 'spc-a',
      day: '2026-07-08',
      limit: 0,
      rows: [{ endpoint: 'https://push.example/a', title: 't', body: 'b', url: '/1' }],
      now,
    })

    expect(result).toEqual({ outcome: 'degraded', outboxIds: [] })
    expect(store.listDeferred()).toEqual([])
    expect(store.claimDueOutbox(now)).toEqual([])
    expect(store.budgetCounters('spc-a', '2026-07-08')).toEqual({ sent: 0, degraded: 1 })
  })
})

describe('persistence across close+reopen', () => {
  it('a new PushStore on the same rootDir sees data written by the previous instance', () => {
    store.upsertSubscription({ endpoint: 'https://push.example/a', p256dh: 'p1', auth: 'a1' })
    store.incrementAttention('spc-a')
    store.commitPush({
      spaceId: 'spc-a',
      day: '2026-07-08',
      limit: 5,
      rows: [{ endpoint: 'https://push.example/a', title: 't', body: 'b', url: '/' }],
      now: new Date('2026-07-08T12:00:00.000Z'),
    })
    store.insertDeferred(
      { spaceId: 'spc-a', title: 't', body: 'b', url: '/' },
      new Date('2026-07-08T12:00:00.000Z'),
    )
    store.close()

    // Reassign the outer `store` so afterEach closes this (still-open)
    // instance instead of double-closing the one above.
    store = new PushStore({ rootDir })
    expect(store.listSubscriptions()).toHaveLength(1)
    expect(store.getAttention('spc-a')).toEqual({ count: 1, revision: 1 })
    expect(store.budgetCounters('spc-a', '2026-07-08')).toEqual({ sent: 1, degraded: 0 })
    expect(store.claimDueOutbox(new Date('2026-07-08T12:00:00.000Z'))).toHaveLength(1)
    expect(store.deferredCount()).toBe(1)
  })
})
