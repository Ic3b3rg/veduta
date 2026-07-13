import { randomUUID } from 'node:crypto'
import { computeContextHash, type ToolContext, type ToolDef } from './agent-runner.ts'
import type { NormalizedChannelEvent } from './channel-adapter.ts'
import type { SpacesEngine } from './spaces-engine.ts'
import { effectiveOrigin, gateToolsForOrigins, TurnTaintAccumulator, type Origin } from './taint.ts'

/**
 * Dev-profile chat dispatcher (issue #14, D12) — a deterministic stand-in
 * for the future Agent loop, exactly like `armReminderFromChat`/the mock
 * chat→Surface effect it sits alongside in `server.ts`. It recognizes two
 * fixed command shapes ("send to <addr>: <text>", "transfer <amount> to
 * <addr>") and dispatches straight to the already trust-wrapped outbound
 * tools (`outbound-tools.ts`), building the same live turn-context contract
 * (`ToolContext.taint`/`origins`/`contextHash`, D10/A1/A3) a real runner
 * would build for one tool call — so the trust layer's decision matrix
 * (allow / card / deny) is exercised exactly as it would be from a real
 * turn. This module is a placeholder: the real Agent loop replaces it
 * outright (`onDevChatEffect` disappears), it is never extended by it.
 */

const SEND_RE = /^send to\s+(\S+)\s*:\s*(.+)$/i
const TRANSFER_RE = /^transfer\s+([0-9]+(?:\.[0-9]+)?)\s+to\s+(\S+)$/i

interface ParsedCommand {
  toolName: string
  input: unknown
}

function parseCommand(text: string): ParsedCommand | undefined {
  const trimmed = text.trim()

  const sendMatch = SEND_RE.exec(trimmed)
  if (sendMatch) {
    const [, to, body] = sendMatch
    return { toolName: 'send_message', input: { to, body } }
  }

  const transferMatch = TRANSFER_RE.exec(trimmed)
  if (transferMatch) {
    const [, amount, to] = transferMatch
    return { toolName: 'transfer_funds', input: { to, amount: Number(amount) } }
  }

  return undefined
}

export interface DevDispatchOptions {
  spacesEngine: SpacesEngine
  /** The trust-wrapped tool set (`trust.wrapTools(createOutboundTools(...))`) offered to this dev turn. */
  tools: ToolDef[]
  /** `isTrustWrapped` from `trust-layer.ts`, forwarded to `gateToolsForOrigins` (D5). */
  isTrustWrapped: (tool: ToolDef) => boolean
  /** Out-of-band reply to the originating client (`GatewayHub.replyToClient`). */
  reply: (clientId: string, text: string) => void
  now?: () => Date
}

/**
 * Builds the `onDevChatEffect` handler. Returns void synchronously (the
 * Gateway's callback contract): matched commands dispatch asynchronously,
 * with every error caught and turned into a chat reply rather than an
 * unhandled rejection.
 */
export function createDevDispatch(
  options: DevDispatchOptions,
): (event: NormalizedChannelEvent) => void {
  return (event: NormalizedChannelEvent) => {
    const parsed = parseCommand(event.text)
    if (!parsed) return

    if (event.spaceId === undefined) {
      options.reply(
        event.clientId,
        'This action needs a Space — try it from inside one, not the global chat.',
      )
      return
    }

    void runDispatch(options, event, event.spaceId, parsed).catch((error: unknown) => {
      console.error('dev-dispatch: tool invocation failed', error)
      options.reply(event.clientId, 'Something went wrong running that action.')
    })
  }
}

async function runDispatch(
  options: DevDispatchOptions,
  event: NormalizedChannelEvent,
  spaceId: string,
  parsed: ParsedCommand,
): Promise<void> {
  const seed: Origin[] = ['trusted:user', ...options.spacesEngine.contextOrigins(spaceId)]
  const gated = gateToolsForOrigins(options.tools, seed, options.isTrustWrapped)
  const tool = gated.find((candidate) => candidate.name === parsed.toolName)
  if (!tool) {
    options.reply(event.clientId, `"${parsed.toolName}" is not available.`)
    return
  }

  const validated = tool.schema.safeParse(parsed.input)
  if (!validated.success) {
    options.reply(event.clientId, `That doesn't look like a valid ${parsed.toolName} request.`)
    return
  }

  const taint = new TurnTaintAccumulator(seed)
  const context: ToolContext = {
    toolCallId: randomUUID(),
    origin: effectiveOrigin(seed, 'trusted:user'),
    origins: seed,
    taint,
    spaceId,
    trigger: { kind: 'chat', summary: event.text },
    contextHash: computeContextHash({ input: event.text, spaceId }),
  }

  const result = await tool.handler(validated.data, context)
  options.reply(event.clientId, result.content)
}
