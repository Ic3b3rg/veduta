import { execFile } from 'node:child_process'
import { readdirSync, statSync, statfsSync } from 'node:fs'
import * as http from 'node:http'
import * as https from 'node:https'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { assertFetchableUrl, describeUrl, resolveRedirect } from './fetch-policy.ts'

/**
 * The update transaction's injected ports (issue #43,
 * `docs/adr/0013-signed-self-update.md`): everything `update-transaction.ts`
 * needs from the outside world — network fetch, subprocess exec, disk-space
 * accounting — split out so it, and the host/https discipline built on top
 * of it, are testable in isolation from the transaction's own state machine.
 * `defaultPorts()` is the production wiring; tests inject their own `Ports`
 * with fake routes instead.
 *
 * The https/loopback and redirect *rules* live in `fetch-policy.ts` (issue
 * #46) — this module owns the transport that enforces them: the redirect
 * loop, the depth counter, and now the deadlines below.
 */

export interface FetchBytesOptions {
  maxBytes: number
  /**
   * Whether a redirect may land on a different host than the URL just
   * fetched. Per-call, not a fixed property of this port: the release
   * artifact is unpinned and may hop across hosts (GitHub's release-asset
   * redirect to `release-assets.githubusercontent.com` — issue #46), because
   * its integrity rests on a signed sha256 the caller checks independently;
   * the Node runtime tarball and `SHASUMS256.txt` stay same-host. Defaults
   * to `false` — the safer choice when a caller forgets to set it.
   */
  allowCrossHostRedirects?: boolean | undefined
  /**
   * Overrides `DEFAULT_IDLE_TIMEOUT_MS` for this call. No production caller
   * sets this — it exists so a test can force a fast, deterministic idle
   * timeout instead of waiting out the real one.
   */
  idleTimeoutMs?: number | undefined
  /**
   * Overrides `FETCH_BUDGET_MS` for this call. Set in production by
   * `update-transaction.ts` and `update-runtime.ts` via
   * `remainingFetchBudgetMs`, so every download in one update transaction
   * shares a single deadline instead of each buying its own
   * `FETCH_BUDGET_MS`.
   */
  totalTimeoutMs?: number | undefined
}

export interface FetchBytesResult {
  status: number
  bytes: Buffer
}

export interface ExecFileOptions {
  cwd?: string
  env?: NodeJS.ProcessEnv
}

export interface ExecFileResult {
  code: number
  stdout: string
  stderr: string
}

export interface StatfsResult {
  bavail: number
  bsize: number
}

/**
 * Everything the transaction needs from the outside world, injected so unit
 * tests never touch a real network, a real disk-space check, or a real
 * subprocess for the new release's own migrate/self-check entry points.
 * `defaultPorts()` below is the production wiring.
 */
export interface Ports {
  /**
   * Fetches `url` in full, capped at `maxBytes`, enforcing an idle timeout
   * and a total deadline (see `DEFAULT_IDLE_TIMEOUT_MS` /
   * `FETCH_BUDGET_MS` below). Redirects are followed to a bounded
   * depth (`fetch-policy.ts`'s `MAX_REDIRECT_DEPTH`), through
   * `resolveRedirect`, which enforces https-or-loopback and no
   * https-to-http downgrade on every hop and — unless
   * `opts.allowCrossHostRedirects` — the same host as the previous hop. The
   * caller (`fetchChecked` below) separately enforces
   * https-only-except-loopback and pinned-host matching on the *initial*
   * URL before ever calling this; the redirect policy for hops after that
   * is this call's own choice, made per download via `opts`.
   */
  fetchBytes(url: string, opts: FetchBytesOptions): Promise<FetchBytesResult>
  execFile(cmd: string, args: string[], opts?: ExecFileOptions): Promise<ExecFileResult>
  /** Wraps `node:fs` `statfsSync` — free-space accounting for the disk guardrail. */
  statfs(path: string): StatfsResult
  /** A `du -sk`-equivalent recursive size of `path`, in bytes. */
  diskUsage(path: string): Promise<number>
  now(): Date
  /** Appends `line` to whatever sink the caller wants (production: also `state/logs/<version>.log`, teed by `update-transaction.ts` itself; tests: typically a capture array). */
  log(line: string): void
}

const execFileAsync = promisify(execFile)

/** Production `Ports`: real network fetch (https-only except loopback, manual same-host-by-default redirects, depth-capped, deadline-bound), real `execFile`, real `statfs`/disk-usage walk. */
export function defaultPorts(): Ports {
  return {
    fetchBytes: (url, opts) => fetchTop(url, opts),
    execFile: async (cmd, args, opts) => {
      try {
        const { stdout, stderr } = await execFileAsync(cmd, args, {
          ...(opts?.cwd !== undefined ? { cwd: opts.cwd } : {}),
          ...(opts?.env !== undefined ? { env: opts.env } : {}),
          maxBuffer: 64 * 1024 * 1024,
        })
        return { code: 0, stdout, stderr }
      } catch (error) {
        const e = error as { code?: unknown; stdout?: string; stderr?: string; message: string }
        const code = typeof e.code === 'number' ? e.code : 1
        return { code, stdout: e.stdout ?? '', stderr: e.stderr ?? e.message }
      }
    },
    statfs: (path) => {
      const s = statfsSync(path)
      return { bavail: s.bavail, bsize: s.bsize }
    },
    diskUsage: (path) => Promise.resolve(walkDiskUsage(path)),
    now: () => new Date(),
    log: (line) => {
      process.stderr.write(`${line}\n`)
    },
  }
}

/** No bytes for a minute is a dead transfer on any link that can carry a 60+ MB artifact. */
const DEFAULT_IDLE_TIMEOUT_MS = 60_000

/**
 * How long downloading may take in total: generous for a slow home uplink,
 * finite for a server that stalls on purpose. It is both this module's
 * per-call default and the whole budget an update transaction gets for *all*
 * its downloads together — the transaction stamps a deadline from it once and
 * then passes what remains to each call (`remainingFetchBudgetMs`), because
 * the daemon is down for that entire window
 * (`docs/adr/0013-signed-self-update.md`) and three independent budgets would
 * let a slow host hold an instance offline for their sum.
 */
export const FETCH_BUDGET_MS = 30 * 60_000

/** What is left of a shared download budget, floored at 1 ms so an exhausted budget still fails with the deadline error rather than a `setTimeout` with a negative delay. */
export function remainingFetchBudgetMs(deps: {
  fetchDeadlineAt: number
  ports: Pick<Ports, 'now'>
}): number {
  return Math.max(1, deps.fetchDeadlineAt - deps.ports.now().getTime())
}

interface FetchOnceOptions {
  maxBytes: number
  allowCrossHostRedirects: boolean
  idleTimeoutMs: number
  /** Absolute `Date.now()`-scale deadline for the *whole* redirect chain — computed once by `fetchTop` and threaded down through every recursive hop unchanged, so a chain of redirects cannot each buy themselves a fresh `totalTimeoutMs`. */
  deadline: number
  depth: number
}

/** Entry point: resolves defaults, computes the one absolute deadline for this download's entire redirect chain, and starts the recursion at depth 0. */
function fetchTop(urlText: string, opts: FetchBytesOptions): Promise<FetchBytesResult> {
  const idleTimeoutMs = opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS
  const totalTimeoutMs = opts.totalTimeoutMs ?? FETCH_BUDGET_MS
  return fetchOnce(urlText, {
    maxBytes: opts.maxBytes,
    allowCrossHostRedirects: opts.allowCrossHostRedirects ?? false,
    idleTimeoutMs,
    deadline: Date.now() + totalTimeoutMs,
    depth: 0,
  })
}

function fetchOnce(urlText: string, opts: FetchOnceOptions): Promise<FetchBytesResult> {
  return new Promise((resolvePromise, reject) => {
    let url: URL
    try {
      url = new URL(urlText)
    } catch (cause) {
      // The URL itself is deliberately not echoed: this is the one message here
      // that cannot route through `describeUrl` (there is no parsed URL to
      // describe), and an unparseable string could still carry a redirect
      // target's `sig=`/`jwt=` query into a durable log.
      reject(new Error(`malformed URL passed to the update fetch: ${messageOf(cause)}`))
      return
    }

    const remainingMs = opts.deadline - Date.now()
    if (remainingMs <= 0) {
      reject(new Error(`exceeded the total download deadline fetching ${describeUrl(url)}`))
      return
    }

    const mod = url.protocol === 'http:' ? http : https
    let settled = false

    const req = mod.get(url, (res) => {
      const status = res.statusCode ?? 0
      const location = res.headers.location

      if (status >= 300 && status < 400) {
        // Destroyed, not resumed: a redirect body this code never intends
        // to read is, under `res.resume()`, an unbounded read with no
        // `maxBytes` applied to it — a server can keep it open forever
        // (issue #46).
        res.destroy()
        if (location === undefined) {
          settle(() =>
            reject(
              new Error(
                `HTTP ${status} redirect from ${describeUrl(url)} carried no Location header`,
              ),
            ),
          )
          return
        }
        let target: URL
        try {
          target = resolveRedirect({
            current: url,
            location,
            depth: opts.depth,
            allowCrossHostRedirects: opts.allowCrossHostRedirects,
          })
        } catch (cause) {
          settle(() => reject(cause instanceof Error ? cause : new Error(String(cause))))
          return
        }
        settle(() => {
          resolvePromise(fetchOnce(target.href, { ...opts, depth: opts.depth + 1 }))
        })
        return
      }

      const chunks: Buffer[] = []
      let total = 0
      res.on('data', (chunk: Buffer) => {
        total += chunk.length
        if (total > opts.maxBytes) {
          settle(() => {
            req.destroy()
            reject(
              new Error(
                `response for ${describeUrl(url)} exceeded the maximum allowed ${opts.maxBytes} bytes`,
              ),
            )
          })
          return
        }
        chunks.push(chunk)
      })
      res.on('end', () => {
        settle(() => resolvePromise({ status, bytes: Buffer.concat(chunks) }))
      })
      res.on('error', (err) => {
        settle(() => reject(err))
      })
    })

    // The total deadline for the whole chain, not just this hop: the timer
    // fires after `remainingMs`, the budget left over from `opts.deadline`
    // computed once in `fetchTop` — never the full `totalTimeoutMs` again,
    // or a chain of quick redirects could restart the clock indefinitely.
    const totalTimer = setTimeout(() => {
      settle(() => {
        req.destroy()
        reject(new Error(`exceeded the total download deadline fetching ${describeUrl(url)}`))
      })
    }, remainingMs)

    // Settling more than once cannot happen: every exit path (success, the
    // size cap, an error, a redirect, either timeout) funnels through this,
    // which clears the deadline timer so no timer outlives the promise and
    // no test leaks a handle. It deliberately does NOT strip `req`'s own
    // 'error' listener (below): destroying a request after we have already
    // settled still raises a "socket hang up" moments later, and that
    // listener is what turns it into a harmless no-op settle() instead of
    // an uncaught exception.
    function settle(fn: () => void): void {
      if (settled) return
      settled = true
      clearTimeout(totalTimer)
      fn()
    }

    // No socket activity for `idleTimeoutMs` is a dead transfer — distinct
    // from the total deadline above, which bounds the whole chain even if
    // bytes keep trickling in one at a time forever.
    req.setTimeout(opts.idleTimeoutMs, () => {
      settle(() => {
        req.destroy()
        reject(new Error(`idle timeout waiting for ${describeUrl(url)}`))
      })
    })

    req.on('error', (err) => {
      settle(() => reject(err))
    })
  })
}

function walkDiskUsage(rootPath: string): number {
  let total = 0
  const stack = [rootPath]
  while (stack.length > 0) {
    const current = stack.pop()
    if (current === undefined) continue
    let entries
    try {
      entries = readdirSync(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const full = join(current, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        stack.push(full)
        continue
      }
      try {
        total += statSync(full).size
      } catch {
        // A file disappearing mid-walk (a concurrent writer) is tolerated —
        // this is an approximation for the disk guardrail, not an audit.
      }
    }
  }
  return total
}

/**
 * Fetches `urlText` via `ports.fetchBytes`, first asserting it is https (or
 * loopback-http, for tests/local fixtures) and, when `opts.pinnedHost` is
 * given, that its host matches. That pinning discipline covers only the
 * *initial* URL — it is deliberately not one fixed policy for every caller:
 * the Node runtime tarball and `SHASUMS256.txt` stay pinned to the dist
 * host and same-host across redirects, while the release artifact is
 * unpinned and may redirect across hosts (`opts.allowCrossHostRedirects`),
 * because its integrity rests on a signed sha256 verified by the caller,
 * not on where the bytes came from.
 */
export async function fetchChecked(
  ports: Ports,
  urlText: string,
  opts: {
    what: string
    maxBytes: number
    pinnedHost?: string | undefined
    allowCrossHostRedirects?: boolean | undefined
    /** What is left of the caller's own budget — an update transaction passes `remainingFetchBudgetMs(ctx)` so all of its downloads share one deadline rather than each arming `FETCH_BUDGET_MS` afresh. */
    totalTimeoutMs?: number | undefined
  },
): Promise<Buffer> {
  const url = new URL(urlText)
  assertFetchableUrl(url, { what: opts.what, pinnedHost: opts.pinnedHost })
  const result = await ports.fetchBytes(urlText, {
    maxBytes: opts.maxBytes,
    allowCrossHostRedirects: opts.allowCrossHostRedirects,
    totalTimeoutMs: opts.totalTimeoutMs,
  })
  if (result.status !== 200) {
    throw new Error(`${opts.what} fetch failed: HTTP ${result.status} from ${describeUrl(url)}`)
  }
  return result.bytes
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
