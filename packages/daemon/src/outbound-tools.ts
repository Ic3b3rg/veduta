import { z } from 'zod'
import { defineTool, type ToolDef } from './agent-runner.ts'
import type { SpacesEngine } from './spaces-engine.ts'
import { isValidOrigin, toolWriteOrigin } from './taint.ts'
import type { ToolMeta } from './trust-layer.ts'

/**
 * Outbound tools (D11, issue #14): the two example L1/L2 tools whose
 * `handler` actually leaves the daemon process. This module only *defines*
 * `send_message` and `transfer_funds` plus their `ToolMeta` — it does not
 * register them with a `TrustLayer` (that is T9's job in `server.ts`), so a
 * fresh `TrustLayer` in a test can register either tool with whatever
 * `ApprovalCardPort`/options it needs without this module reaching into it.
 */

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

/**
 * The boundary at which a decided tool effect actually leaves the daemon
 * process (an email send, a bank transfer, ...). Implementations MUST be
 * idempotent per `effectId`: the trust layer re-executes a tool's handler
 * with the *same* `effectId` during crash recovery for both `executing` rows
 * interrupted mid-flight and approvals re-approved after a crash (A2,
 * docs/SECURITY.md §5) — a transport that sends twice for one `effectId`
 * would double-charge a bank account or double-send an email on every crash
 * that happens to land between the durable state transition and delivery.
 */
export interface OutboundTransport {
  deliver(delivery: {
    effectId: string
    tool: string
    payload: Record<string, unknown>
  }): Promise<void>
}

/**
 * Dev/test `OutboundTransport`: records every delivery as a Space Event
 * instead of contacting a real mail/bank backend (there is none — issue #15
 * is network egress enforcement and real integrations).
 *
 * Dedupes by `effectId` two ways: an in-memory `Set`, the fast path within
 * one process's lifetime, and a check against the persisted Space log
 * before ever appending (`alreadyDeliveredEvent`) — the actual crash-safety
 * guarantee. The in-memory `Set` alone is NOT enough: the trust layer's own
 * crash-recovery contract replays an interrupted `executing` row's handler
 * with the *same* `effectId`, but that replay can happen in a *fresh*
 * process (a real restart, not just the same run resuming), whose `Set`
 * starts empty. If the crash landed between this transport's prior,
 * already-committed `appendEvent` and the trust layer persisting its own
 * `outcome_event_at` marker, recovery calls `deliver()` again for an
 * `effectId` that already succeeded — only the persisted-log check catches
 * that. A real transport (a mail API, a bank API) would use its own
 * idempotency-key mechanism instead, which is the actual contract this
 * interface documents.
 */
export function createMockOutboundTransport(spacesEngine: SpacesEngine): OutboundTransport {
  const delivered = new Set<string>()
  return {
    async deliver(delivery) {
      if (delivered.has(delivery.effectId)) return
      delivered.add(delivery.effectId)

      const spaceId = delivery.payload['spaceId']
      if (typeof spaceId !== 'string' || spaceId.length === 0) {
        throw new Error(
          `mock outbound transport: delivery for "${delivery.tool}" (${delivery.effectId}) has no spaceId`,
        )
      }
      const origin = delivery.payload['origin']
      if (!isValidOrigin(origin)) {
        throw new Error(
          `mock outbound transport: delivery for "${delivery.tool}" (${delivery.effectId}) has no valid origin`,
        )
      }

      if (alreadyDeliveredEvent(spacesEngine, spaceId, delivery.effectId)) return

      // Untrusted-derived content keeps its untrusted mark here: `origin` is
      // whatever the calling tool computed via `toolWriteOrigin(context.origin)`
      // — this transport never recomputes or launders it.
      spacesEngine.appendEvent(spaceId, {
        type: 'outbound.delivery',
        text: `${delivery.tool} delivered (effect ${delivery.effectId})`,
        origin,
        payload: toEventPayload(delivery),
      })
    },
  }
}

/** The persisted half of this transport's dedupe (see doc comment above). */
function alreadyDeliveredEvent(
  spacesEngine: SpacesEngine,
  spaceId: string,
  effectId: string,
): boolean {
  return spacesEngine
    .readRecent(spaceId, 500)
    .some((event) => event.type === 'outbound.delivery' && event.payload?.['effectId'] === effectId)
}

function toEventPayload(delivery: {
  effectId: string
  tool: string
  payload: Record<string, unknown>
}): Record<string, string | number | boolean | null> {
  const entries = Object.entries(delivery.payload).filter(
    (entry): entry is [string, string | number | boolean | null] => {
      const value = entry[1]
      return (
        typeof value === 'string' ||
        typeof value === 'number' ||
        typeof value === 'boolean' ||
        value === null
      )
    },
  )
  return { effectId: delivery.effectId, tool: delivery.tool, ...Object.fromEntries(entries) }
}

// ---------------------------------------------------------------------------
// send_message (L1)
// ---------------------------------------------------------------------------

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

const SendMessageSchema = z.object({
  // `spaceId` is deliberately absent here: `ToolContext.spaceId` already
  // carries the turn's Space, so an input field would be a second,
  // potentially-conflicting source of truth for the same value.
  to: z.string().trim().min(3).regex(EMAIL_RE, 'to must look like an email address'),
  body: z.string().min(1),
})

export type SendMessageInput = z.infer<typeof SendMessageSchema>

function createSendMessageTool(transport: OutboundTransport): ToolDef<typeof SendMessageSchema> {
  return defineTool({
    name: 'send_message',
    description: 'Send a message to an email address outside the daemon.',
    schema: SendMessageSchema,
    level: 'L1',
    egressDomains: ['mail.example.com'],
    async handler(input, context) {
      const effectId = context.effectId ?? context.toolCallId
      await transport.deliver({
        effectId,
        tool: 'send_message',
        payload: {
          to: input.to,
          body: input.body,
          spaceId: context.spaceId,
          origin: toolWriteOrigin(context.origin),
        },
      })
      return { content: `Sent message to ${input.to}.` }
    },
  })
}

export const sendMessageMeta: ToolMeta<SendMessageInput> = {
  title: (input) => `Send message to ${input.to}`,
  summary: (input) => `To: ${input.to}\n\n${input.body}`,
  editableKeys: ['body'],
  // Normalizes the matching key so "Alice@Example.com" and
  // "alice@example.com" allowlist as the same recipient.
  allowlistParams: ({ to }) => ({ to: String(to).toLowerCase() }),
}

// ---------------------------------------------------------------------------
// transfer_funds (L2)
// ---------------------------------------------------------------------------

const TransferFundsSchema = z.object({
  to: z.string().trim().min(1),
  amount: z.number().positive(),
  currency: z
    .string()
    .trim()
    .regex(/^[A-Z]{3}$/, 'currency must be a 3-letter uppercase code')
    .default('EUR'),
})

export type TransferFundsInput = z.infer<typeof TransferFundsSchema>

function createTransferFundsTool(
  transport: OutboundTransport,
): ToolDef<typeof TransferFundsSchema> {
  return defineTool({
    name: 'transfer_funds',
    description: 'Transfer funds to an external account. Always requires approval (L2).',
    schema: TransferFundsSchema,
    level: 'L2',
    egressDomains: ['bank.example.com'],
    async handler(input, context) {
      const effectId = context.effectId ?? context.toolCallId
      await transport.deliver({
        effectId,
        tool: 'transfer_funds',
        payload: {
          to: input.to,
          amount: input.amount,
          currency: input.currency,
          spaceId: context.spaceId,
          origin: toolWriteOrigin(context.origin),
        },
      })
      return { content: `Transferred ${input.amount} ${input.currency} to ${input.to}.` }
    },
  })
}

export const transferFundsMeta: ToolMeta<TransferFundsInput> = {
  title: (input) => `Transfer ${input.amount} ${input.currency} to ${input.to}`,
  summary: (input) => `Transfer ${input.amount} ${input.currency} to ${input.to}.`,
  // No `allowlistParams`: L2 is never allowlist-eligible — the trust layer's
  // decision matrix only ever consults the allowlist for `L1` (see
  // `trust-layer.ts`'s `canConsultAllowlist`) — omitting the field here
  // avoids even suggesting an allowlist checkbox could apply to this card.
  // No editable fields: a transfer must be rejected and re-requested with a
  // new call, never edited-and-approved in place.
  editableKeys: [],
}

// ---------------------------------------------------------------------------
// Registration bundle (T9 registers these against a `TrustLayer`)
// ---------------------------------------------------------------------------

export interface OutboundToolRegistration {
  tool: ToolDef
  // `ToolMeta<unknown>` mirrors how `TrustLayer.register` itself erases the
  // tool/meta pairing to `unknown` internally (`trust-layer.ts`'s registry
  // map) — `register()`'s own generic signature re-establishes the exact
  // `ToolDef<TSchema>`/`ToolMeta<z.infer<TSchema>>` link at the call site.
  meta: ToolMeta<unknown>
}

export function createOutboundTools(transport: OutboundTransport): OutboundToolRegistration[] {
  return [
    { tool: createSendMessageTool(transport), meta: sendMessageMeta as ToolMeta<unknown> },
    { tool: createTransferFundsTool(transport), meta: transferFundsMeta as ToolMeta<unknown> },
  ]
}
