import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { optionalString, requiredNumber, requiredString } from './sqlite-rows.ts'

/**
 * Monitored watch renewal (issue #12, SECURITY.md §3.5): Gmail/Calendar
 * push channels expire, so registrations persist here and a sweep renews
 * them daily and ahead of expiry. Renewal keeps being retried every
 * sweep; after three consecutive failures the user is alerted once —
 * a dead watch means silent mail, never acceptable silently.
 */
export interface WatchRegistration {
  source: string
  kind: 'gmail' | 'calendar'
  expiresAt?: string
  channelId?: string
  resourceId?: string
  lastRenewedAt?: string
  consecutiveFailures: number
  alerted: boolean
  lastError?: string
}

export interface WatchRenewal {
  expiresAt: string
  channelId?: string
  resourceId?: string
}

export interface WatchTransport {
  renew(registration: WatchRegistration): Promise<WatchRenewal>
}

export interface WatchManagerOptions {
  rootDir: string
  now?: () => Date
  /** Deliver the 3-strike escalation (system notice + Space event live in the caller). */
  onAlert?: (source: string, message: string) => void
  /** Renew this far ahead of the reported expiry. */
  renewAheadMs?: number
  /** Renew at least this often even far from expiry ("automatic daily"). */
  renewEveryMs?: number
  sweepEveryMs?: number
}

const DEFAULT_RENEW_AHEAD_MS = 6 * 60 * 60 * 1000
const DEFAULT_RENEW_EVERY_MS = 24 * 60 * 60 * 1000
/** Well under the acceptance bound: an expired watch renews within the hour. */
const DEFAULT_SWEEP_EVERY_MS = 15 * 60 * 1000
const ALERT_AFTER_FAILURES = 3

export class WatchManager {
  private readonly db: DatabaseSync
  private readonly now: () => Date
  private readonly onAlert: ((source: string, message: string) => void) | undefined
  private readonly renewAheadMs: number
  private readonly renewEveryMs: number
  private readonly sweepEveryMs: number
  private readonly transports = new Map<string, WatchTransport>()
  private timer: NodeJS.Timeout | undefined
  private sweeping = false
  private stopped = true

  constructor(options: WatchManagerOptions) {
    this.db = new DatabaseSync(join(options.rootDir, 'ingestion.sqlite'))
    this.now = options.now ?? (() => new Date())
    this.onAlert = options.onAlert
    this.renewAheadMs = options.renewAheadMs ?? DEFAULT_RENEW_AHEAD_MS
    this.renewEveryMs = options.renewEveryMs ?? DEFAULT_RENEW_EVERY_MS
    this.sweepEveryMs = options.sweepEveryMs ?? DEFAULT_SWEEP_EVERY_MS
    this.initializeSchema()
  }

  /** Ensure a persisted registration; a fresh one is due immediately. */
  register(source: string, kind: 'gmail' | 'calendar', transport: WatchTransport): void {
    this.transports.set(source, transport)
    this.db
      .prepare(
        `insert or ignore into watch_registrations
           (source, kind, consecutive_failures, alerted, updated_at)
         values (?, ?, 0, 0, ?)`,
      )
      .run(source, kind, this.nowIso())
  }

  start(): void {
    this.stopped = false
    // Sweep immediately: a fresh or expired registration must not wait
    // out the first interval before it is (re)armed.
    void this.sweep()
      .catch((error: unknown) => console.error('watch renewal sweep failed', error))
      .finally(() => this.schedule())
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
  }

  registrations(): WatchRegistration[] {
    return this.db
      .prepare('select * from watch_registrations order by source')
      .all()
      .map(registrationFromRow)
  }

  /** Renew everything due. Single-flight; safe to call directly in tests. */
  async sweep(): Promise<void> {
    if (this.sweeping) return
    this.sweeping = true
    try {
      for (const registration of this.registrations()) {
        if (!this.isDue(registration)) continue
        const transport = this.transports.get(registration.source)
        if (!transport) continue
        await this.renewOne(registration, transport)
      }
    } finally {
      this.sweeping = false
    }
  }

  private isDue(registration: WatchRegistration): boolean {
    const nowMs = this.now().getTime()
    if (!registration.expiresAt) return true
    if (new Date(registration.expiresAt).getTime() - this.renewAheadMs <= nowMs) return true
    if (!registration.lastRenewedAt) return true
    return new Date(registration.lastRenewedAt).getTime() + this.renewEveryMs <= nowMs
  }

  private async renewOne(
    registration: WatchRegistration,
    transport: WatchTransport,
  ): Promise<void> {
    try {
      const renewal = await transport.renew(registration)
      this.db
        .prepare(
          `update watch_registrations
           set expires_at = ?, channel_id = ?, resource_id = ?, last_renewed_at = ?,
               consecutive_failures = 0, alerted = 0, last_error = null, updated_at = ?
           where source = ?`,
        )
        .run(
          renewal.expiresAt,
          renewal.channelId ?? registration.channelId ?? null,
          renewal.resourceId ?? registration.resourceId ?? null,
          this.nowIso(),
          this.nowIso(),
          registration.source,
        )
    } catch (error) {
      const failures = registration.consecutiveFailures + 1
      const shouldAlert = failures >= ALERT_AFTER_FAILURES && !registration.alerted
      this.db
        .prepare(
          `update watch_registrations
           set consecutive_failures = ?, alerted = ?, last_error = ?, updated_at = ?
           where source = ?`,
        )
        .run(
          failures,
          shouldAlert || registration.alerted ? 1 : 0,
          (error instanceof Error ? error.message : String(error)).slice(0, 300),
          this.nowIso(),
          registration.source,
        )
      if (shouldAlert) {
        // The message stays free of provider error text: it may quote
        // external content, and alerts flow into Agent-visible places.
        this.onAlert?.(
          registration.source,
          `Watch renewal for event source "${registration.source}" has failed ${failures} times in a row; new events may be missed until it recovers.`,
        )
      }
    }
  }

  private schedule(): void {
    if (this.stopped) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      void this.sweep()
        .catch((error: unknown) => console.error('watch renewal sweep failed', error))
        .finally(() => this.schedule())
    }, this.sweepEveryMs)
    this.timer.unref?.()
  }

  private initializeSchema(): void {
    this.db.exec(`
      pragma journal_mode = wal;
      create table if not exists watch_registrations (
        source text primary key,
        kind text not null check (kind in ('gmail', 'calendar')),
        expires_at text,
        channel_id text,
        resource_id text,
        last_renewed_at text,
        consecutive_failures integer not null default 0,
        alerted integer not null default 0,
        last_error text,
        updated_at text not null
      );
    `)
  }

  private nowIso(): string {
    return this.now().toISOString()
  }
}

function registrationFromRow(row: Record<string, unknown>): WatchRegistration {
  const kind = requiredString(row, 'kind')
  if (kind !== 'gmail' && kind !== 'calendar') throw new Error(`unexpected watch kind: ${kind}`)
  const expiresAt = optionalString(row, 'expires_at')
  const channelId = optionalString(row, 'channel_id')
  const resourceId = optionalString(row, 'resource_id')
  const lastRenewedAt = optionalString(row, 'last_renewed_at')
  const lastError = optionalString(row, 'last_error')
  return {
    source: requiredString(row, 'source'),
    kind,
    consecutiveFailures: requiredNumber(row, 'consecutive_failures'),
    alerted: requiredNumber(row, 'alerted') === 1,
    ...(expiresAt === undefined ? {} : { expiresAt }),
    ...(channelId === undefined ? {} : { channelId }),
    ...(resourceId === undefined ? {} : { resourceId }),
    ...(lastRenewedAt === undefined ? {} : { lastRenewedAt }),
    ...(lastError === undefined ? {} : { lastError }),
  }
}
