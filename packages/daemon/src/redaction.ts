/**
 * Secret redaction (issue #15 T3, docs/SECURITY.md §4): the single place
 * that turns a string, an error, or an arbitrary structured value into a
 * version safe to hand to a durable sink (Event log, audit rows,
 * usage JSONL, denial logs) or a user-visible/console surface.
 *
 * Two redaction sources compose:
 *  - Registered literal values: exact secrets seen at resolution time
 *    (vault/env resolution registers here — issue #15 T2 wiring). Matched
 *    longest-first so one registered value can never leave a fragment of
 *    another behind (e.g. a short secret that happens to be a prefix of a
 *    longer one).
 *  - Built-in shape patterns for common API key/token formats, so a key
 *    that was never explicitly registered (leaked into an error message
 *    before resolution, or from a provider we don't have a literal for)
 *    still gets caught.
 *
 * `defaultRedactor` is the process-wide shared instance: T4 wiring
 * registers resolved secrets against this instance, and every sink
 * (`sanitizeErrorText` below, the future console wrapper, event/audit
 * writes) redacts through it, so a secret registered anywhere is redacted
 * everywhere.
 */

const MIN_REGISTERED_LENGTH = 4

/**
 * Built-in shape patterns, tried in order. `sk-ant-` must come before the
 * generic `sk-` pattern or the anthropic-specific prefix would never match
 * (the generic pattern would consume it first and leave `-ant-...` behind).
 */
const BUILT_IN_PATTERNS: RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{8,}/g,
  /sk-[A-Za-z0-9_-]{8,}/g,
  /Bearer\s+[A-Za-z0-9._~+/-]+=*/gi,
  /vdt_[A-Za-z0-9_-]{8,}/g,
  /AKIA[0-9A-Z]{12,}/g,
]

const REDACTED = '[redacted]'

/**
 * Redacts literal secret values and common API key/token shapes out of
 * text and arbitrary structured values. See module doc for the two
 * redaction sources and their ordering.
 */
export class SecretRedactor {
  private readonly registered = new Set<string>()

  /**
   * Records a literal secret value to redact on every future call. Values
   * shorter than `MIN_REGISTERED_LENGTH` are ignored — redacting a very
   * short string would match unrelated text throughout logs.
   */
  register(value: string): void {
    if (value.length < MIN_REGISTERED_LENGTH) return
    this.registered.add(value)
  }

  /**
   * Replaces every registered literal value and every built-in pattern
   * match with `[redacted]`. Registered values are matched longest-first
   * so a shorter registered value that is a prefix/substring of a longer
   * one never leaves a residue of the longer one behind.
   */
  redactText(text: string): string {
    let result = text
    const longestFirst = [...this.registered].sort((a, b) => b.length - a.length)
    for (const value of longestFirst) {
      if (value.length === 0) continue
      result = result.split(value).join(REDACTED)
    }
    for (const pattern of BUILT_IN_PATTERNS) {
      result = result.replace(pattern, REDACTED)
    }
    return result
  }

  /**
   * Structurally clones `value`, redacting every string leaf (via
   * `redactText`), recursing into arrays and plain objects, converting
   * `Error` instances to a redacted message string, and leaving numbers,
   * booleans, null and undefined untouched. Guards against cyclic
   * structures with a seen-set — a cycle renders as `'[cycle]'` rather
   * than throwing or looping forever.
   */
  redactDeep(value: unknown, seen: Set<object> = new Set()): unknown {
    if (typeof value === 'string') return this.redactText(value)
    if (value instanceof Error) return this.redactText(`${value.name}: ${value.message}`)
    if (value === null || typeof value !== 'object') return value

    if (seen.has(value)) return '[cycle]'
    seen.add(value)

    if (Array.isArray(value)) {
      return value.map((entry) => this.redactDeep(entry, seen))
    }

    const source = value as Record<string, unknown>
    const result: Record<string, unknown> = {}
    for (const key of Object.keys(source)) {
      result[key] = this.redactDeep(source[key], seen)
    }
    return result
  }

  /**
   * Redacted, single-line representation of an error for log call sites:
   * the error's name and message with every known secret shape stripped.
   */
  redactError(error: unknown): string {
    const name = error instanceof Error ? error.name : 'Error'
    const message = error instanceof Error ? error.message : String(error)
    return this.redactText(`${name}: ${message}`)
  }
}

/**
 * Process-wide shared instance. T4 wiring registers resolved vault/env
 * secret values against this instance so every sink shares one set of
 * known secrets.
 */
export const defaultRedactor = new SecretRedactor()

/** Guards `installConsoleRedaction` so a repeated call (e.g. test re-imports) never double-wraps `console.*`. */
let consoleRedactionInstalled = false

/**
 * Wraps `console.log/info/warn/error` process-wide so every current and
 * future console call site is covered without touching it (issue #15 D3,
 * v3): a string argument is redacted with `redactText`, an `Error` argument
 * becomes a redacted message string via `redactError`, and everything else
 * (objects, arrays, ...) is structurally redacted with `redactDeep`.
 *
 * Idempotent: a second call is a no-op, guarded by a module-level flag
 * rather than tagging `console` itself, so it is safe to call again across
 * test re-imports without nesting wrappers. Always delegates to the
 * ORIGINAL methods captured before wrapping, so output still reaches the
 * real stream (vitest's own reporter included).
 */
export function installConsoleRedaction(redactor: SecretRedactor = defaultRedactor): void {
  if (consoleRedactionInstalled) return
  consoleRedactionInstalled = true

  const methods = ['log', 'info', 'warn', 'error'] as const
  for (const method of methods) {
    const original = console[method].bind(console)
    console[method] = (...args: unknown[]) => {
      original(...args.map((arg) => redactArgument(arg, redactor)))
    }
  }
}

function redactArgument(arg: unknown, redactor: SecretRedactor): unknown {
  if (typeof arg === 'string') return redactor.redactText(arg)
  if (arg instanceof Error) return redactor.redactError(arg)
  return redactor.redactDeep(arg)
}
