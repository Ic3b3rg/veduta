import type { JsonObject, JsonValue, PatchOperation } from '@veduta/protocol'
import {
  piFauxAssistantMessage,
  piFauxText,
  piFauxToolCall,
  type MockResponder,
  type PiAssistantMessage,
  type PiChatContext,
} from './pi-provider-bridge.ts'
import type { Store } from './store.ts'

/**
 * The Loopback profile's deterministic model (issue #37): this is the
 * `MockResponder` `withMockFallback` (model-routing.ts) resolves to when no
 * provider key is configured. It reproduces the pre-issue-37 chat demo
 * behaviors — meal logging, a "remind me… by <time>" timer, "send to"/
 * "transfer" outbound actions, and a "research <topic>" Worker dispatch —
 * but every one of them now returns a *tool call* for the real Agent loop's
 * gated tool registry to execute, instead of a parallel handler dispatching
 * straight to a tool or a Space mutation itself. Issue #37's acceptance
 * criterion is explicit: "loopback behavior preserved by the mock provider
 * candidate, never through a parallel handler."
 *
 * Reading the `Store` here is acceptable exactly because this is the mock
 * *model*, standing in for what a real model would infer from the assembled
 * turn context (`ARCHITECTURE.md`'s context-assembly flow) — nothing else in
 * the daemon's product code path is allowed to peek at Store state to decide
 * what a model "would have said".
 */

/** Historical fallback Space (the pre-issue-37 chat stand-ins used the same
 * default): global chat's `systemPrompt` (chat-loop.ts's `buildContext`) has
 * no Active Space section at all, so the reminder branch below — the one
 * branch whose tool schema requires `spaceId` as a call argument rather than
 * reading it off `ToolContext` — falls back to this Space, exactly like the
 * stand-ins it replaces.
 */
const DEFAULT_SPACE_ID = 'spc-health'

/**
 * `spaces-engine.ts`'s `assembleContext` renders the turn's active Space as
 * a `# Active Space` section whose first line is `<name> (<slug>)`
 * (`section()`'s heading rule); Space ids are always `spc-<slug>`
 * (`spaces-engine.ts`'s `createSpace`). Parsed straight out of
 * `context.systemPrompt` — pi-ai's `Context` carries no Space identity of
 * its own, only `systemPrompt`/`messages`/`tools` — since that is the only
 * place a Space chat turn's own identity survives into the mock model.
 */
const ACTIVE_SPACE_RE = /# Active Space\n\n.*\(([^()]+)\)/

/** The turn's active Space id, parsed from the systemPrompt's Active Space section; `DEFAULT_SPACE_ID` for global chat, which has no such section. */
function activeSpaceId(context: PiChatContext): string {
  const match = ACTIVE_SPACE_RE.exec(context.systemPrompt ?? '')
  return match?.[1] ? `spc-${match[1]}` : DEFAULT_SPACE_ID
}

const MEAL_SURFACE_ID = 'srf-meals'

const MEAL_RE = /\bi\s+ate\s+(.+)$/i
const REMINDER_RE = /\bremind me to\s+(.+?)\s+by\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i
const SEND_RE = /^send to\s+(\S+)\s*:\s*(.+)$/i
const TRANSFER_RE = /^transfer\s+([0-9]+(?:\.[0-9]+)?)\s+to\s+(\S+)$/i
const RESEARCH_RE = /^research\s+(.+)$/i
const HELP_RE = /help|aiuto/i

export interface MockChatModelOptions {
  store: Store
  now?: () => Date
}

/** `PiChatContext['messages']`'s element type, named locally so this file never
 * needs its own `import` of pi-ai's `Message` union (`import-boundary.test.ts`
 * only lets `pi-provider-bridge.ts` import pi-ai directly). */
type PiTurnMessage = PiChatContext['messages'][number]
type PiUserMessage = Extract<PiTurnMessage, { role: 'user' }>
type PiToolResultMessage = Extract<PiTurnMessage, { role: 'toolResult' }>
type PiUserContentArray = Extract<PiUserMessage['content'], unknown[]>
type PiUserContentBlock = PiUserContentArray[number]

/**
 * Builds the Loopback profile's `MockResponder`: given the live turn
 * context, finds the last user message and whether a tool already ran since
 * then, and returns the next assistant message deterministically.
 */
export function createMockChatResponder(options: MockChatModelOptions): MockResponder {
  const now = options.now ?? (() => new Date())

  return (context) => {
    const lastUserIndex = findLastIndex(context.messages, isUserMessage)
    if (lastUserIndex === -1) return echoMessage('')

    const toolResultAfter = context.messages
      .slice(lastUserIndex + 1)
      .find((message): message is PiToolResultMessage => isToolResultMessage(message))
    if (toolResultAfter) return closingMessage(toolResultAfter)

    const text = userMessageText(context.messages[lastUserIndex] as PiUserMessage).trim()
    return respondToUserText(text, options.store, now(), activeSpaceId(context))
  }
}

function respondToUserText(
  text: string,
  store: Store,
  at: Date,
  spaceId: string,
): PiAssistantMessage {
  const meal = mealFromText(text)
  if (meal !== undefined) {
    const surface = store.getSurface(MEAL_SURFACE_ID)
    if (!surface) return echoMessage(text)
    const operations = mealPatchOperations(meal, surface.state, at)
    return toolCallMessage(
      'patch_state',
      { surfaceId: MEAL_SURFACE_ID, operations },
      `Logged: ${meal}.`,
    )
  }

  const reminder = reminderFromText(text, at)
  if (reminder) {
    return toolCallMessage(
      'arm_timer',
      {
        spaceId,
        when: reminder.fireAtIso,
        condition: { kind: 'event-logged', textIncludes: reminder.conditionNeedle },
        action: reminder.action,
      },
      `Armed a reminder to ${reminder.action}.`,
    )
  }

  const send = SEND_RE.exec(text)
  if (send) {
    const [, to, body] = send
    return toolCallMessage('send_message', { to, body }, `Sending a message to ${to}.`)
  }

  const transfer = TRANSFER_RE.exec(text)
  if (transfer) {
    const [, amount, to] = transfer
    return toolCallMessage(
      'transfer_funds',
      { to, amount: Number(amount) },
      `Transferring ${amount} to ${to}.`,
    )
  }

  const research = RESEARCH_RE.exec(text)
  if (research) {
    const topic = research[1]!.trim()
    if (topic) {
      return toolCallMessage(
        'spawn_worker',
        {
          goal: topic,
          tokenBudget: 100_000,
          maxIterations: 6,
          tier: 'reasoning',
          highRisk: true,
        },
        `Researching: ${topic}`,
      )
    }
  }

  return echoMessage(text)
}

// ---------------------------------------------------------------------------
// Text-only replies (the pre-issue-37 mock provider's echo logic)
// ---------------------------------------------------------------------------

function echoMessage(text: string): PiAssistantMessage {
  if (text === '') return piFauxAssistantMessage('Say something and I will echo it back.')
  if (HELP_RE.test(text)) {
    return piFauxAssistantMessage(
      'I am the mock provider. The Agent runtime is isolated behind AgentRunner; chat wiring ' +
        'still answers deterministically, with no API key.',
    )
  }
  return piFauxAssistantMessage(`[mock] You said: "${text}".`)
}

/** The follow-up model call after a tool ran: a short, stable closing line. */
function closingMessage(toolResult: PiToolResultMessage): PiAssistantMessage {
  return piFauxAssistantMessage(`Done — ${toolResult.toolName} completed.`)
}

function toolCallMessage(
  name: string,
  args: Record<string, unknown>,
  text: string,
): PiAssistantMessage {
  return piFauxAssistantMessage([piFauxText(text), piFauxToolCall(name, args)], {
    stopReason: 'toolUse',
  })
}

// ---------------------------------------------------------------------------
// Parsing (migrated from the pre-issue-37 chat stand-ins, since deleted:
// this file copies their logic rather than importing it, so it survives
// that deletion unchanged)
// ---------------------------------------------------------------------------

function mealFromText(text: string): string | undefined {
  const match = MEAL_RE.exec(text.trim())
  const meal = match?.[1]?.replace(/[.!?]+$/g, '').trim()
  return meal || undefined
}

// Daemon-local wall-clock time: the Surface shows "when I ate", not UTC.
function timeLabel(at: Date): string {
  return at.toTimeString().slice(0, 5)
}

function mealPatchOperations(meal: string, state: JsonObject, at: Date): PatchOperation[] {
  const existing = Array.isArray(state['meals']) ? state['meals'].filter(isJsonObject) : []
  const meals = [{ time: timeLabel(at), meal }, ...existing].slice(0, 20)
  // Counted apart from the display list, which is truncated to 20 entries.
  const count = typeof state['mealCount'] === 'number' ? state['mealCount'] + 1 : meals.length

  return [
    { target: 'state', op: 'replace', path: '/meals', value: meals },
    { target: 'state', op: 'replace', path: '/lastMeal', value: meal },
    { target: 'state', op: 'replace', path: '/mealCount', value: count },
  ]
}

function isJsonObject(value: JsonValue): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

interface ParsedReminder {
  action: string
  fireAtIso: string
  conditionNeedle: string
}

function reminderFromText(text: string, at: Date): ParsedReminder | undefined {
  const match = REMINDER_RE.exec(text)
  if (!match) return undefined
  const [, rawAction, hourText, minuteText, meridiem] = match

  let hours = Number(hourText)
  if (meridiem?.toLowerCase() === 'pm' && hours < 12) hours += 12
  if (meridiem?.toLowerCase() === 'am' && hours === 12) hours = 0
  const minutes = minuteText === undefined ? 0 : Number(minuteText)
  if (hours > 23 || minutes > 59) return undefined

  const fireAt = new Date(at.getTime())
  fireAt.setHours(hours, minutes, 0, 0)
  if (fireAt.getTime() <= at.getTime()) fireAt.setDate(fireAt.getDate() + 1)

  const action = rawAction!.replace(/[.!?]+$/g, '').trim()
  const needle = action.split(/\s+/).at(-1)
  if (!action || !needle) return undefined
  return { action, fireAtIso: fireAt.toISOString(), conditionNeedle: needle }
}

// ---------------------------------------------------------------------------
// pi-ai message shape helpers
// ---------------------------------------------------------------------------

function isUserMessage(message: PiTurnMessage): message is PiUserMessage {
  return message.role === 'user'
}

function isToolResultMessage(message: PiTurnMessage): message is PiToolResultMessage {
  return message.role === 'toolResult'
}

function isTextBlock(
  block: PiUserContentBlock,
): block is Extract<PiUserContentBlock, { type: 'text' }> {
  return block.type === 'text'
}

function userMessageText(message: PiUserMessage): string {
  if (typeof message.content === 'string') return message.content
  return message.content
    .filter(isTextBlock)
    .map((block) => block.text)
    .join('\n')
}

function findLastIndex<T>(items: T[], predicate: (item: T) => boolean): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (predicate(items[index] as T)) return index
  }
  return -1
}
