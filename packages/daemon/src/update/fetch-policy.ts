/**
 * Fetch policy for the self-updater (issue #46, `docs/adr/0013-signed-self-update.md`):
 * the https/loopback and redirect rules that decide *whether* a URL may be
 * fetched, lifted out of `update-ports.ts` into a pure, transport-free
 * module so two different transports can share one set of rules without
 * sharing a client.
 *
 * The feed fetch (`update-manager.ts`, through the WHATWG `fetch` the
 * daemon's egress dispatcher can see) and the artifact fetch
 * (`update-ports.ts`, through `node:http`/`node:https`, in the short-lived
 * update CLI process where no egress dispatcher is installed) are two
 * different transports for exactly that reason. What they share is this
 * policy: https-or-loopback on every URL, no https-to-http downgrade across
 * a redirect, and cross-host redirects refused unless the caller opts in.
 * That last rule is what lets the artifact fetch permit GitHub's
 * release-asset redirect to `release-assets.githubusercontent.com` while the
 * feed fetch still refuses one — measured against a real published release:
 * `REFUSED: refusing a cross-host redirect: github.com -> release-assets.githubusercontent.com`.
 */

/** Maximum redirect hops any update download will follow. */
export const MAX_REDIRECT_DEPTH = 3

/**
 * Strips IPv6 bracket notation (`[::1]` -> `::1`) and lowercases.
 *
 * Deliberately duplicated from `egress.ts` rather than imported from it:
 * that module imports `undici` at module scope to install the daemon's
 * process-wide egress dispatcher, and the update CLI is a separate,
 * short-lived process that must not pull that dispatcher in just to
 * normalize a hostname.
 */
export function normalizeHost(hostname: string): string {
  return hostname.replace(/^\[/, '').replace(/\]$/, '').toLowerCase()
}

/** A URL safe for a log line or an error message: origin + pathname, never the query string.
 *
 * A redirect target can carry a credential in its query string — GitHub's
 * release-asset redirect lands on
 * `https://release-assets.githubusercontent.com/...?...&sig=...&jwt=...`, a
 * short-lived bearer token. Update failure reasons are written to
 * `state/logs/<version>.log` and to `result.json`'s `reason`, from where
 * the daemon ingests them into an `update.outcome` Event and renders them —
 * so every message in this module that names a URL goes through this
 * function, never `url.href`.
 */
export function describeUrl(url: URL): string {
  return `${url.origin}${url.pathname}`
}

/**
 * Asserts a URL may be fetched at all: https, or http on loopback
 * (127.0.0.1 / ::1). When `pinnedHost` is given, the normalized hostname
 * must equal its normalized form. `what` names the download in the message.
 */
export function assertFetchableUrl(
  url: URL,
  opts: { what: string; pinnedHost?: string | undefined },
): void {
  const host = normalizeHost(url.hostname)
  // Literal loopback addresses only — `localhost` is deliberately absent, unlike
  // `egress.ts`'s own `LOOPBACK_HOSTS`. A name resolves through whatever the host
  // was told to trust, and this rule is what stands between a signed URL and the
  // rest of the machine; a rehearsal feed or fixture must name the address.
  const isLoopback = host === '127.0.0.1' || host === '::1'
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback)) {
    throw new Error(`refusing a non-https URL from a non-loopback host: ${describeUrl(url)}`)
  }
  if (opts.pinnedHost !== undefined) {
    const pinned = normalizeHost(opts.pinnedHost)
    if (host !== pinned) {
      throw new Error(`${opts.what} host '${host}' does not match the pinned host '${pinned}'`)
    }
  }
}

/**
 * Resolves one redirect hop, or throws. Enforces, in this order: depth cap,
 * parseable Location (resolved against `current`), no protocol downgrade
 * (an https hop never becomes http), `assertFetchableUrl` on the target,
 * and — unless `allowCrossHostRedirects` — the same normalized hostname as
 * `current`.
 */
export function resolveRedirect(opts: {
  current: URL
  location: string
  depth: number
  allowCrossHostRedirects: boolean
}): URL {
  const { current, location, depth, allowCrossHostRedirects } = opts
  if (depth >= MAX_REDIRECT_DEPTH) {
    throw new Error(`too many redirects fetching ${describeUrl(current)}`)
  }
  let target: URL
  try {
    target = new URL(location, current)
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause)
    throw new Error(`malformed redirect Location fetching ${describeUrl(current)}: ${message}`)
  }
  if (current.protocol === 'https:' && target.protocol === 'http:') {
    throw new Error(
      `refusing an https -> http redirect: ${describeUrl(current)} -> ${describeUrl(target)}`,
    )
  }
  assertFetchableUrl(target, { what: 'redirect target' })
  if (!allowCrossHostRedirects) {
    const fromHost = normalizeHost(current.hostname)
    const toHost = normalizeHost(target.hostname)
    if (fromHost !== toHost) {
      throw new Error(`refusing a cross-host redirect: ${fromHost} -> ${toHost}`)
    }
  }
  return target
}
