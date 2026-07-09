import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EventQueue } from './event-queue.ts'
import type { ExternalEvent } from './external-event.ts'

const event = (overrides: Partial<ExternalEvent> = {}): ExternalEvent => ({
  source: 'mail',
  kind: 'email',
  externalId: 'msg-1',
  type: 'message.received',
  sender: 'anna@example.com',
  ...overrides,
})

describe('EventQueue', () => {
  let rootDir: string
  let clock: Date
  let queue: EventQueue

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'veduta-queue-'))
    clock = new Date('2026-07-09T10:00:00Z')
    queue = new EventQueue({ rootDir, now: () => clock })
  })

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true })
  })

  it('queues an event and records the decision', () => {
    const outcome = queue.ingest(event(), { spaceId: 'spc-health', ratePerMinute: 10 })
    expect(outcome).toEqual({ outcome: 'queued', queueId: 1 })
    expect(queue.getEvent(1)?.status).toBe('pending')
    expect(queue.decisions('mail').map((d) => d.outcome)).toEqual(['queued'])
  })

  it('dedups on (source, externalId) but keeps the attempt in the decision log', () => {
    queue.ingest(event(), { spaceId: 'spc-health', ratePerMinute: 10 })
    const replay = queue.ingest(event(), { spaceId: 'spc-health', ratePerMinute: 10 })
    expect(replay).toEqual({ outcome: 'duplicate', queueId: 1 })
    expect(queue.listEvents('mail')).toHaveLength(1)
    expect(queue.decisions('mail').map((d) => d.outcome)).toEqual(['queued', 'duplicate'])
  })

  it('keeps the same externalId from different sources distinct', () => {
    queue.ingest(event(), { spaceId: 'spc-health', ratePerMinute: 10 })
    const other = queue.ingest(event({ source: 'crm' }), {
      spaceId: 'spc-health',
      ratePerMinute: 10,
    })
    expect(other.outcome).toBe('queued')
    expect(queue.listEvents()).toHaveLength(2)
  })

  it('rate-limits per source over a rolling 60s window, counting duplicates as attempts', () => {
    queue.ingest(event({ externalId: 'a' }), { spaceId: 'spc-health', ratePerMinute: 2 })
    queue.ingest(event({ externalId: 'a' }), { spaceId: 'spc-health', ratePerMinute: 2 })
    const third = queue.ingest(event({ externalId: 'b' }), {
      spaceId: 'spc-health',
      ratePerMinute: 2,
    })
    expect(third).toEqual({ outcome: 'rate-limited' })
    expect(queue.listEvents('mail')).toHaveLength(1)

    clock = new Date(clock.getTime() + 61_000)
    const later = queue.ingest(event({ externalId: 'b' }), {
      spaceId: 'spc-health',
      ratePerMinute: 2,
    })
    expect(later.outcome).toBe('queued')
  })

  it('does not let one noisy source consume another source quota', () => {
    queue.ingest(event({ externalId: 'a' }), { spaceId: 'spc-health', ratePerMinute: 1 })
    const other = queue.ingest(event({ source: 'crm', externalId: 'a' }), {
      spaceId: 'spc-health',
      ratePerMinute: 1,
    })
    expect(other.outcome).toBe('queued')
  })

  it('bypasses the rate limit for authenticated fetch stages', () => {
    queue.ingest(event({ externalId: 'a' }), { spaceId: 'spc-health', ratePerMinute: 1 })
    const fetched = queue.ingest(event({ externalId: 'b' }), {
      spaceId: 'spc-health',
      ratePerMinute: 1,
      bypassRateLimit: true,
    })
    expect(fetched.outcome).toBe('queued')
  })

  it('applies verdicts durably with reasons', () => {
    const queued = queue.ingest(event(), { spaceId: 'spc-health', ratePerMinute: 10 })
    if (queued.outcome !== 'queued') throw new Error('expected queued')
    const discarded = queue.decide(queued.queueId, { verdict: 'discard', reason: 'newsletter' })
    expect(discarded.status).toBe('discarded')
    expect(discarded.discardReason).toBe('newsletter')
    expect(queue.decisions('mail').at(-1)?.reason).toBe('newsletter')
  })

  it('tracks accepted-but-undelivered rows for boot recovery', () => {
    const queued = queue.ingest(event(), { spaceId: 'spc-health', ratePerMinute: 10 })
    if (queued.outcome !== 'queued') throw new Error('expected queued')
    queue.decide(queued.queueId, { verdict: 'accept' })
    expect(queue.undeliveredAccepted().map((row) => row.id)).toEqual([queued.queueId])
    queue.markDelivered(queued.queueId)
    expect(queue.undeliveredAccepted()).toEqual([])
  })

  it('lists pending rows so an interrupted pipeline is re-decided at boot', () => {
    queue.ingest(event(), { spaceId: 'spc-health', ratePerMinute: 10 })
    expect(queue.pendingEvents().map((row) => row.status)).toEqual(['pending'])
  })

  it('advances the source cursor atomically with a batch', () => {
    const outcomes = queue.ingestBatch(
      [
        { event: event({ externalId: 'h-1' }), spaceId: 'spc-health' },
        { event: event({ externalId: 'h-2' }), spaceId: 'spc-health' },
      ],
      { source: 'mail', value: '10042' },
    )
    expect(outcomes.map((o) => o.outcome)).toEqual(['queued', 'queued'])
    expect(queue.cursor('mail')).toBe('10042')
  })

  it('aggregates refusals into hourly counters, not rows', () => {
    queue.recordRefusal('mail', 'verification-rejected')
    queue.recordRefusal('mail', 'verification-rejected')
    queue.recordRefusal('mail', 'rate-limited')
    expect(queue.refusalCount('mail')).toBe(3)
    expect(queue.refusalCount('mail', 'verification-rejected')).toBe(2)
    expect(queue.refusalCount('mail', 'rate-limited')).toBe(1)
    expect(queue.decisions('mail')).toEqual([])
    expect(queue.refusalCount('crm')).toBe(0)
  })

  it('never lets refused attempts consume the quota they enforce (no livelock)', () => {
    queue.ingest(event({ externalId: 'a' }), { spaceId: 'spc-health', ratePerMinute: 1 })
    // A provider retrying every few seconds must not keep the window full.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      clock = new Date(clock.getTime() + 10_000)
      const refused = queue.ingest(event({ externalId: 'b' }), {
        spaceId: 'spc-health',
        ratePerMinute: 1,
      })
      expect(refused.outcome).toBe('rate-limited')
    }
    clock = new Date(clock.getTime() + 20_000) // first attempt now outside the window
    const recovered = queue.ingest(event({ externalId: 'b' }), {
      spaceId: 'spc-health',
      ratePerMinute: 1,
    })
    expect(recovered.outcome).toBe('queued')
  })

  it('survives a reopen: rows and cursors persist', () => {
    queue.ingest(event(), { spaceId: 'spc-health', ratePerMinute: 10 })
    queue.setCursor('mail', '7')
    const reopened = new EventQueue({ rootDir, now: () => clock })
    expect(reopened.listEvents('mail')).toHaveLength(1)
    expect(reopened.cursor('mail')).toBe('7')
  })
})
