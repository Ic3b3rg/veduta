import { execFile } from 'node:child_process'
import { readdirSync, statSync, statfsSync } from 'node:fs'
import * as http from 'node:http'
import * as https from 'node:https'
import { join } from 'node:path'
import { promisify } from 'node:util'

/**
 * The update transaction's injected ports (issue #43,
 * `docs/adr/0013-signed-self-update.md`): everything `update-transaction.ts`
 * needs from the outside world — network fetch, subprocess exec, disk-space
 * accounting — split out so it, and the host/https discipline built on top
 * of it, are testable in isolation from the transaction's own state machine.
 * `defaultPorts()` is the production wiring; tests inject their own `Ports`
 * with fake routes instead.
 */

export interface FetchBytesOptions {
  maxBytes: number
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
   * Fetches `url` in full, capped at `maxBytes`. Production implementations
   * are expected to follow only same-host redirects, to a bounded depth —
   * the caller (`update-transaction.ts`) separately enforces
   * https-only-except-loopback and pinned-host matching on the *initial* URL
   * before ever calling this.
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

/** Production `Ports`: real network fetch (https-only except loopback, manual same-host redirects, depth-capped), real `execFile`, real `statfs`/disk-usage walk. */
export function defaultPorts(): Ports {
  return {
    fetchBytes: (url, opts) => fetchOnce(url, opts.maxBytes, 0),
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

const MAX_REDIRECT_DEPTH = 3

function fetchOnce(urlText: string, maxBytes: number, depth: number): Promise<FetchBytesResult> {
  return new Promise((resolvePromise, reject) => {
    let url: URL
    try {
      url = new URL(urlText)
    } catch (cause) {
      reject(new Error(`malformed URL: ${urlText}: ${messageOf(cause)}`))
      return
    }
    const mod = url.protocol === 'http:' ? http : https
    const req = mod.get(url, (res) => {
      const status = res.statusCode ?? 0
      const location = res.headers.location
      if (status >= 300 && status < 400 && location !== undefined) {
        res.resume()
        if (depth >= MAX_REDIRECT_DEPTH) {
          reject(new Error(`too many redirects fetching ${urlText}`))
          return
        }
        let redirectUrl: URL
        try {
          redirectUrl = new URL(location, url)
        } catch (cause) {
          reject(new Error(`malformed redirect Location fetching ${urlText}: ${messageOf(cause)}`))
          return
        }
        if (redirectUrl.hostname !== url.hostname) {
          reject(
            new Error(`refusing a cross-host redirect: ${url.hostname} -> ${redirectUrl.hostname}`),
          )
          return
        }
        resolvePromise(fetchOnce(redirectUrl.href, maxBytes, depth + 1))
        return
      }
      const chunks: Buffer[] = []
      let total = 0
      res.on('data', (chunk: Buffer) => {
        total += chunk.length
        if (total > maxBytes) {
          req.destroy()
          reject(
            new Error(`response for ${urlText} exceeded the maximum allowed ${maxBytes} bytes`),
          )
          return
        }
        chunks.push(chunk)
      })
      res.on('end', () => resolvePromise({ status, bytes: Buffer.concat(chunks) }))
      res.on('error', reject)
    })
    req.on('error', reject)
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

// ---------------------------------------------------------------------------
// Network/host discipline — shared by every download this module does (the
// release artifact in `stageRelease`, the Node runtime + SHASUMS256.txt in
// `ensureRuntime`).
// ---------------------------------------------------------------------------

function assertHttpsOrLoopback(url: URL): void {
  if (url.protocol === 'https:') return
  if (url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === '::1')) return
  throw new Error(`refusing a non-https URL from a non-loopback host: ${url.href}`)
}

function assertSameHost(url: URL, allowedHost: string, what: string): void {
  if (url.hostname !== allowedHost) {
    throw new Error(
      `${what} host '${url.hostname}' does not match the pinned host '${allowedHost}'`,
    )
  }
}

/** Fetches `urlText` via `ports.fetchBytes`, first asserting it is https (or loopback-http, for tests/local fixtures) and that its host matches `allowedHost` — the pinned-host discipline every download in this module goes through before a single byte is requested. */
export async function fetchChecked(
  ports: Ports,
  urlText: string,
  allowedHost: string,
  maxBytes: number,
  what: string,
): Promise<Buffer> {
  const url = new URL(urlText)
  assertHttpsOrLoopback(url)
  assertSameHost(url, allowedHost, what)
  const result = await ports.fetchBytes(urlText, { maxBytes })
  if (result.status !== 200) {
    throw new Error(`${what} fetch failed: HTTP ${result.status} from ${urlText}`)
  }
  return result.bytes
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
