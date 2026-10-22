import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { PUSH_ANNOUNCEMENT_SCHEMA } from './push-announcement-schema.ts'
import {
  optionalString,
  requiredNumber,
  requiredString,
  withImmediateTransaction,
} from './sqlite-rows.ts'

/**
 * Durable storage for outbound Web Push (issue #18, ADR-0005 persistence
 * idiom): subscriptions, per-Space attention,
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

export interface OutboxRow {
  id: number
  endpoint: string
  title: string
  body: string
  url: string
  attempts: number
  nextAttemptAt: string
  createdAt: string
  announcementId?: string
}

export interface DeferredRow {
  id: number
  spaceId: string
  title: string
  body: string
  url: string
  createdAt: string
  announcementId?: string
}

interface PushRow {
  endpoint: string
  title: string
  body: string
  url: string
  announcementId?: string
}

type AnnouncementDecision = 'push' | 'queued' | 'no-devices'

export interface PushStoreOptions {
  rootDir: string
}

/** Linear backoff step for outbox retries: 30s, 60s, 90s, ... */
const OUTBOX_BACKOFF_STEP_MS = 30 * 1000
/** Attempts at which an undelivered outbox row is dropped. */
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
    withImmediateTransaction(this.db, () => {
      this.db.prepare('delete from push_announcement_targets where endpoint = ?').run(endpoint)
      this.db.prepare('delete from subscriptions where endpoint = ?').run(endpoint)
    })
  }

  deleteSubscriptionsByDevice(deviceId: string): void {
    withImmediateTransaction(this.db, () => {
      this.db
        .prepare(
          `delete from push_announcement_targets where endpoint in
        (select endpoint from subscriptions where device_id = ?)`,
        )
        .run(deviceId)
      this.db.prepare('delete from subscriptions where device_id = ?').run(deviceId)
    })
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

  /** Atomically persist the complete per-device fan-out before attempting delivery. */
  enqueuePush(rows: PushRow[], now: Date): number[] {
    return withImmediateTransaction(this.db, () => this.insertOutboxUnguarded(rows, now))
  }

  /** Freeze recipients before the caller commits its authoritative discovery. */
  prepareAnnouncement(id: string): void {
    withImmediateTransaction(this.db, () => this.prepareAnnouncementUnguarded(id))
  }

  hasAnnouncement(id: string): boolean {
    return this.db.prepare('select 1 from push_announcements where id = ?').get(id) !== undefined
  }

  /** Activate a prepared identity atomically with its deferred or per-device delivery intent. */
  enqueueAnnouncement(
    input: {
      id: string
      spaceId: string
      title: string
      body: string
      url: string
      deferred: boolean
    },
    now: Date,
  ): { created: boolean; decision: AnnouncementDecision } {
    return withImmediateTransaction(this.db, () => {
      this.prepareAnnouncementUnguarded(input.id)
      const existing = this.db
        .prepare('select outcome from push_announcements where id = ?')
        .get(input.id)
      if (existing && requiredString(existing, 'outcome') !== 'prepared') {
        return {
          created: false,
          decision: announcementDecision(requiredString(existing, 'outcome')),
        }
      }
      const subscriptions = this.announcementSubscriptions(input.id)
      const decision =
        subscriptions.length === 0 ? 'no-devices' : input.deferred ? 'queued' : 'push'
      this.db
        .prepare('update push_announcements set outcome = ? where id = ?')
        .run(decision, input.id)
      if (decision === 'queued') {
        this.insertDeferred({ ...input, announcementId: input.id }, now)
      } else if (decision === 'push') {
        this.insertOutboxUnguarded(
          subscriptions.map(({ endpoint }) => ({ ...input, endpoint, announcementId: input.id })),
          now,
        )
      }
      return { created: true, decision }
    })
  }

  /** Revoked/replaced subscriptions never rejoin an existing announcement. */
  announcementSubscriptions(id: string): SubscriptionRow[] {
    return this.db
      .prepare(
        `
      select s.* from subscriptions s join push_announcement_targets t
        on t.endpoint = s.endpoint and t.p256dh = s.p256dh and t.auth = s.auth
      where t.announcement_id = ? order by s.endpoint
    `,
      )
      .all(id)
      .map(subscriptionFromRow)
  }

  // --- outbox ---

  /** Atomic digest swap (plan): the individual rows leave and the digest rows land together. */
  replaceOutbox(ids: number[], rows: PushRow[], now: Date): void {
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
    input: { spaceId: string; title: string; body: string; url: string; announcementId?: string },
    now: Date,
  ): void {
    this.db
      .prepare(
        `insert into push_deferred (space_id, title, body, url, created_at, announcement_id)
         values (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.spaceId,
        input.title,
        input.body,
        input.url,
        now.toISOString(),
        input.announcementId ?? null,
      )
  }

  /** Read-only: rows stay queued until `flushDeferredItem` settles each one. */
  listDeferred(): DeferredRow[] {
    return this.db.prepare('select * from push_deferred order by id').all().map(deferredFromRow)
  }

  /**
   * Crash-durable per-item flush: outbox
   * fan-out (when the gate passes), and the deferred row's deletion land in
   * ONE transaction — a crash mid-flush leaves the unprocessed remainder of
   * the queue intact instead of losing it wholesale.
   */
  flushDeferredItem(
    deferredId: number,
    input: {
      rows: PushRow[]
      now: Date
    },
  ): number[] {
    return withImmediateTransaction(this.db, () => {
      const outboxIds = this.insertOutboxUnguarded(input.rows, input.now)
      this.db.prepare('delete from push_deferred where id = ?').run(deferredId)
      return outboxIds
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

  private prepareAnnouncementUnguarded(id: string): void {
    const inserted = this.db
      .prepare("insert or ignore into push_announcements (id, outcome) values (?, 'prepared')")
      .run(id)
    if (inserted.changes === 0) return
    const target = this.db.prepare(
      'insert into push_announcement_targets (announcement_id, endpoint, p256dh, auth) values (?, ?, ?, ?)',
    )
    for (const subscription of this.listSubscriptions())
      target.run(id, subscription.endpoint, subscription.p256dh, subscription.auth)
  }

  /** Must run inside a caller-held transaction. Returns the inserted row ids. */
  private insertOutboxUnguarded(rows: PushRow[], now: Date): number[] {
    const at = now.toISOString()
    const statement = this.db.prepare(
      `insert into push_outbox (endpoint, title, body, url, attempts, next_attempt_at, created_at, announcement_id)
       values (?, ?, ?, ?, 0, ?, ?, ?)`,
    )
    const ids: number[] = []
    for (const row of rows) {
      const result = statement.run(
        row.endpoint,
        row.title,
        row.body,
        row.url,
        at,
        at,
        row.announcementId ?? null,
      )
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

      create table if not exists push_outbox (
        id integer primary key autoincrement,
        endpoint text not null,
        title text not null,
        body text not null,
        url text not null,
        attempts integer not null default 0,
        next_attempt_at text not null,
        created_at text not null,
        announcement_id text
      );
      create index if not exists push_outbox_due
        on push_outbox (next_attempt_at);

      create table if not exists push_deferred (
        id integer primary key autoincrement,
        space_id text not null,
        title text not null,
        body text not null,
        url text not null,
        created_at text not null,
        announcement_id text
      );

    `)
    this.db.exec(PUSH_ANNOUNCEMENT_SCHEMA)
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
    ...(optionalString(row, 'announcement_id') === undefined
      ? {}
      : { announcementId: requiredString(row, 'announcement_id') }),
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
    ...(optionalString(row, 'announcement_id') === undefined
      ? {}
      : { announcementId: requiredString(row, 'announcement_id') }),
  }
}

function announcementDecision(value: string): AnnouncementDecision {
  if (value === 'queued' || value === 'push' || value === 'no-devices') return value
  throw new Error(`invalid announcement outcome: ${value}`)
}
