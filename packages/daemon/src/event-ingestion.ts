import { createHash } from 'node:crypto'
import { JsonObjectSchema, type JsonObject } from '@veduta/protocol'
import { z } from 'zod'
import { EventQueue, type QueuedEvent } from './event-queue.ts'
import { ExternalEventSchema, type ExternalEvent, type ReaderHandoff } from './external-event.ts'
import { decodeGmailPush, type FetchStageResult } from './google-sources.ts'
import type { IngestionConfig, IngestionSource } from './ingestion-config.ts'
import { envSecretResolver, type SecretResolver } from './model-routing.ts'
import { evaluatePreFilter, type SimilarityHook } from './pre-filter.ts'
import type { Store } from './store.ts'
import { verifyWebhook, type VerifyInput } from './webhook-verify.ts'

/**
 * Event ingestion (issue #12, ADR-0005): the outside world becomes
 * structured events, verified, deduped, rate-limited and pre-filtered —
 * all deterministic, zero LLM calls. Survivors stop at the quarantined
 * reader seam (`onAccepted`, issue #13); the Agent only ever sees a
 * content-free acceptance notice in the Space's Event log.
 */
export type FetchStage = (cursor: string | undefined) => Promise<FetchStageResult>

export interface EventIngestionOptions {
  rootDir: string
  config: IngestionConfig
  store: Store
  secrets?: SecretResolver
  now?: () => Date
  /** The quarantined reader seam (issue #13). Delivery is at-least-once. */
  onAccepted?: (handoff: ReaderHandoff) => void | Promise<void>
  /** Operational notices for the user (wired to the Gateway system notice). */
  onNotice?: (text: string) => void
  /** Per-source fetch stages for push notifications that carry no content. */
  fetchStages?: Record<string, FetchStage>
  /** Calendar pushes must come from the channel we opened (watch-renewal). */
  expectedChannelId?: (source: string) => string | undefined
  similarity?: SimilarityHook
}

export interface WebhookResponse {
  status: number
  body: JsonObject
  retryAfterSeconds?: number
}

/** Generic webhook payload: already event-shaped, one event per request. */
const WebhookPayloadSchema = z.object({
  id: z.string().min(1).optional(),
  type: z.string().min(1),
  kind: z.enum(['email', 'calendar', 'webhook']).default('webhook'),
  sender: z.string().optional(),
  subject: z.string().optional(),
  headers: z.record(z.string()).optional(),
  occurredAt: z.string().datetime({ offset: true }).optional(),
  data: JsonObjectSchema.optional(),
})

const CHANNEL_ID_HEADER = 'x-goog-channel-id'
const RESOURCE_STATE_HEADER = 'x-goog-resource-state'

export class EventIngestion {
  readonly queue: EventQueue
  private readonly config: IngestionConfig
  private readonly store: Store
  private readonly secrets: SecretResolver
  private readonly now: () => Date
  private readonly onAccepted: ((handoff: ReaderHandoff) => void | Promise<void>) | undefined
  private readonly onNotice: ((text: string) => void) | undefined
  private readonly fetchStages: Record<string, FetchStage>
  private readonly expectedChannelId: ((source: string) => string | undefined) | undefined
  private readonly similarity: SimilarityHook | undefined

  constructor(options: EventIngestionOptions) {
    this.queue = new EventQueue({
      rootDir: options.rootDir,
      ...(options.now === undefined ? {} : { now: options.now }),
    })
    this.config = options.config
    this.store = options.store
    this.secrets = options.secrets ?? envSecretResolver
    this.now = options.now ?? (() => new Date())
    this.onAccepted = options.onAccepted
    this.onNotice = options.onNotice
    this.fetchStages = options.fetchStages ?? {}
    this.expectedChannelId = options.expectedChannelId
    this.similarity = options.similarity
  }

  sources(): Record<string, IngestionSource> {
    return this.config.sources
  }

  /**
   * The full inbound pipeline for one push. Fail closed: unknown sources
   * and failed verification return 401 with nothing parsed or queued.
   */
  async handleWebhook(sourceName: string, input: VerifyInput): Promise<WebhookResponse> {
    const source = this.config.sources[sourceName]
    // Unknown sources get no rejection counter: an unauthenticated flood
    // of invented names must not grow state (SECURITY.md §3.5).
    if (!source) return { status: 401, body: { error: 'unknown or unverified source' } }

    const verified = verifyWebhook(source.verification, source.secret, this.secrets, input)
    if (!verified.ok) {
      this.queue.recordRefusal(sourceName, 'verification-rejected')
      return { status: 401, body: { error: 'unknown or unverified source' } }
    }

    // Quota gates the whole authenticated pipeline — parsing, fetch
    // stages, even malformed-payload decision rows stay bounded. Refused
    // attempts leave only an hourly counter and a 429: the provider backs
    // off and redelivers, nothing is silently lost.
    if (this.queue.overQuota(sourceName, source.ratePerMinute)) {
      this.queue.recordRefusal(sourceName, 'rate-limited')
      return { status: 429, body: { error: 'rate limited' }, retryAfterSeconds: 60 }
    }

    if (!this.store.getSpace(source.spaceId)) {
      return {
        status: 500,
        body: { error: `ingestion source "${sourceName}" targets an unknown Space` },
      }
    }

    if (source.adapter === 'webhook') return this.handleGenericWebhook(sourceName, source, input)
    if (source.adapter === 'gmail-push') return this.handleGmailPush(sourceName, source, input)
    return this.handleCalendarPush(sourceName, source, input)
  }

  /** Boot recovery: at-least-once, mirroring the scheduler's discipline. */
  async recoverAtBoot(): Promise<void> {
    for (const row of this.queue.pendingEvents()) {
      const source = this.config.sources[row.source]
      if (!source) continue
      await this.decideAndDeliver(row.id, source)
    }
    for (const row of this.queue.undeliveredAccepted()) {
      await this.deliver(row)
    }
  }

  private async handleGenericWebhook(
    sourceName: string,
    source: IngestionSource,
    input: VerifyInput,
  ): Promise<WebhookResponse> {
    let event: ExternalEvent
    try {
      const payload = WebhookPayloadSchema.parse(JSON.parse(input.rawBody.toString('utf8')))
      event = ExternalEventSchema.parse({
        source: sourceName,
        kind: payload.kind,
        externalId: payload.id ?? sha256Hex(input.rawBody),
        type: payload.type,
        ...(payload.sender === undefined ? {} : { sender: payload.sender }),
        ...(payload.subject === undefined ? {} : { subject: payload.subject }),
        ...(payload.headers === undefined ? {} : { headers: lowercaseKeys(payload.headers) }),
        ...(payload.occurredAt === undefined ? {} : { occurredAt: payload.occurredAt }),
        ...(payload.data === undefined ? {} : { payload: payload.data }),
      })
    } catch (error) {
      // Discarded and logged, never "interpreted" (SECURITY.md §3.5).
      this.queue.recordMalformed(sourceName, error instanceof Error ? error.message : String(error))
      return { status: 400, body: { error: 'payload failed schema validation' } }
    }

    const outcome = this.queue.ingest(event, {
      spaceId: source.spaceId,
      ratePerMinute: source.ratePerMinute,
    })
    // The entry check already gated quota; this is the transactional backstop.
    if (outcome.outcome === 'rate-limited') {
      return { status: 429, body: { error: 'rate limited' }, retryAfterSeconds: 60 }
    }
    if (outcome.outcome === 'duplicate') return { status: 200, body: { outcome: 'duplicate' } }

    const decided = await this.decideAndDeliver(outcome.queueId, source)
    return {
      status: 200,
      body:
        decided.status === 'discarded'
          ? { outcome: 'discarded', reason: decided.discardReason ?? 'unknown' }
          : { outcome: 'accepted', queueId: decided.id },
    }
  }

  private async handleGmailPush(
    sourceName: string,
    source: IngestionSource,
    input: VerifyInput,
  ): Promise<WebhookResponse> {
    let body: unknown
    try {
      body = JSON.parse(input.rawBody.toString('utf8'))
    } catch {
      this.queue.recordMalformed(sourceName, 'push body is not JSON')
      return { status: 400, body: { error: 'payload failed schema validation' } }
    }
    const decoded = decodeGmailPush(body, source.gmail?.subscription ?? '')
    if (!decoded.ok) {
      this.queue.recordMalformed(sourceName, decoded.reason)
      return { status: 400, body: { error: 'payload failed schema validation' } }
    }
    return this.runFetchStage(sourceName, source)
  }

  private async handleCalendarPush(
    sourceName: string,
    source: IngestionSource,
    input: VerifyInput,
  ): Promise<WebhookResponse> {
    // A token-valid push from a superseded channel (renewal opens a fresh
    // one daily; old ones lapse on their own TTL) is acknowledged and
    // dropped: a 401 here would feed the route lockout and let a stale
    // channel's death rattle throttle the live one.
    const expected = this.expectedChannelId?.(sourceName)
    const presented = input.headers[CHANNEL_ID_HEADER]
    if (expected !== undefined && presented !== expected) {
      return { status: 200, body: { outcome: 'stale-channel' } }
    }
    // The 'sync' ping only confirms the channel we just opened.
    if (input.headers[RESOURCE_STATE_HEADER] === 'sync') {
      return { status: 200, body: { outcome: 'sync' } }
    }
    return this.runFetchStage(sourceName, source)
  }

  /**
   * Push notifications carry no filterable content: fetch what changed,
   * queue it in one transaction with the cursor advance, then filter.
   * A fetch failure returns 500 so the provider redelivers later.
   */
  private async runFetchStage(
    sourceName: string,
    source: IngestionSource,
  ): Promise<WebhookResponse> {
    const stage = this.fetchStages[sourceName]
    if (!stage) {
      return { status: 500, body: { error: `no fetch stage wired for source "${sourceName}"` } }
    }
    let result: FetchStageResult
    try {
      result = await stage(this.queue.cursor(sourceName))
    } catch {
      return { status: 500, body: { error: 'fetch stage failed; expecting redelivery' } }
    }
    if (result.reset) {
      this.onNotice?.(
        `Event source "${sourceName}" lost its provider cursor; there may be a gap in ingested events.`,
      )
    }
    const outcomes = this.queue.ingestBatch(
      result.events.map((event) => ({ event, spaceId: source.spaceId })),
      { source: sourceName, value: result.nextCursor },
    )
    let accepted = 0
    for (const outcome of outcomes) {
      if (outcome.outcome !== 'queued') continue
      const decided = await this.decideAndDeliver(outcome.queueId, source)
      if (decided.status === 'accepted') accepted += 1
    }
    return { status: 200, body: { outcome: 'fetched', queued: outcomes.length, accepted } }
  }

  private async decideAndDeliver(queueId: number, source: IngestionSource): Promise<QueuedEvent> {
    const row = this.queue.getEvent(queueId)
    if (!row) throw new Error(`unknown queued event: ${queueId}`)
    const verdict = evaluatePreFilter(row.event, source.filters, this.similarity)
    const decided = this.queue.decide(queueId, verdict)
    if (decided.status === 'accepted') {
      this.appendAcceptNotice(decided)
      await this.deliver(decided)
    }
    return this.queue.getEvent(queueId) ?? decided
  }

  /**
   * The Agent's only view of an acceptance. Appended once, at the accept
   * transition — never on re-delivery, so boot recovery cannot spam the
   * log. It carries no external strings: source name and queue id come
   * from trusted config, never from the sender (SECURITY.md §3.1).
   */
  private appendAcceptNotice(row: QueuedEvent): void {
    try {
      this.store.spacesEngine.appendEvent(row.spaceId, {
        type: 'ingestion.accept',
        text: `External event accepted from source "${row.source}" — queued for the quarantined reader (queue #${row.id})`,
        origin: 'untrusted:external',
        payload: { queueId: row.id, source: row.source },
        at: this.now().toISOString(),
      })
    } catch (error) {
      console.error(`ingestion accept notice failed for queue #${row.id}`, error)
    }
  }

  /**
   * Hand an accepted event to the reader seam. Without a wired reader
   * (issue #13 not landed) rows stay `accepted` and undelivered — the
   * durable backlog the reader drains at its first boot. `delivered_at`
   * only ever means "the reader handoff returned".
   *
   * `onAccepted` may be async (the reader call is an LLM round-trip): the
   * webhook HTTP response now waits for it to resolve before `markDelivered`
   * runs, so a crash between the two never loses the row. Dedup + this
   * at-least-once discipline make provider redelivery safe; revisit with a
   * worker queue if reader latency ever threatens push ack deadlines.
   * This must never throw — a rejected `onAccepted` leaves the row
   * undelivered for boot retry, exactly like the synchronous failure case.
   */
  private async deliver(row: QueuedEvent): Promise<void> {
    if (!this.onAccepted) return
    try {
      await this.onAccepted({
        queueId: row.id,
        spaceId: row.spaceId,
        acceptedAt: row.decidedAt ?? this.now().toISOString(),
        event: row.event,
      })
      this.queue.markDelivered(row.id)
    } catch (error) {
      // Stays undelivered: boot recovery re-runs it (at-least-once).
      console.error(`ingestion reader handoff failed for queue #${row.id}; will retry`, error)
    }
  }
}

function sha256Hex(body: Buffer): string {
  return createHash('sha256').update(body).digest('hex')
}

function lowercaseKeys(headers: Record<string, string>): Record<string, string> {
  const normalized: Record<string, string> = {}
  for (const [name, value] of Object.entries(headers)) normalized[name.toLowerCase()] = value
  return normalized
}
