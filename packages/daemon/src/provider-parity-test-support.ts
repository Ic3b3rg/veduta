import type { AgentEvent, SessionEntry, SessionMessage } from './agent-runner.ts'
import type { SpaceEvent } from './space-events.ts'

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi

/**
 * Provider-parity assertions intentionally ignore provider-assigned ids and
 * text chunk boundaries while retaining every user-visible event field.
 */
export function normalizeAgentEvents(
  events: AgentEvent[],
  options: { includeTurnOrigins?: boolean } = {},
): unknown[] {
  const normalized: unknown[] = []
  let text = ''
  const flushText = () => {
    if (text === '') return
    normalized.push({ type: 'text-delta', text })
    text = ''
  }

  for (const event of events) {
    if (event.type === 'text-delta') {
      text += event.text
      continue
    }
    flushText()
    if (event.type === 'tool-start') {
      normalized.push({ type: event.type, toolName: event.toolName, input: event.input })
      continue
    }
    if (event.type === 'tool-result') {
      normalized.push({
        type: event.type,
        toolName: event.toolName,
        content: normalizeStableValue(event.content),
        details: normalizeStableValue(event.details),
        isError: event.isError,
      })
      continue
    }
    if (event.type === 'turn-end') {
      normalized.push({
        type: event.type,
        text: event.text,
        ...(options.includeTurnOrigins ? { origins: event.origins } : {}),
      })
      continue
    }
    normalized.push(normalizeStableValue(event))
  }
  flushText()
  return normalized
}

export function normalizeSessionEntries(entries: SessionEntry[]): unknown[] {
  return entries.map((entry) => {
    if (entry.type === 'message') {
      return { type: entry.type, message: normalizeSessionMessage(entry.message) }
    }
    if (entry.type === 'model-change') return { type: entry.type }
    return {
      type: entry.type,
      summary: entry.summary,
      details: normalizeStableValue(entry.details),
    }
  })
}

function normalizeSessionMessage(message: SessionMessage): unknown {
  return {
    role: message.role,
    content: normalizeStableValue(message.content),
    ...(message.toolName === undefined ? {} : { toolName: message.toolName }),
    ...(message.details === undefined ? {} : { details: normalizeStableValue(message.details) }),
    ...(message.isError === undefined ? {} : { isError: message.isError }),
    ...(message.origin === undefined ? {} : { origin: message.origin }),
    ...(message.origins === undefined ? {} : { origins: message.origins }),
  }
}

/** Normalizes provider-assigned tool-call ids nested in Agent-turn Event payloads. */
export function normalizeSpaceEvent(event: SpaceEvent): unknown {
  return {
    type: event.type,
    text: normalizeStableValue(event.text),
    origin: event.origin,
    ...(event.payload === undefined
      ? {}
      : { payload: normalizeStableValue(withoutToolCallIds(event.payload)) }),
  }
}

function withoutToolCallIds(payload: Record<string, unknown>): Record<string, unknown> {
  const toolCalls = payload['toolCalls']
  if (!Array.isArray(toolCalls)) return payload
  return {
    ...payload,
    toolCalls: toolCalls.map((call) =>
      isRecord(call) ? { toolName: call['toolName'] } : normalizeStableValue(call),
    ),
  }
}

/** Replaces non-deterministic effect ids anywhere in a parity outcome. */
export function normalizeStableValue(value: unknown): unknown {
  if (typeof value === 'string') return value.replace(UUID_RE, '<id>')
  if (Array.isArray(value)) return value.map(normalizeStableValue)
  if (!isRecord(value)) return value
  return Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [key, normalizeStableValue(nested)]),
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
