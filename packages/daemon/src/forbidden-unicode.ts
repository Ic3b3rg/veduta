import type { JsonObject, JsonValue } from '@veduta/protocol'

/**
 * Unicode characters that Veduta removes at durable-memory boundaries.
 * Exact set: U+200B, U+200E-U+200F, U+FEFF, U+2028-U+202E,
 * U+2066-U+2069, and U+E0000-U+E007F.
 * The set is intentionally narrow: U+200C (ZWNJ) and U+200D (ZWJ) are
 * legitimate writing-system and emoji joiners and must round-trip unchanged.
 * See issues/128-sanitize-forbidden-unicode.md.
 */
const FORBIDDEN_UNICODE_RE =
  /[\u200B\u200E\u200F\uFEFF\u2028-\u202E\u2066-\u2069\u{E0000}-\u{E007F}]/gu

/** Removes Veduta's exact forbidden injection-corpus Unicode set from text. */
export function stripForbiddenUnicode(input: string): string {
  return input.replace(FORBIDDEN_UNICODE_RE, '')
}

export class ForbiddenUnicodeKeyCollisionError extends Error {
  constructor() {
    super('Forbidden Unicode sanitization caused an object key collision')
    this.name = 'ForbiddenUnicodeKeyCollisionError'
  }
}

/**
 * Clones a JSON value while removing forbidden Unicode from every string
 * leaf and object key. Non-string JSON primitives round-trip unchanged.
 */
export function sanitizeJsonForForbiddenUnicode(value: JsonValue): JsonValue {
  return sanitizeJsonValue(value)
}

/** Object-specialized entry point for durable JSON payload boundaries. */
export function sanitizeJsonObjectForForbiddenUnicode(value: JsonObject): JsonObject {
  return sanitizeJsonObject(value)
}

function sanitizeJsonValue(value: JsonValue): JsonValue {
  if (typeof value === 'string') return stripForbiddenUnicode(value)
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(sanitizeJsonValue)

  return sanitizeJsonObject(value)
}

function sanitizeJsonObject(value: JsonObject): JsonObject {
  const keys = new Set<string>()
  const entries: [string, JsonValue][] = []
  for (const [key, entry] of Object.entries(value)) {
    const sanitizedKey = stripForbiddenUnicode(key)
    if (keys.has(sanitizedKey)) {
      throw new ForbiddenUnicodeKeyCollisionError()
    }
    keys.add(sanitizedKey)
    entries.push([sanitizedKey, sanitizeJsonValue(entry)])
  }
  return Object.fromEntries(entries)
}
