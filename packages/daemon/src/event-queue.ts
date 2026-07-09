import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { ExternalEventSchema, type ExternalEvent } from './external-event.ts'
import {
  optionalString,
  requiredNumber,
  requiredString,
  withImmediateTransaction,
} from './sqlite-rows.ts'

/**
 * The local event queue (issue #12, SECURITY.md §3.5): every inbound
 * attempt leaves a durable decision with a reason, events dedup on
 * (source, external id), and per-source rate limiting bounds what an
 * outside sender can make the daemon do. Raw external content waits
 * here, quarantined, for the reader (issue #13) — it never flows on
 * as text.
 */
export type QueueStatus = 'pending' | 'discarded' | 'accepted'

export type DecisionOutcome = 'queued' | 'duplicate' | 'malformed' | 'discarded' | 'accepted'

/** Refused attempts leave no per-request rows, only hourly counters. */
export type RefusalKind = 'verification-rejected' | 'rate-limited'

export interface QueuedEvent {
  id: number
  source: string
  dedupKey: string
  spaceId: string
  status: QueueStatus
  discardReason?: string
  receivedAt: string
  decidedAt?: string
  deliveredAt?: string
  event: ExternalEvent
}

export interface IngestDecision {
  id: number
  source: string
  outcome: DecisionOutcome
  reason?: string
  eventId?: number
  at: string
}

export type IngestOutcome =
  | { outcome: 'queued'; queueId: number }
  | { outcome: 'duplicate'; queueId: number }
  | { outcome: 'rate-limited' }

/** Attempt outcomes that consume the rolling-window rate quota. */
const ATTEMPT_OUTCOMES = "('queued', 'duplicate', 'malformed')"

const RATE_WINDOW_MS = 60_000

export interface EventQueueOptions {
  rootDir: string
  now?: () => Date
}

export class EventQueue {
  private readonly db: DatabaseSync
  private readonly now: () => Date

  constructor(options: EventQueueOptions) {
    this.db = new DatabaseSync(join(options.rootDir, 'ingestion.sqlite'))
    this.now = options.now ?? (() => new Date())
    this.initializeSchema()
  }

  /**
   * Queue one externally-triggered event. Duplicates are recorded and
   * acknowledged (webhook retries are normal) but never re-delivered;
   * over-quota attempts are refused so the caller can ask the provider
   * to back off and redeliver.
   */
  ingest(
    event: ExternalEvent,
    options: { spaceId: string; ratePerMinute: number; bypassRateLimit?: boolean },
  ): IngestOutcome {
    return withImmediateTransaction(this.db, () => {
      if (!options.bypassRateLimit && this.overQuota(event.source, options.ratePerMinute)) {
        this.recordRefusal(event.source, 'rate-limited')
        return { outcome: 'rate-limited' }
      }
      return this.insertEvent(event, options.spaceId)
    })
  }

  /**
   * Queue a batch from an authenticated fetch stage (Gmail history,
   * Calendar changes) and advance the source cursor in the same
   * transaction: the cursor never moves past events that were not
   * durably recorded, so a crash re-fetches instead of losing mail.
   * Fetch stages bypass the webhook rate quota — Google already
   * authenticated and bounded them.
   */
  ingestBatch(
    entries: { event: ExternalEvent; spaceId: string }[],
    cursor?: { source: string; value: string },
  ): IngestOutcome[] {
    return withImmediateTransaction(this.db, () => {
      const outcomes = entries.map(({ event, spaceId }) => this.insertEvent(event, spaceId))
      if (cursor) this.writeCursor(cursor.source, cursor.value)
      return outcomes
    })
  }

  /** Record an attempt whose payload never became a valid event. */
  recordMalformed(source: string, reason: string): void {
    this.recordDecision(source, 'malformed', reason.slice(0, 300))
  }

  /**
   * Refused attempts (failed verification, over-quota) aggregate into
   * hourly counters instead of per-request rows: the endpoint is public,
   * and a flood must not become a disk-fill (SECURITY.md §3.5).
   */
  recordRefusal(source: string, kind: RefusalKind): void {
    const hour = this.nowIso().slice(0, 13)
    this.db
      .prepare(
        `insert into refusals (source, kind, hour, count) values (?, ?, ?, 1)
         on conflict (source, kind, hour) do update set count = count + 1`,
      )
      .run(source, kind, hour)
  }

  refusalCount(source: string, kind?: RefusalKind): number {
    const row = kind
      ? this.db
          .prepare(
            'select coalesce(sum(count), 0) as total from refusals where source = ? and kind = ?',
          )
          .get(source, kind)
      : this.db
          .prepare('select coalesce(sum(count), 0) as total from refusals where source = ?')
          .get(source)
    return row ? requiredNumber(row, 'total') : 0
  }

  /** True when the source exhausted its rolling-window attempt quota. */
  overQuota(source: string, ratePerMinute: number): boolean {
    return this.attemptsInWindow(source) >= ratePerMinute
  }

  /** Apply a pre-filter verdict to a pending event, durably, with its reason. */
  decide(
    queueId: number,
    verdict: { verdict: 'accept' } | { verdict: 'discard'; reason: string },
  ): QueuedEvent {
    const event = this.requireEvent(queueId)
    const decidedAt = this.nowIso()
    if (verdict.verdict === 'accept') {
      this.db
        .prepare(`update events set status = 'accepted', decided_at = ? where id = ?`)
        .run(decidedAt, queueId)
      this.recordDecision(event.source, 'accepted', undefined, queueId)
    } else {
      this.db
        .prepare(
          `update events set status = 'discarded', discard_reason = ?, decided_at = ? where id = ?`,
        )
        .run(verdict.reason, decidedAt, queueId)
      this.recordDecision(event.source, 'discarded', verdict.reason, queueId)
    }
    return this.requireEvent(queueId)
  }

  /** Set only after the reader handoff returned: at-least-once delivery. */
  markDelivered(queueId: number): void {
    this.db.prepare('update events set delivered_at = ? where id = ?').run(this.nowIso(), queueId)
  }

  /** Rows interrupted before a verdict (crash mid-pipeline): re-decide at boot. */
  pendingEvents(): QueuedEvent[] {
    return this.db
      .prepare(`select * from events where status = 'pending' order by id`)
      .all()
      .map(eventFromRow)
  }

  /** Accepted rows whose handoff never completed: re-deliver at boot. */
  undeliveredAccepted(): QueuedEvent[] {
    return this.db
      .prepare(
        `select * from events where status = 'accepted' and delivered_at is null order by id`,
      )
      .all()
      .map(eventFromRow)
  }

  getEvent(queueId: number): QueuedEvent | undefined {
    const row = this.db.prepare('select * from events where id = ?').get(queueId)
    return row ? eventFromRow(row) : undefined
  }

  listEvents(source?: string): QueuedEvent[] {
    const rows =
      source === undefined
        ? this.db.prepare('select * from events order by id').all()
        : this.db.prepare('select * from events where source = ? order by id').all(source)
    return rows.map(eventFromRow)
  }

  decisions(source?: string): IngestDecision[] {
    const rows =
      source === undefined
        ? this.db.prepare('select * from ingest_decisions order by id').all()
        : this.db.prepare('select * from ingest_decisions where source = ? order by id').all(source)
    return rows.map(decisionFromRow)
  }

  /** Fetch-stage checkpoint (Gmail historyId, Calendar updatedMin), per source. */
  cursor(source: string): string | undefined {
    const row = this.db.prepare('select cursor from source_cursors where source = ?').get(source)
    return row ? optionalString(row, 'cursor') : undefined
  }

  setCursor(source: string, value: string): void {
    this.writeCursor(source, value)
  }

  private insertEvent(event: ExternalEvent, spaceId: string): IngestOutcome {
    const inserted = this.db
      .prepare(
        `insert or ignore into events
           (source, dedup_key, space_id, event_json, status, received_at)
         values (?, ?, ?, ?, 'pending', ?)`,
      )
      .run(event.source, event.externalId, spaceId, JSON.stringify(event), this.nowIso())
    if (Number(inserted.changes) === 1) {
      const queueId = Number(inserted.lastInsertRowid)
      this.recordDecision(event.source, 'queued', undefined, queueId)
      return { outcome: 'queued', queueId }
    }
    const existing = this.db
      .prepare('select id from events where source = ? and dedup_key = ?')
      .get(event.source, event.externalId)
    const queueId = existing ? requiredNumber(existing, 'id') : -1
    this.recordDecision(event.source, 'duplicate', undefined, queueId === -1 ? undefined : queueId)
    return { outcome: 'duplicate', queueId }
  }

  private attemptsInWindow(source: string): number {
    const windowStart = new Date(this.now().getTime() - RATE_WINDOW_MS).toISOString()
    const row = this.db
      .prepare(
        `select count(*) as attempts from ingest_decisions
         where source = ? and at > ? and outcome in ${ATTEMPT_OUTCOMES}`,
      )
      .get(source, windowStart)
    return row ? requiredNumber(row, 'attempts') : 0
  }

  private recordDecision(
    source: string,
    outcome: DecisionOutcome,
    reason?: string,
    eventId?: number,
  ): void {
    this.db
      .prepare(
        'insert into ingest_decisions (source, outcome, reason, event_id, at) values (?, ?, ?, ?, ?)',
      )
      .run(source, outcome, reason ?? null, eventId ?? null, this.nowIso())
  }

  private requireEvent(queueId: number): QueuedEvent {
    const event = this.getEvent(queueId)
    if (!event) throw new Error(`unknown queued event: ${queueId}`)
    return event
  }

  private writeCursor(source: string, value: string): void {
    this.db
      .prepare(
        `insert into source_cursors (source, cursor, updated_at) values (?, ?, ?)
         on conflict (source) do update set cursor = excluded.cursor, updated_at = excluded.updated_at`,
      )
      .run(source, value, this.nowIso())
  }

  private initializeSchema(): void {
    this.db.exec(`
      pragma journal_mode = wal;
      create table if not exists events (
        id integer primary key autoincrement,
        source text not null,
        dedup_key text not null,
        space_id text not null,
        event_json text not null,
        status text not null default 'pending'
          check (status in ('pending', 'discarded', 'accepted')),
        discard_reason text,
        received_at text not null,
        decided_at text,
        delivered_at text,
        unique (source, dedup_key)
      );
      create table if not exists ingest_decisions (
        id integer primary key autoincrement,
        source text not null,
        outcome text not null
          check (outcome in ('queued', 'duplicate', 'rate-limited', 'malformed', 'discarded', 'accepted')),
        reason text,
        event_id integer,
        at text not null
      );
      create index if not exists ingest_decisions_window
        on ingest_decisions (source, at);
      create table if not exists refusals (
        source text not null,
        kind text not null check (kind in ('verification-rejected', 'rate-limited')),
        hour text not null,
        count integer not null default 0,
        primary key (source, kind, hour)
      );
      create table if not exists source_cursors (
        source text primary key,
        cursor text not null,
        updated_at text not null
      );
    `)
  }

  private nowIso(): string {
    return this.now().toISOString()
  }
}

function eventFromRow(row: Record<string, unknown>): QueuedEvent {
  const status = requiredString(row, 'status')
  if (status !== 'pending' && status !== 'discarded' && status !== 'accepted') {
    throw new Error(`unexpected queue status: ${status}`)
  }
  const discardReason = optionalString(row, 'discard_reason')
  const decidedAt = optionalString(row, 'decided_at')
  const deliveredAt = optionalString(row, 'delivered_at')
  return {
    id: requiredNumber(row, 'id'),
    source: requiredString(row, 'source'),
    dedupKey: requiredString(row, 'dedup_key'),
    spaceId: requiredString(row, 'space_id'),
    status,
    receivedAt: requiredString(row, 'received_at'),
    event: ExternalEventSchema.parse(JSON.parse(requiredString(row, 'event_json'))),
    ...(discardReason === undefined ? {} : { discardReason }),
    ...(decidedAt === undefined ? {} : { decidedAt }),
    ...(deliveredAt === undefined ? {} : { deliveredAt }),
  }
}

function decisionFromRow(row: Record<string, unknown>): IngestDecision {
  const outcome = requiredString(row, 'outcome') as DecisionOutcome
  const reason = optionalString(row, 'reason')
  const eventId = row['event_id'] === null ? undefined : requiredNumber(row, 'event_id')
  return {
    id: requiredNumber(row, 'id'),
    source: requiredString(row, 'source'),
    outcome,
    at: requiredString(row, 'at'),
    ...(reason === undefined ? {} : { reason }),
    ...(eventId === undefined ? {} : { eventId }),
  }
}
