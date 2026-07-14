import { Agent, setGlobalDispatcher } from 'undici'
import type { Dispatcher } from 'undici'

/**
 * Egress allowlist (issue #15 T1, docs/SECURITY.md §3.4): the daemon may
 * contact only declared hosts (configured LLM providers, active
 * integrations' endpoints, the push service). Everything else is denied at
 * the network level, not the prompt level — a successful prompt injection
 * still has nowhere to exfiltrate to, because the process itself cannot
 * open a connection to an undeclared host.
 *
 * This module supplies the policy (`EgressPolicy`) and the undici
 * `Dispatcher` that enforces it (`createEgressDispatcher`,
 * `installEgressEnforcement`). It does not decide *which* hosts to allow —
 * that is wiring done by callers (LLM provider config, integration
 * registration) against the one process-wide policy instance.
 */

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1'])

/** Placeholder host recorded when an origin cannot be parsed at all — fail closed, never guess. */
const UNPARSEABLE_HOST = '<unparseable>'

/**
 * Thrown by `EgressPolicy.check()` when a host is not on the allowlist.
 *
 * The message carries the *hostname* only. It must never include the URL
 * path or query string: if a prompt injection tricked a tool into building
 * a request like `https://blocked.invalid/steal?facts=<secret>`, the denial
 * itself — surfaced in logs, error messages, audit entries — must not
 * become the exfiltration channel it was meant to prevent.
 */
export class EgressDeniedError extends Error {
  readonly host: string

  constructor(host: string) {
    super(`egress denied for host "${host}" (docs/SECURITY.md §3.4): not on the allowlist`)
    this.name = 'EgressDeniedError'
    this.host = host
  }
}

/**
 * Audit record for a denied egress attempt. Deliberately just a timestamp
 * and hostname — see `EgressDeniedError` above for why path/query never
 * appear here either.
 */
export interface EgressDenial {
  at: string
  host: string
}

/** Strips IPv6 bracket notation (`[::1]` → `::1`) and lowercases. */
function normalizeHost(host: string): string {
  return host.replace(/^\[/, '').replace(/\]$/, '').toLowerCase()
}

/**
 * The allowlist itself: exact hostname match only, no wildcards. Every host
 * the daemon needs is statically known in v1 (docs/SECURITY.md §3.4 lists
 * them: LLM providers, active integrations, push service) — a wildcard or
 * suffix match would reopen exactly the exfiltration path this exists to
 * close, for the sake of a convenience nothing here needs yet.
 */
export class EgressPolicy {
  private readonly hosts = new Set<string>()
  private readonly denialListeners: Array<(denial: EgressDenial) => void> = []
  private readonly allowLoopback: boolean
  private readonly now: () => Date

  constructor(options: { allowLoopback?: boolean; now?: () => Date } = {}) {
    this.allowLoopback = options.allowLoopback ?? false
    this.now = options.now ?? (() => new Date())
  }

  /** Declares one or more hosts as reachable. Stored lowercase; matched exactly. */
  allow(hosts: string | Iterable<string>): void {
    const values = typeof hosts === 'string' ? [hosts] : hosts
    for (const host of values) {
      this.hosts.add(normalizeHost(host))
    }
  }

  /**
   * Case-insensitive membership check. When `allowLoopback` is set,
   * `localhost` / `127.0.0.1` / `::1` are always allowed regardless of the
   * declared list — the `pnpm dev` Local VPS profile and tests talk to
   * loopback constantly, and the VPS profile (which must NOT trust
   * loopback specially) simply never sets the option.
   */
  isAllowed(hostname: string): boolean {
    const host = normalizeHost(hostname)
    if (this.allowLoopback && LOOPBACK_HOSTS.has(host)) return true
    return this.hosts.has(host)
  }

  /**
   * Registers a listener notified on every denial, with `{at, host}` only
   * (see `EgressDenial`). Used to feed the audit log (docs/SECURITY.md §5)
   * without this module knowing anything about how audit entries are
   * persisted.
   */
  onDenial(listener: (denial: EgressDenial) => void): void {
    this.denialListeners.push(listener)
  }

  /** Declared hosts, sorted, for logging/debug — never used for matching decisions. */
  allowedHosts(): readonly string[] {
    return [...this.hosts].sort()
  }

  /**
   * Parses the hostname out of `urlOrOrigin` (accepting the IPv6 bracket
   * form via the platform `URL` parser) and enforces the allowlist. Throws
   * `EgressDeniedError` on denial, after notifying listeners first so the
   * audit trail exists even if a caller lets the error escape uncaught.
   *
   * An origin that cannot be parsed at all is denied outright — fail
   * closed — with host `'<unparseable>'` rather than risk letting a
   * malformed origin slip past a string-based check.
   */
  check(urlOrOrigin: string | URL): void {
    const host = parseHostname(urlOrOrigin)
    if (this.isAllowed(host)) return
    const denial: EgressDenial = { at: this.now().toISOString(), host }
    for (const listener of this.denialListeners) listener(denial)
    throw new EgressDeniedError(host)
  }
}

function parseHostname(urlOrOrigin: string | URL): string {
  try {
    const url = urlOrOrigin instanceof URL ? urlOrOrigin : new URL(urlOrOrigin)
    return normalizeHost(url.hostname)
  } catch {
    return UNPARSEABLE_HOST
  }
}

/**
 * Delivers a dispatch-time failure to a `Dispatcher.DispatchHandler` the
 * same way undici's own connection errors do, without ever calling
 * `super.dispatch()` — so a denied request never reaches DNS or a socket.
 *
 * `onResponseError`'s first parameter is a `DispatchController` tied to a
 * live request/response exchange, which does not exist yet at this point
 * (the policy check runs *before* `super.dispatch()`). There is nothing to
 * hand back but a placeholder; every handler this dispatcher wraps in
 * practice (undici's built-in fetch adapter, and anything pi-agent-core or
 * google-sources builds on top of fetch) only reads its `error` argument on
 * this path. The cast goes through `unknown`, not `any`, to keep the
 * placeholder's shape nameable rather than silencing the compiler.
 */
function failDispatch(handler: Dispatcher.DispatchHandler, error: Error): void {
  queueMicrotask(() => {
    if (typeof handler.onResponseError === 'function') {
      handler.onResponseError(null as unknown as Dispatcher.DispatchController, error)
    } else if (typeof handler.onError === 'function') {
      handler.onError(error)
    }
  })
}

/**
 * An undici `Dispatcher` that enforces `policy` on every request. Subclasses
 * `Agent` (undici's default dispatcher) so unallowed traffic still gets
 * connection pooling, keep-alive, etc. for the hosts it does let through.
 *
 * `dispatch()` runs `policy.check()` before anything else — before
 * `super.dispatch()` ever sees the request — so a denial fails synchronously
 * with no DNS lookup, no socket, no bytes on the wire.
 */
export function createEgressDispatcher(policy: EgressPolicy): Dispatcher {
  class EgressAgent extends Agent {
    override dispatch(
      options: Dispatcher.DispatchOptions,
      handler: Dispatcher.DispatchHandler,
    ): boolean {
      try {
        policy.check(options.origin ?? '')
      } catch (error) {
        failDispatch(handler, error as Error)
        return false
      }
      return super.dispatch(options, handler)
    }
  }
  return new EgressAgent()
}

/**
 * Installs `policy` as the process-wide egress gate. Node's built-in
 * `fetch` shares undici's global-dispatcher symbol with the `undici`
 * package itself, so this one call also covers `fetch()` calls made
 * directly, google-sources' default `FetchLike`, and any pi-agent-core
 * provider built on `fetch` — none of them need to know this module
 * exists. That sharing is load-bearing for docs/SECURITY.md §3.4 and is
 * asserted directly by this module's test suite (a real built-in `fetch`
 * call against a denied host, with no other wiring).
 */
export function installEgressEnforcement(policy: EgressPolicy): void {
  setGlobalDispatcher(createEgressDispatcher(policy))
}
