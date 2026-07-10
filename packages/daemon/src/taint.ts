/**
 * Taint vocabulary for the trust layer (docs/SECURITY.md §3.2, docs/adr/0007-trust-levels.md).
 *
 * Every piece of context the Agent sees carries an origin. Content the user
 * typed, or the daemon produced itself, is trusted; content that entered
 * through an external, unverified event source (a webhook push, a Gmail
 * message, ...) is `untrusted:<source>`. SECURITY.md §3.2's hard rule — a
 * turn whose context contains untrusted content cannot execute L1+ actions
 * without an approval card, even if an allowlist would otherwise permit it —
 * is enforced here in code, via `gateToolsForOrigins`, not left to the prompt.
 */
export type Origin = 'trusted:user' | 'trusted:system' | `untrusted:${string}`

/** Conservative source-name grammar: lowercase alnum, `-`/`_`, 1-64 chars. */
export const SOURCE_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/

const UNTRUSTED_PREFIX = 'untrusted:'

/**
 * Builds the untrusted origin for an event source. Throws when `source`
 * does not match `SOURCE_NAME_RE`, so a malformed ingestion source name can
 * never inject an arbitrary string into an `Origin` — and therefore never
 * into log text or context rendered back in front of the Agent.
 */
export function untrustedOrigin(source: string): Origin {
  if (!SOURCE_NAME_RE.test(source)) {
    throw new Error(`invalid source name for untrusted origin: ${source}`)
  }
  return `${UNTRUSTED_PREFIX}${source}`
}

/** True when `origin` marks content that entered through an untrusted source. */
export function isUntrusted(origin: Origin): boolean {
  return origin.startsWith(UNTRUSTED_PREFIX)
}

/**
 * Type guard for `Origin`: `'trusted:user'`, `'trusted:system'`, or
 * `untrusted:<source>` where `<source>` matches `SOURCE_NAME_RE`.
 */
export function isValidOrigin(value: unknown): value is Origin {
  if (typeof value !== 'string') return false
  if (value === 'trusted:user' || value === 'trusted:system') return true
  if (!value.startsWith(UNTRUSTED_PREFIX)) return false
  return SOURCE_NAME_RE.test(value.slice(UNTRUSTED_PREFIX.length))
}

/** True when any origin in `origins` is untrusted (`undefined` entries are ignored). */
export function hasUntrusted(origins: Iterable<Origin | undefined>): boolean {
  for (const origin of origins) {
    if (origin !== undefined && isUntrusted(origin)) return true
  }
  return false
}

/**
 * SECURITY.md §3.2 / ADR-0007, enforced in code: if any origin feeding a
 * turn is untrusted, only `level: 'L0'` tools survive for that turn — the
 * model cannot call what it does not have. L1+ tools are removed, not just
 * denied at call time; issue #14's approval cards later re-admit L1 through
 * the card flow, but until then a tainted turn is structurally L0-only.
 *
 * Generic over `T extends { level?: string }` rather than the concrete
 * `ToolDef` so this compiles both before and after `ToolDef.level` becomes a
 * required field: fail-closed either way, a missing or unrecognized level is
 * stripped, never admitted.
 */
export function gateToolsForOrigins<T extends { level?: string }>(
  tools: T[],
  origins: Iterable<Origin | undefined>,
): T[] {
  if (!hasUntrusted(origins)) return tools
  return tools.filter((tool) => tool.level === 'L0')
}

/**
 * The turn's effective origin: the first untrusted origin found among
 * `origins`, else `fallback`. This is the "most-untrusted wins" rule used
 * to derive `ToolContext.origin` and the origin inherited by assistant/tool
 * messages produced during a tainted turn (docs/SECURITY.md §3.2).
 */
export function effectiveOrigin(origins: Iterable<Origin | undefined>, fallback: Origin): Origin {
  for (const origin of origins) {
    if (origin !== undefined && isUntrusted(origin)) return origin
  }
  return fallback
}

/**
 * The origin an L0 tool stamps on daemon state it writes. Taint is not the
 * actor: a trusted turn's tool writes are daemon-produced (`trusted:system`),
 * never `trusted:user` — the scheduler's condition rule admits only genuine
 * user events, and an agent tool write must not be able to self-satisfy it.
 * An untrusted turn's writes keep the untrusted mark (the mark propagates to
 * everything derived from the item, issue #13).
 */
export function toolWriteOrigin(turnOrigin: Origin): Origin {
  return isUntrusted(turnOrigin) ? turnOrigin : 'trusted:system'
}

/** The `<source>` suffix of an untrusted origin, `undefined` for trusted ones. */
export function untrustedSource(origin: Origin): string | undefined {
  return isUntrusted(origin) ? origin.slice(UNTRUSTED_PREFIX.length) : undefined
}

/**
 * Delimiter-collision neutralization, shared by every place that renders
 * untrusted content inside `<<<UNTRUSTED ...>>> ... <<<END ...>>>` blocks
 * (the reader prompt, the full-text turn, context rendering): content
 * containing our own delimiter tokens must never be able to close its block.
 */
export function neutralizeDelimiters(value: string): string {
  return value.replace(/<<</g, '<< <')
}
