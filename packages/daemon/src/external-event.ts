import { JsonObjectSchema } from '@veduta/protocol'
import { z } from 'zod'

/**
 * The normalized shape of anything the outside world sends in (issue #12,
 * ADR-0005 level 0): source adapters produce it, the deterministic
 * pre-filters judge it, the queue persists it. Events that fail this
 * schema are discarded and logged, never "interpreted" (SECURITY.md §3.5).
 */
export const ExternalEventSchema = z.object({
  /** Source name from the ingestion config — trusted, never sender-controlled. */
  source: z.string().min(1),
  kind: z.enum(['email', 'calendar', 'webhook']),
  /** Provider identity for dedup: message id, event id + updated stamp, or payload hash. */
  externalId: z.string().min(1),
  /** Provider event type (e.g. `message.received`, a Calendar event status). */
  type: z.string().min(1),
  /** Sender addr-spec, lowercased, when the source knows it. Untrusted content. */
  sender: z.string().optional(),
  /** Untrusted content: stays in the queue for the quarantined reader, never in Agent context. */
  subject: z.string().optional(),
  /** Selected transport headers (lowercased names) for deterministic rules. Untrusted. */
  headers: z.record(z.string()).optional(),
  occurredAt: z.string().datetime({ offset: true }).optional(),
  /** Raw normalized payload, quarantined at rest for the reader. */
  payload: JsonObjectSchema.optional(),
  /**
   * Durable re-fetch contract for issue #13: the quarantined reader pulls
   * the full content (e.g. a Gmail body) itself instead of ingestion
   * storing raw text at rest.
   */
  fetchRef: z.object({ provider: z.string().min(1), id: z.string().min(1) }).optional(),
})

export type ExternalEvent = z.infer<typeof ExternalEventSchema>

/**
 * What `onAccepted` hands to the quarantined reader (issue #13): the
 * surviving event plus its durable queue row. This is the seam — nothing
 * past this point may reach the Agent as raw text.
 */
export interface ReaderHandoff {
  queueId: number
  spaceId: string
  acceptedAt: string
  event: ExternalEvent
}
