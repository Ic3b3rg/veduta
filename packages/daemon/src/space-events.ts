import { readFileSync } from 'node:fs'
import { isJsonValue, type JsonObject, type JsonValue } from '@veduta/protocol'
import {
  sanitizeJsonObjectForForbiddenUnicode,
  stripForbiddenUnicode,
} from './forbidden-unicode.ts'
import { defaultRedactor } from './redaction.ts'
import {
  isUntrusted,
  isValidOrigin,
  untrustedDataBlock,
  untrustedSource,
  type Origin,
} from './taint.ts'
import { normalizeIsoInstant } from './timezone.ts'

export interface SpaceEvent {
  at: string
  spaceId: string
  type: string
  text: string
  origin: Origin
  /** The source timestamp, distinct from the time the Event was recorded. */
  occurredAt?: string
  payload?: JsonObject
}

export interface AppendSpaceEventInput {
  text: string
  type?: string
  at?: string
  occurredAt?: string
  origin?: SpaceEvent['origin']
  payload?: JsonObject
}

/**
 * Removes forbidden Unicode from one Event before it reaches a durable or
 * Agent-visible boundary. This deliberately does not redact secrets; callers
 * that persist must sanitize first and redact second so split credentials are
 * joined before the redactor evaluates them.
 */
export function sanitizeSpaceEvent(event: SpaceEvent): SpaceEvent {
  const at = sanitizeRequiredEventString('at', event.at)
  const spaceId = sanitizeRequiredEventString('spaceId', event.spaceId)
  const type = sanitizeRequiredEventString('type', event.type)
  const text = sanitizeRequiredEventString('text', event.text)
  const origin = sanitizeRequiredEventString('origin', event.origin)
  if (!isValidOrigin(origin)) throw new Error('invalid Event log origin')
  const occurredAt =
    event.occurredAt === undefined ? undefined : stripForbiddenUnicode(event.occurredAt)
  const payload =
    event.payload === undefined ? undefined : sanitizeJsonObjectForForbiddenUnicode(event.payload)

  return {
    at,
    spaceId,
    type,
    text,
    origin,
    ...(occurredAt === undefined ? {} : { occurredAt }),
    ...(payload === undefined ? {} : { payload }),
  }
}

/** Applies the durable Event ordering: forbidden Unicode first, secrets second. */
export function sanitizeAndRedactSpaceEvent(event: SpaceEvent): SpaceEvent {
  const sanitized = sanitizeSpaceEvent(event)
  return {
    ...sanitized,
    type: defaultRedactor.redactText(sanitized.type),
    text: defaultRedactor.redactText(sanitized.text),
    ...(sanitized.payload === undefined ? {} : { payload: redactEventPayload(sanitized.payload) }),
  }
}

export class SecretRedactionKeyCollisionError extends Error {
  constructor() {
    super('Secret redaction caused an Event payload key collision')
    this.name = 'SecretRedactionKeyCollisionError'
  }
}

function redactEventPayload(payload: JsonObject): JsonObject {
  const keys = new Set<string>()
  const entries: [string, JsonValue][] = []
  for (const [key, value] of Object.entries(payload)) {
    const redactedKey = defaultRedactor.redactText(key)
    if (keys.has(redactedKey)) throw new SecretRedactionKeyCollisionError()
    keys.add(redactedKey)
    entries.push([redactedKey, redactEventJsonValue(value)])
  }
  return Object.fromEntries(entries)
}

function redactEventJsonValue(value: JsonValue): JsonValue {
  if (typeof value === 'string') return defaultRedactor.redactText(value)
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(redactEventJsonValue)
  return redactEventPayload(value)
}

function sanitizeRequiredEventString(field: string, value: string): string {
  const sanitized = stripForbiddenUnicode(value)
  if (sanitized.length === 0) {
    throw new Error(`Event ${field} is empty after forbidden Unicode sanitization`)
  }
  return sanitized
}

function readerSummaryBlock(event: SpaceEvent): string | undefined {
  if (event.type !== 'reader.summary') return undefined
  const reader = event.payload?.['reader']
  if (!isJsonObject(reader)) return undefined
  // The Event origin is authoritative; payload source fields are forgeable.
  const source = untrustedSource(event.origin) ?? 'external'
  const fields = Object.entries(reader).map(
    ([key, value]) => [key, formatReaderFieldValue(value)] as [string, string],
  )
  return untrustedDataBlock(source, fields)
}

function formatReaderFieldValue(value: JsonValue): string {
  if (Array.isArray(value)) return value.map(formatReaderFieldValue).join(', ')
  if (value === null) return ''
  return String(value)
}

const MAX_RENDERED_EVENT_TYPE_CHARS = 100

/**
 * Event types render outside untrusted-data delimiters. Restricting them to
 * identifiers prevents old or imported rows from forging delimiter or role
 * syntax while preserving all daemon-generated types.
 */
function renderEventType(type: string): string {
  const identifier = type.replace(/\r?\n/g, ' ').replace(/[^A-Za-z0-9._-]+/g, '-')
  return identifier.slice(0, MAX_RENDERED_EVENT_TYPE_CHARS)
}

/** The canonical taint-aware Event rendering used in all Agent context. */
export function renderEventForContext(input: SpaceEvent): string {
  const event = sanitizeAndRedactSpaceEvent(input)
  const occurred = event.occurredAt === undefined ? '' : ` (occurred ${event.occurredAt})`
  const type = renderEventType(event.type)
  if (!isUntrusted(event.origin)) {
    return `- ${event.at}${occurred} [${type}] [${event.origin}] ${event.text}`
  }
  const line = `- ${event.at}${occurred} [${type}] [${event.origin}]`
  const source = untrustedSource(event.origin) ?? 'external'
  const block = readerSummaryBlock(event) ?? untrustedDataBlock(source, [['text', event.text]])
  return `${line}\n${block}`
}

export function eventsForContext(events: SpaceEvent[]): string {
  if (events.length === 0) return 'No recent events.'
  return events.map(renderEventForContext).join('\n')
}

/**
 * Parses one append-only Event log line. Malformed lines return `undefined`
 * so one corrupt entry cannot hide the rest of a Space's history.
 */
export function parseSpaceEventLine(raw: string): SpaceEvent | undefined {
  if (!raw.trim()) return undefined
  try {
    return parseSpaceEvent(JSON.parse(raw))
  } catch {
    return undefined
  }
}

/** Splits physical JSONL lines without counting the final newline as a row. */
export function splitLogLines(text: string): string[] {
  const lines = text.split(/\r?\n/)
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

export function readEventsFile(path: string): SpaceEvent[] {
  return splitLogLines(readFileSync(path, 'utf8')).flatMap((line) => {
    const event = parseSpaceEventLine(line)
    return event ? [event] : []
  })
}

function parseSpaceEvent(input: unknown): SpaceEvent {
  if (!isRecord(input)) throw new Error('invalid Event log entry')
  const at = stringValue(input['at'])
  const spaceId = stringValue(input['spaceId'])
  const type = stringValue(input['type'])
  const text = stringValue(input['text'])
  const rawOrigin = stringValue(input['origin'])
  if (!at || !spaceId || !type || !text) throw new Error('invalid Event log entry')
  if (rawOrigin === undefined) throw new Error('invalid Event log origin')
  const origin = stripForbiddenUnicode(rawOrigin)
  if (!isValidOrigin(origin)) throw new Error('invalid Event log origin')
  const payload = isJsonObject(input['payload']) ? input['payload'] : undefined
  const rawOccurredAt = stringValue(input['occurredAt'])
  const sanitized = sanitizeAndRedactSpaceEvent({
    at,
    spaceId,
    type,
    text,
    origin,
    ...(rawOccurredAt === undefined ? {} : { occurredAt: rawOccurredAt }),
    ...(payload === undefined ? {} : { payload }),
  })
  // Invalid legacy source timestamps are dropped while the Event remains
  // readable. The append-only log cannot be rewritten in place (ADR-0003).
  const occurredAt = normalizeIsoInstant(sanitized.occurredAt)
  return {
    at: sanitized.at,
    spaceId: sanitized.spaceId,
    type: sanitized.type,
    text: sanitized.text,
    origin: sanitized.origin,
    ...(occurredAt === undefined ? {} : { occurredAt }),
    ...(sanitized.payload === undefined ? {} : { payload: sanitized.payload }),
  }
}

function isJsonObject(value: unknown): value is JsonObject {
  if (!isRecord(value) || Array.isArray(value)) return false
  return Object.values(value).every(isJsonValue)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}
