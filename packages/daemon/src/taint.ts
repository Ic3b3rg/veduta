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
 * SECURITY.md §3.2 / ADR-0007, enforced in code. Two regimes, selected by
 * whether a wrapping predicate is supplied:
 *
 * - No `isWrapped` (the pre-trust-layer regime, issue #13): if any origin
 *   feeding a turn is untrusted, only `level: 'L0'` tools survive — the
 *   model cannot call what it does not have. L1+ tools are removed
 *   outright, not just denied at call time.
 *
 * - `isWrapped` supplied (issue #14's trust layer wraps every registered
 *   L1/L2 tool before offering it to a turn): `L0` tools always pass; `L1`
 *   and `L2` tools pass iff `isWrapped(tool)` is true — **regardless of the
 *   turn's taint**. The model is allowed to see and call a wrapped action
 *   even in a tainted turn, because the wrapped handler makes the real
 *   allow/card/deny decision at execution time, reading the *live* taint
 *   accumulator (`ToolContext.taint`, D10/A1) rather than this pre-turn
 *   snapshot — that is how issue #14's approval cards re-admit L1+ instead
 *   of stripping it. An unwrapped L1/L2 tool is still stripped
 *   unconditionally: nothing reaches the model without either `L0` or a
 *   trust wrapper.
 *
 * Fail-closed in both regimes: a tool whose `level` is missing or not one
 * of `'L0'`/`'L1'`/`'L2'` never survives, wrapped or not. In addition — and
 * ahead of either regime's own filtering — a tool that declares `level:
 * 'L0'` yet also declares a non-empty `egressDomains` is dropped
 * unconditionally, regardless of taint, wrapping, or an `isWrapped`
 * predicate that (wrongly) claims it: default L1 for everything that
 * leaves the daemon (ADR-0007) is only meaningful if a tool cannot declare
 * its way out of it by shipping unregistered. `TrustLayer.register` rejects
 * this combination for *registered* tools, but an unregistered `L0` tool
 * with `egressDomains` would otherwise sail through both regimes above
 * untouched — this is the fail-closed backstop for that gap.
 *
 * Generic over `T extends { level?: string; egressDomains?: readonly
 * string[] }` rather than the concrete `ToolDef` so this compiles both
 * before and after `ToolDef.level`/`egressDomains` become required fields.
 */
export function gateToolsForOrigins<
  T extends { level?: string; egressDomains?: readonly string[] },
>(tools: T[], origins: Iterable<Origin | undefined>, isWrapped?: (tool: T) => boolean): T[] {
  const withoutUngatedEgress = tools.filter(
    (tool) => !(tool.level === 'L0' && (tool.egressDomains?.length ?? 0) > 0),
  )
  if (isWrapped) {
    return withoutUngatedEgress.filter(
      (tool) =>
        tool.level === 'L0' || ((tool.level === 'L1' || tool.level === 'L2') && isWrapped(tool)),
    )
  }
  if (!hasUntrusted(origins)) return withoutUngatedEgress
  return withoutUngatedEgress.filter((tool) => tool.level === 'L0')
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
 * Per-turn mutable taint accumulator (D10/A1, issue #14): seeded by the
 * runner from the turn's origin chain (prompt origin + `contextOrigins` +
 * every session-message origin) at turn start, then grown as tool results
 * reveal further provenance mid-turn — e.g. `read_recent` surfacing an
 * untrusted event inside an otherwise-trusted turn. Trust decisions must
 * read `origins()` live, at the moment they execute, never a pre-turn
 * snapshot: a trusted turn that reads untrusted content partway through
 * still gates as tainted for whatever it does next.
 */
export interface TurnTaint {
  add(origin: Origin): void
  origins(): Origin[]
}

/** The runners' shared `TurnTaint` implementation: a de-duplicating set. */
export class TurnTaintAccumulator implements TurnTaint {
  private readonly seen = new Set<Origin>()

  constructor(seed: Iterable<Origin | undefined> = []) {
    for (const origin of seed) {
      if (origin !== undefined) this.seen.add(origin)
    }
  }

  add(origin: Origin): void {
    this.seen.add(origin)
  }

  origins(): Origin[] {
    return Array.from(this.seen)
  }
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
