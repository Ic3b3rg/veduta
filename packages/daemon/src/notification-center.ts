import type { JsonObject } from '@veduta/protocol'
import {
  budgetFor,
  isWithinQuietHours,
  quietWindowEnd,
  resolveTimezone,
  type NotificationsConfig,
} from './notifications-config.ts'
import type { PushStore } from './push-store.ts'
import type { Store } from './store.ts'
import { effectiveOrigin, isUntrusted, type Origin } from './taint.ts'
import { endpointHost, type PushPayload, type PushTransport } from './web-push-transport.ts'

/**
 * NotificationCenter (issue #18, plan decisions 1-7, 14): the daemon's one
 * choke point for surfacing anything to the user outside a Surface's own
 * patches. Silent is the absence of a call. Every `notify()` invocation
 * appends exactly one `notification` Space event (Agent-context hygiene:
 * decisions live in the Event log, delivery bookkeeping lives in SQLite)
 * and increments the Space's attention badge — a push the user misses
 * must still be visible on Home.
 */

const PUSH_BODY_MAX_LENGTH = 140

export type NotificationInput =
  | { level: 'badge'; spaceId: string; text: string; origin?: Origin }
  | {
      level: 'push'
      spaceId: string
      text: string
      justification: string
      origin?: Origin
      urgent?: boolean
      surfaceId?: string
      automationId?: number
    }

export interface NotificationStats {
  queuedCount: number
  perSpace: Array<{ spaceId: string; sentToday: number; degradedToday: number }>
}

export interface NotificationCenterOptions {
  store: Store
  pushStore: PushStore
  transport: PushTransport
  config: NotificationsConfig
  now?: () => Date
  onAttention?: (spaceId: string, count: number, revision: number) => void
  onStats?: () => void
}

type PushInput = Extract<NotificationInput, { level: 'push' }>

/** Truncation only, no ellipsis: the plan specifies a byte-budget on the lock screen, not a UX flourish. */
function truncate(text: string, maxLength: number): string {
  return text.length > maxLength ? text.slice(0, maxLength) : text
}

/** The calendar date of `date` in `timeZone`, as YYYY-MM-DD — the budget "day" (plan decision 7). */
function budgetDay(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date)
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? '00'
  return `${get('year')}-${get('month')}-${get('day')}`
}

export class NotificationCenter {
  private readonly store: Store
  private readonly pushStore: PushStore
  private readonly transport: PushTransport
  private config: NotificationsConfig
  private readonly now: () => Date
  private readonly onAttention:
    ((spaceId: string, count: number, revision: number) => void) | undefined
  private readonly onStats: (() => void) | undefined

  private flushTimer: NodeJS.Timeout | undefined
  private retryTimer: NodeJS.Timeout | undefined
  /** Single-flight guard: overlapping delivery passes must never double-send an endpoint. */
  private deliveringNow = false
  /** Coalesces onStats to one emit per synchronous burst of budget/queue changes. */
  private statsEmitScheduled = false

  constructor(options: NotificationCenterOptions) {
    this.store = options.store
    this.pushStore = options.pushStore
    this.transport = options.transport
    this.config = options.config
    this.now = options.now ?? (() => new Date())
    this.onAttention = options.onAttention
    this.onStats = options.onStats
  }

  /**
   * Arms the digest flush timer, catches up on any deferred rows that
   * outlived a restart (boot outside the quiet window flushes them
   * immediately rather than waiting for a window that may not recur
   * today), and kicks a delivery pass for outbox rows left over from a
   * previous run.
   */
  start(): void {
    this.armFlushTimer()
    if (this.pushStore.deferredCount() > 0 && !this.isInsideQuietWindow()) {
      this.flush()
    }
    void this.deliverPending()
  }

  dispose(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer)
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.flushTimer = undefined
    this.retryTimer = undefined
  }

  updateConfig(config: NotificationsConfig): void {
    this.config = config
    this.armFlushTimer()
  }

  /**
   * decision-event-once: every branch below appends exactly one
   * `notification` Space event and increments attention exactly once,
   * regardless of outcome (badge, queued, degraded, sent).
   */
  notify(input: NotificationInput): void {
    if (input.level === 'push' && input.justification.trim().length === 0) {
      throw new TypeError('notify(): level "push" requires a non-empty justification')
    }
    if (input.level === 'badge') {
      this.recordBadge(input)
      return
    }
    this.recordPush(input)
  }

  /** No-op (returns null) when count is already 0 — clearing must never fabricate a change. */
  markSeen(spaceId: string): { count: number; revision: number } | null {
    const cleared = this.pushStore.clearAttention(spaceId)
    if (!cleared) return null
    this.store.spacesEngine.appendEvent(spaceId, {
      type: 'notification.seen',
      text: 'Notifications marked as seen',
      origin: 'trusted:user',
      at: this.nowIso(),
    })
    this.onAttention?.(spaceId, cleared.count, cleared.revision)
    return cleared
  }

  /** perSpace covers every non-archived Space known to the store, zeros included. */
  stats(): NotificationStats {
    const day = budgetDay(this.now(), resolveTimezone(this.config))
    const perSpace = this.store.listSpaces().map((space) => {
      const counters = this.pushStore.budgetCounters(space.id, day)
      return { spaceId: space.id, sentToday: counters.sent, degradedToday: counters.degraded }
    })
    return { queuedCount: this.pushStore.deferredCount(), perSpace }
  }

  private recordBadge(input: Extract<NotificationInput, { level: 'badge' }>): void {
    const origin = effectiveOrigin([input.origin], 'trusted:system')
    const attention = this.pushStore.incrementAttention(input.spaceId)
    this.onAttention?.(input.spaceId, attention.count, attention.revision)
    this.appendDecisionEvent(input.spaceId, origin, `Badge: ${truncate(input.text, 140)}`, {
      level: 'badge',
      outcome: 'badge',
    })
    // Badge decisions never touch budget/queue counters, so onStats is not scheduled here.
  }

  private recordPush(input: PushInput): void {
    const origin = effectiveOrigin([input.origin], 'trusted:system')
    const space = this.store.getSpace(input.spaceId)
    const spaceName = space?.name ?? input.spaceId
    // Taint rule: untrusted text never reaches the lock screen — only a
    // trusted effective origin may carry the real (truncated) text.
    const body = isUntrusted(origin)
      ? `New update in ${spaceName}`
      : truncate(input.text, PUSH_BODY_MAX_LENGTH)
    const url = this.deepLink(input.spaceId, input.surfaceId)
    const payload: PushPayload = { title: spaceName, body, url }
    const truncatedText = truncate(input.text, 140)

    // Attention is incremented once, up front, for every outcome (queued,
    // degraded, sent alike) — a missed push must still show on Home.
    const attention = this.pushStore.incrementAttention(input.spaceId)
    this.onAttention?.(input.spaceId, attention.count, attention.revision)

    const tz = resolveTimezone(this.config)
    const quietWindow = this.config.quietHours

    if (!input.urgent && quietWindow && isWithinQuietHours(this.now(), quietWindow, tz)) {
      this.pushStore.insertDeferred(
        { spaceId: input.spaceId, title: payload.title, body: payload.body, url: payload.url },
        this.now(),
      )
      this.appendDecisionEvent(
        input.spaceId,
        origin,
        `Push queued for quiet hours: ${truncatedText}`,
        this.decisionPayload(input, 'queued', url),
      )
      this.scheduleStatsEmit()
      return
    }

    // budget-at-commit: the gate and the per-endpoint outbox fan-out land
    // in one transaction (crash-durable), and discipline committed
    // decisions, not delivery success. Zero subscriptions still consume
    // budget and log outcome 'push': the interruption decision was made at
    // commit time regardless of whether delivery has anywhere to go.
    const day = budgetDay(this.now(), tz)
    const { outcome } = this.pushStore.commitPush({
      spaceId: input.spaceId,
      day,
      limit: budgetFor(this.config, input.spaceId),
      rows: this.outboxRows(payload),
      now: this.now(),
    })

    if (outcome === 'degraded') {
      this.appendDecisionEvent(
        input.spaceId,
        origin,
        `Push degraded to badge (budget exhausted): ${truncatedText}`,
        this.decisionPayload(input, 'degraded', url),
      )
      this.scheduleStatsEmit()
      return
    }

    this.appendDecisionEvent(
      input.spaceId,
      origin,
      `Push sent: ${truncatedText}`,
      this.decisionPayload(input, 'push', url),
    )
    this.scheduleStatsEmit()
    void this.deliverPending()
  }

  private decisionPayload(
    input: PushInput,
    outcome: 'push' | 'degraded' | 'queued',
    url: string,
  ): JsonObject {
    return {
      level: 'push',
      outcome,
      justification: input.justification,
      url,
      ...(input.automationId === undefined ? {} : { automationId: input.automationId }),
    }
  }

  /** One outbox row per current subscription for `payload` (may be empty). */
  private outboxRows(
    payload: PushPayload,
  ): Array<{ endpoint: string; title: string; body: string; url: string }> {
    return this.pushStore.listSubscriptions().map((subscription) => ({
      endpoint: subscription.endpoint,
      title: payload.title,
      body: payload.body,
      url: payload.url,
    }))
  }

  /**
   * surfaceId must belong to spaceId (store lookup); mismatch/unknown
   * ignores it, url falls back to '/'. Segments are percent-encoded to
   * match the PWA's `surfaceDeepLink`/`parseSurfaceDeepLink` pair.
   */
  private deepLink(spaceId: string, surfaceId: string | undefined): string {
    if (surfaceId === undefined) return '/'
    const surface = this.store.getSurface(surfaceId)
    if (!surface || surface.spaceId !== spaceId) return '/'
    const space = this.store.getSpace(spaceId)
    if (!space) return '/'
    return `/app/space/${encodeURIComponent(space.slug)}/surface/${encodeURIComponent(surfaceId)}`
  }

  private appendDecisionEvent(
    spaceId: string,
    origin: Origin,
    text: string,
    payload: JsonObject,
  ): void {
    this.store.spacesEngine.appendEvent(spaceId, {
      type: 'notification',
      text,
      origin,
      payload,
      at: this.nowIso(),
    })
  }

  /**
   * Quiet-hours digest flush (plan decision 7): each deferred item passes
   * its own Space's budget gate again at flush time — over-budget/zero-
   * budget items degrade to badge-only silently (their decision event was
   * already appended at queue time; no new Space event here, delivery
   * bookkeeping only). digest-never-bypasses-budget: the digest coalesces
   * only the survivors that already cleared the gate.
   */
  private flush(): void {
    const deferredRows = this.pushStore.listDeferred()
    if (deferredRows.length === 0) {
      this.armFlushTimer()
      return
    }

    const tz = resolveTimezone(this.config)
    const day = budgetDay(this.now(), tz)
    // Each item settles in its own transaction (budget gate + outbox rows +
    // deferred-row deletion together): a crash mid-flush leaves the
    // unprocessed tail queued instead of lost. Survivors materialize as
    // individual pushes first; the digest swap below is a second, equally
    // atomic step — a crash between the two delivers individual pushes
    // instead of the digest, which degrades gracefully rather than losing
    // anything.
    const survivorOutboxIds: number[] = []
    let survivorCount = 0
    for (const row of deferredRows) {
      const settled = this.pushStore.flushDeferredItem(row.id, {
        spaceId: row.spaceId,
        day,
        limit: budgetFor(this.config, row.spaceId),
        rows: this.outboxRows({ title: row.title, body: row.body, url: row.url }),
        now: this.now(),
      })
      if (settled.outcome === 'sent') {
        survivorCount += 1
        survivorOutboxIds.push(...settled.outboxIds)
      }
    }

    if (survivorCount > this.config.digestThreshold) {
      const digest: PushPayload = {
        title: 'Veduta',
        body: `${survivorCount} updates while you were away`,
        url: '/',
      }
      this.pushStore.replaceOutbox(survivorOutboxIds, this.outboxRows(digest), this.now())
    }

    this.scheduleStatsEmit()
    void this.deliverPending()
    this.armFlushTimer()
  }

  /**
   * Delivery loop, single-flight (an in-flight pass makes an overlapping
   * call a no-op; the retry timer or the next notify()/flush() call will
   * pick up whatever the in-flight pass did not claim).
   */
  private async deliverPending(): Promise<void> {
    if (this.deliveringNow) return
    this.deliveringNow = true
    try {
      const due = this.pushStore.claimDueOutbox(this.now())
      if (due.length > 0) {
        const subscriptionsByEndpoint = new Map(
          this.pushStore
            .listSubscriptions()
            .map((subscription) => [subscription.endpoint, subscription]),
        )
        for (const row of due) {
          const subscription = subscriptionsByEndpoint.get(row.endpoint)
          if (!subscription) {
            // The subscription vanished between commit and delivery (e.g. revoked): the row is orphaned.
            this.pushStore.deleteOutbox(row.id)
            continue
          }
          const result = await this.transport.send(subscription, {
            title: row.title,
            body: row.body,
            url: row.url,
          })
          if (result === 'ok') {
            this.pushStore.deleteOutbox(row.id)
          } else if (result === 'gone') {
            this.pushStore.deleteOutbox(row.id)
            this.pushStore.deleteSubscription(row.endpoint)
            this.pushStore.deleteOutboxByEndpoint(row.endpoint)
          } else {
            const bumped = this.pushStore.bumpOutboxAttempt(row.id, this.now())
            if (bumped === 'dropped') {
              console.warn(
                `notification-center: dropped outbox row for endpoint host "${endpointHost(row.endpoint)}" after max attempts`,
              )
            }
          }
        }
      }
    } finally {
      this.deliveringNow = false
    }
    this.armRetryTimer()
  }

  private armFlushTimer(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = undefined
    }
    const window = this.config.quietHours
    if (!window) return
    const tz = resolveTimezone(this.config)
    const delay = Math.max(
      quietWindowEnd(this.now(), window, tz).getTime() - this.now().getTime(),
      0,
    )
    this.flushTimer = setTimeout(() => this.flush(), delay)
    this.flushTimer.unref?.()
  }

  private armRetryTimer(): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer)
      this.retryTimer = undefined
    }
    const next = this.pushStore.earliestOutboxAttemptAt()
    if (!next) return
    const delay = Math.max(next.getTime() - this.now().getTime(), 0)
    this.retryTimer = setTimeout(() => {
      void this.deliverPending()
    }, delay)
    this.retryTimer.unref?.()
  }

  private isInsideQuietWindow(): boolean {
    const window = this.config.quietHours
    if (!window) return false
    return isWithinQuietHours(this.now(), window, resolveTimezone(this.config))
  }

  private scheduleStatsEmit(): void {
    if (!this.onStats || this.statsEmitScheduled) return
    this.statsEmitScheduled = true
    queueMicrotask(() => {
      this.statsEmitScheduled = false
      this.onStats?.()
    })
  }

  private nowIso(): string {
    return this.now().toISOString()
  }
}
