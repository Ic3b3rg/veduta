import type {
  PiChatContext,
  PiImageContent,
  PiTextContent,
  PiThinkingContent,
  PiToolCall,
} from './pi-provider-bridge.ts'

/**
 * The provider-neutral `PiChatContext` mapping a subscription transport
 * receives. It keeps tool definitions, assistant tool calls, and tool
 * results structured while leaving provider protocol types inside the
 * adapter. Import boundary: every pi-ai-shaped type here comes from
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
 * - An `AssistantMessage` keeps ordered text and tool-call blocks; every
 *   `ThinkingContent` is DROPPED (another provider's reasoning is never
 *   replayed as this turn's history).
 * - A `ToolResultMessage` maps to `{ role: 'tool', toolName, text, isError }`,
 *   `text` being its `TextContent`s joined with `'\n'` (an `ImageContent`
 *   result renders the same `[image omitted: <mimeType>]` line).
 * - Each allowed pi tool becomes a provider-neutral definition carrying its
 *   JSON input schema. The Codex adapter alone translates it to
 *   `dynamicTools`.
 */

export interface SubscriptionPrompt {
  systemPrompt: string
  messages: SubscriptionPromptMessage[]
  tools: SubscriptionToolDef[]
}

export interface SubscriptionToolDef {
  name: string
  description: string
  inputSchema: unknown
}

export type SubscriptionAssistantContent =
  | { type: 'text'; text: string }
  | {
      type: 'tool-call'
      toolCallId: string
      toolName: string
      input: Record<string, unknown>
    }

export type SubscriptionPromptMessage =
  | { role: 'user'; text: string }
  | { role: 'assistant'; content: SubscriptionAssistantContent[] }
  | {
      role: 'tool'
      toolCallId: string
      toolName: string
      text: string
      isError: boolean
    }

export function toSubscriptionPrompt(context: PiChatContext): SubscriptionPrompt {
  return {
    systemPrompt: context.systemPrompt ?? '',
    messages: context.messages.map(toSubscriptionPromptMessage),
    tools: (context.tools ?? []).map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.parameters,
    })),
  }
}

function toSubscriptionPromptMessage(
  message: PiChatContext['messages'][number],
): SubscriptionPromptMessage {
  if (message.role === 'user') {
    return { role: 'user', text: userOrToolContentText(message.content) }
  }
  if (message.role === 'assistant') {
    return { role: 'assistant', content: assistantContent(message.content) }
  }
  return {
    role: 'tool',
    toolCallId: message.toolCallId,
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

function assistantContent(
  content: (PiTextContent | PiThinkingContent | PiToolCall)[],
): SubscriptionAssistantContent[] {
  const result: SubscriptionAssistantContent[] = []
  for (const block of content) {
    if (block.type === 'text') {
      result.push({ type: 'text', text: block.text })
      continue
    }
    if (block.type === 'thinking') continue // dropped, never replayed
    result.push({
      type: 'tool-call',
      toolCallId: block.id,
      toolName: block.name,
      input: block.arguments,
    })
  }
  return result
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
  if (message.role === 'assistant') {
    const text = message.content
      .map((block) =>
        block.type === 'text'
          ? block.text
          : `[tool call ${block.toolCallId}: ${block.toolName} ${JSON.stringify(block.input)}]`,
      )
      .join('\n')
    return `Assistant:\n${text}`
  }
  const tool = `Tool ${message.toolName} [${message.toolCallId}]`
  const label = message.isError ? `${tool} (error)` : tool
  return `${label}:\n${message.text}`
}
