import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  optionalString,
  requiredNumber,
  requiredString,
  withImmediateTransaction,
} from './sqlite-rows.ts'

/**
 * Durable storage for outbound Web Push (issue #18, ADR-0005 persistence
 * idiom): subscriptions, per-Space attention, per-Space daily push budget,
 * the delivery outbox, and the quiet-hours digest queue. Deliberately a
 * dumb store — no notification policy lives here (see `notification-center.ts`);
 * this file only knows how to read and write its own tables.
 */

export interface SubscriptionRow {
  endpoint: string
  p256dh: string
  auth: string
  deviceId?: string
}

export interface AttentionState {
  count: number
  revision: number
}

export interface BudgetCounters {
  sent: number
  degraded: number
}

export interface OutboxRow {
  id: number
  endpoint: string
  title: string
  body: string
  url: string
  attempts: number
  nextAttemptAt: string
  createdAt: string
}

export interface DeferredRow {
  id: number
  spaceId: string
  title: string
  body: string
  url: string
  createdAt: string
}

export interface PushStoreOptions {
  rootDir: string
}

/** Linear backoff step for outbox retries (decision 6): 30s, 60s, 90s, ... */
const OUTBOX_BACKOFF_STEP_MS = 30 * 1000
/** Attempts at which an undelivered outbox row is dropped (decision 6). */
const OUTBOX_MAX_ATTEMPTS = 5

export class PushStore {
  private readonly db: DatabaseSync

  constructor(options: PushStoreOptions) {
    mkdirSync(options.rootDir, { recursive: true })
    this.db = new DatabaseSync(join(options.rootDir, 'push.sqlite'))
    this.initializeSchema()
  }

  // --- subscriptions ---

  upsertSubscription(input: {
    endpoint: string
    p256dh: string
    auth: string
    deviceId?: string
  }): void {
    this.db
      .prepare(
        `insert into subscriptions (endpoint, p256dh, auth, device_id, created_at)
         values (?, ?, ?, ?, ?)
         on conflict(endpoint) do update set
           p256dh = excluded.p256dh,
           auth = excluded.auth,
           device_id = excluded.device_id`,
      )
      .run(
        input.endpoint,
        input.p256dh,
        input.auth,
        input.deviceId ?? null,
        new Date().toISOString(),
      )
  }

  deleteSubscription(endpoint: string): void {
    this.db.prepare('delete from subscriptions where endpoint = ?').run(endpoint)
  }

  deleteSubscriptionsByDevice(deviceId: string): void {
    this.db.prepare('delete from subscriptions where device_id = ?').run(deviceId)
  }

  listSubscriptions(): SubscriptionRow[] {
    const rows = this.db.prepare('select * from subscriptions order by endpoint').all()
    return rows.map(subscriptionFromRow)
  }

  // --- attention ---

  /** Strictly monotonic per Space: every call bumps the revision, even the first. */
  incrementAttention(spaceId: string): AttentionState {
    return withImmediateTransaction(this.db, () => {
      const current = this.readAttention(spaceId)
      const next = { count: current.count + 1, revision: current.revision + 1 }
      this.writeAttention(spaceId, next)
      return next
    })
  }

  getAttention(spaceId: string): AttentionState {
    return this.readAttention(spaceId)
  }

  /** No-op (returns null) when count is already 0 — clearing must never fabricate a change. */
  clearAttention(spaceId: string): AttentionState | null {
    return withImmediateTransaction(this.db, () => {
      const current = this.readAttention(spaceId)
      if (current.count === 0) return null
      const next = { count: 0, revision: current.revision + 1 }
      this.writeAttention(spaceId, next)
      return next
    })
  }

  // --- budget ---

  budgetCounters(spaceId: string, day: string): BudgetCounters {
    return this.readBudgetCounters(spaceId, day)
  }

  /**
   * Crash-durable push commit (plan decision 5/6): the budget gate and the
   * per-endpoint outbox fan-out land in ONE transaction, so a crash can
   * never consume budget without materializing the delivery rows.
   */
  commitPush(input: {
    spaceId: string
    day: string
    limit: number
    rows: Array<{ endpoint: string; title: string; body: string; url: string }>
    now: Date
  }): { outcome: 'sent' | 'degraded'; outboxIds: number[] } {
    return withImmediateTransaction(this.db, () => {
      const outcome = this.consumePushUnguarded(input.spaceId, input.day, input.limit)
      if (outcome === 'degraded') return { outcome, outboxIds: [] }
      return { outcome, outboxIds: this.insertOutboxUnguarded(input.rows, input.now) }
    })
  }

  // --- outbox ---

  /** Atomic digest swap (plan decision 7): the individual rows leave and the digest rows land together. */
  replaceOutbox(
    ids: number[],
    rows: Array<{ endpoint: string; title: string; body: string; url: string }>,
    now: Date,
  ): void {
    withImmediateTransaction(this.db, () => {
      const statement = this.db.prepare('delete from push_outbox where id = ?')
      for (const id of ids) statement.run(id)
      this.insertOutboxUnguarded(rows, now)
    })
  }

  /**
   * A plain SELECT, not a persisted lease: the daemon is single-process and
   * the NotificationCenter's single-flight guard already prevents
   * overlapping delivery passes, so a lease would be dead weight.
   */
  claimDueOutbox(now: Date): OutboxRow[] {
    const rows = this.db
      .prepare('select * from push_outbox where next_attempt_at <= ? order by id')
      .all(now.toISOString())
    return rows.map(outboxFromRow)
  }

  deleteOutbox(id: number): void {
    this.db.prepare('delete from push_outbox where id = ?').run(id)
  }

  /** attempts+1; drop (delete) at >= 5, else reschedule with linear backoff (30s * attempts). */
  bumpOutboxAttempt(id: number, now: Date): 'retry' | 'dropped' {
    return withImmediateTransaction(this.db, () => {
      const row = this.db.prepare('select * from push_outbox where id = ?').get(id)
      if (!row) return 'dropped'
      const attempts = requiredNumber(row, 'attempts') + 1
      if (attempts >= OUTBOX_MAX_ATTEMPTS) {
        this.db.prepare('delete from push_outbox where id = ?').run(id)
        return 'dropped'
      }
      const nextAttemptAt = new Date(
        now.getTime() + OUTBOX_BACKOFF_STEP_MS * attempts,
      ).toISOString()
      this.db
        .prepare('update push_outbox set attempts = ?, next_attempt_at = ? where id = ?')
        .run(attempts, nextAttemptAt, id)
      return 'retry'
    })
  }

  earliestOutboxAttemptAt(): Date | null {
    const row = this.db.prepare('select min(next_attempt_at) as next from push_outbox').get()
    const next = row ? optionalString(row, 'next') : undefined
    return next === undefined ? null : new Date(next)
  }

  deleteOutboxByEndpoint(endpoint: string): void {
    this.db.prepare('delete from push_outbox where endpoint = ?').run(endpoint)
  }

  // --- deferred (quiet-hours digest queue) ---

  insertDeferred(
    input: { spaceId: string; title: string; body: string; url: string },
    now: Date,
  ): void {
    this.db
      .prepare(
        `insert into push_deferred (space_id, title, body, url, created_at)
         values (?, ?, ?, ?, ?)`,
      )
      .run(input.spaceId, input.title, input.body, input.url, now.toISOString())
  }

  /** Read-only: rows stay queued until `flushDeferredItem` settles each one. */
  listDeferred(): DeferredRow[] {
    return this.db.prepare('select * from push_deferred order by id').all().map(deferredFromRow)
  }

  /**
   * Crash-durable per-item flush (plan decision 7): budget gate, outbox
   * fan-out (when the gate passes), and the deferred row's deletion land in
   * ONE transaction — a crash mid-flush leaves the unprocessed remainder of
   * the queue intact instead of losing it wholesale.
   */
  flushDeferredItem(
    deferredId: number,
    input: {
      spaceId: string
      day: string
      limit: number
      rows: Array<{ endpoint: string; title: string; body: string; url: string }>
      now: Date
    },
  ): { outcome: 'sent' | 'degraded'; outboxIds: number[] } {
    return withImmediateTransaction(this.db, () => {
      const outcome = this.consumePushUnguarded(input.spaceId, input.day, input.limit)
      const outboxIds = outcome === 'sent' ? this.insertOutboxUnguarded(input.rows, input.now) : []
      this.db.prepare('delete from push_deferred where id = ?').run(deferredId)
      return { outcome, outboxIds }
    })
  }

  deferredCount(): number {
    const row = this.db.prepare('select count(*) as n from push_deferred').get()
    return row ? requiredNumber(row, 'n') : 0
  }

  close(): void {
    this.db.close()
  }

  // --- internals ---

  /** Must run inside a caller-held transaction. */
  private consumePushUnguarded(spaceId: string, day: string, limit: number): 'sent' | 'degraded' {
    const counters = this.readBudgetCounters(spaceId, day)
    if (counters.sent < limit) {
      this.writeBudgetCounters(spaceId, day, { ...counters, sent: counters.sent + 1 })
      return 'sent'
    }
    this.writeBudgetCounters(spaceId, day, { ...counters, degraded: counters.degraded + 1 })
    return 'degraded'
  }

  /** Must run inside a caller-held transaction. Returns the inserted row ids. */
  private insertOutboxUnguarded(
    rows: Array<{ endpoint: string; title: string; body: string; url: string }>,
    now: Date,
  ): number[] {
    const at = now.toISOString()
    const statement = this.db.prepare(
      `insert into push_outbox (endpoint, title, body, url, attempts, next_attempt_at, created_at)
       values (?, ?, ?, ?, 0, ?, ?)`,
    )
    const ids: number[] = []
    for (const row of rows) {
      const result = statement.run(row.endpoint, row.title, row.body, row.url, at, at)
      ids.push(Number(result.lastInsertRowid))
    }
    return ids
  }

  private readAttention(spaceId: string): AttentionState {
    const row = this.db.prepare('select * from space_attention where space_id = ?').get(spaceId)
    if (!row) return { count: 0, revision: 0 }
    return { count: requiredNumber(row, 'count'), revision: requiredNumber(row, 'revision') }
  }

  private writeAttention(spaceId: string, state: AttentionState): void {
    this.db
      .prepare(
        `insert into space_attention (space_id, count, revision) values (?, ?, ?)
         on conflict(space_id) do update set count = excluded.count, revision = excluded.revision`,
      )
      .run(spaceId, state.count, state.revision)
  }

  private readBudgetCounters(spaceId: string, day: string): BudgetCounters {
    const row = this.db
      .prepare('select * from push_budget where space_id = ? and day = ?')
      .get(spaceId, day)
    if (!row) return { sent: 0, degraded: 0 }
    return { sent: requiredNumber(row, 'sent'), degraded: requiredNumber(row, 'degraded') }
  }

  private writeBudgetCounters(spaceId: string, day: string, counters: BudgetCounters): void {
    this.db
      .prepare(
        `insert into push_budget (space_id, day, sent, degraded) values (?, ?, ?, ?)
         on conflict(space_id, day) do update set sent = excluded.sent, degraded = excluded.degraded`,
      )
      .run(spaceId, day, counters.sent, counters.degraded)
  }

  private initializeSchema(): void {
    this.db.exec(`
      pragma journal_mode = wal;

      create table if not exists subscriptions (
        endpoint text primary key,
        p256dh text not null,
        auth text not null,
        device_id text,
        created_at text not null
      );

      create table if not exists space_attention (
        space_id text primary key,
        count integer not null default 0,
        revision integer not null default 0
      );

      create table if not exists push_budget (
        space_id text not null,
        day text not null,
        sent integer not null default 0,
        degraded integer not null default 0,
        primary key (space_id, day)
      );

      create table if not exists push_outbox (
        id integer primary key autoincrement,
        endpoint text not null,
        title text not null,
        body text not null,
        url text not null,
        attempts integer not null default 0,
        next_attempt_at text not null,
        created_at text not null
      );
      create index if not exists push_outbox_due
        on push_outbox (next_attempt_at);

      create table if not exists push_deferred (
        id integer primary key autoincrement,
        space_id text not null,
        title text not null,
        body text not null,
        url text not null,
        created_at text not null
      );
    `)
  }
}

function subscriptionFromRow(row: Record<string, unknown>): SubscriptionRow {
  const deviceId = optionalString(row, 'device_id')
  return {
    endpoint: requiredString(row, 'endpoint'),
    p256dh: requiredString(row, 'p256dh'),
    auth: requiredString(row, 'auth'),
    ...(deviceId === undefined ? {} : { deviceId }),
  }
}

function outboxFromRow(row: Record<string, unknown>): OutboxRow {
  return {
    id: requiredNumber(row, 'id'),
    endpoint: requiredString(row, 'endpoint'),
    title: requiredString(row, 'title'),
    body: requiredString(row, 'body'),
    url: requiredString(row, 'url'),
    attempts: requiredNumber(row, 'attempts'),
    nextAttemptAt: requiredString(row, 'next_attempt_at'),
    createdAt: requiredString(row, 'created_at'),
  }
}

function deferredFromRow(row: Record<string, unknown>): DeferredRow {
  return {
    id: requiredNumber(row, 'id'),
    spaceId: requiredString(row, 'space_id'),
    title: requiredString(row, 'title'),
    body: requiredString(row, 'body'),
    url: requiredString(row, 'url'),
    createdAt: requiredString(row, 'created_at'),
  }
}
