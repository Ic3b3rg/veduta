import { ModelConnectionError } from './model-connection-adapter.ts'
import type {
  PiChatContext,
  PiImageContent,
  PiTextContent,
  PiThinkingContent,
  PiToolCall,
} from './pi-provider-bridge.ts'

/**
 * The exact `PiChatContext` → text mapping a subscription-transport
 * connection's turn is built from (issue #47,
 * docs/adr/0014-subscription-inference-boundary.md). A subscription
 * connection (Codex today) never receives pi's structured `Context` — it
 * only ever sees rendered text
 * (`renderSubscriptionPrompt`'s single `turn/start` input) — so this module
 * is the ONE place that decides what of a turn's history survives the trip
 * and how. Import boundary: every pi-ai-shaped type here comes from
 * `pi-provider-bridge.ts`'s re-exports, never `@earendil-works/pi-ai`
 * directly (`import-boundary.test.ts`).
 *
 * Mapping rules, exactly:
 * - `systemPrompt` = `context.systemPrompt ?? ''`, verbatim.
 * - A `UserMessage`'s string content maps to that string; array content maps
 *   every `TextContent.text` joined with `'\n'`, and each `ImageContent` to
 *   the literal line `[image omitted: <mimeType>]` — a Codex turn takes
 *   text input only, so an image is declared as dropped, never silently
 *   discarded.
 * - An `AssistantMessage`'s `TextContent`s join with `'\n'`; every
 *   `ThinkingContent` is DROPPED (another provider's reasoning is never
 *   replayed as this turn's history); each `ToolCall` renders as
 *   `[tool call: <name>]` — history context only, never an instruction.
 * - A `ToolResultMessage` maps to `{ role: 'tool', toolName, text, isError }`,
 *   `text` being its `TextContent`s joined with `'\n'` (an `ImageContent`
 *   result renders the same `[image omitted: <mimeType>]` line).
 * - `context.tools` is NEVER serialized. A non-empty `tools` array throws —
 *   fail closed, defence in depth behind the runner-level tool filter
 *   (`pi-agent-runner.ts`'s `toolsEnabledForModel`).
 */

export interface SubscriptionPrompt {
  systemPrompt: string
  messages: SubscriptionPromptMessage[]
}

export type SubscriptionPromptMessage =
  | { role: 'user'; text: string }
  | { role: 'assistant'; text: string }
  | { role: 'tool'; toolName: string; text: string; isError: boolean }

/** Thrown when `context.tools` is non-empty — the exact message a `ModelConnectionError('unsupported', …)` carries. */
const TOOLS_NOT_SUPPORTED_MESSAGE =
  'this Model connection answers in text only; refusing a turn that was given Veduta tools'

export function toSubscriptionPrompt(context: PiChatContext): SubscriptionPrompt {
  if (context.tools && context.tools.length > 0) {
    throw new ModelConnectionError('unsupported', TOOLS_NOT_SUPPORTED_MESSAGE)
  }
  return {
    systemPrompt: context.systemPrompt ?? '',
    messages: context.messages.map(toSubscriptionPromptMessage),
  }
}

function toSubscriptionPromptMessage(
  message: PiChatContext['messages'][number],
): SubscriptionPromptMessage {
  if (message.role === 'user') {
    return { role: 'user', text: userOrToolContentText(message.content) }
  }
  if (message.role === 'assistant') {
    return { role: 'assistant', text: assistantContentText(message.content) }
  }
  return {
    role: 'tool',
    toolName: message.toolName,
    text: userOrToolContentText(message.content),
    isError: message.isError,
  }
}

/** Shared by `UserMessage.content` and `ToolResultMessage.content` — both are `string | (TextContent | ImageContent)[]`... except a tool result's content is never a bare string, so this always sees the array branch there. Kept as one function since the per-block rendering rule is identical either way. */
function userOrToolContentText(content: string | (PiTextContent | PiImageContent)[]): string {
  if (typeof content === 'string') return content
  return content
    .map((block) => (block.type === 'text' ? block.text : `[image omitted: ${block.mimeType}]`))
    .join('\n')
}

function assistantContentText(content: (PiTextContent | PiThinkingContent | PiToolCall)[]): string {
  return content
    .flatMap((block) => {
      if (block.type === 'text') return [block.text]
      if (block.type === 'thinking') return [] // dropped, never replayed
      return [`[tool call: ${block.name}]`]
    })
    .join('\n')
}

/**
 * The single `turn/start` input a subscription connection's turn is built
 * from: the system prompt, then `\n\n---\n\n`, then every message rendered
 * as `User:\n…` / `Assistant:\n…` / `Tool <name>:\n…`
 * (`Tool <name> (error):\n…` when `isError`), joined by `\n\n`.
 * Deterministic — snapshot-tested.
 */
export function renderSubscriptionPrompt(prompt: SubscriptionPrompt): string {
  const body = prompt.messages.map(renderSubscriptionPromptMessage).join('\n\n')
  return `${prompt.systemPrompt}\n\n---\n\n${body}`
}

function renderSubscriptionPromptMessage(message: SubscriptionPromptMessage): string {
  if (message.role === 'user') return `User:\n${message.text}`
  if (message.role === 'assistant') return `Assistant:\n${message.text}`
  const label = message.isError ? `Tool ${message.toolName} (error)` : `Tool ${message.toolName}`
  return `${label}:\n${message.text}`
}
