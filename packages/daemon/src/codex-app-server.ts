import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { ModelConnectionError } from './model-connection-adapter.ts'

/**
 * The Codex app-server transport (issue #47,
 * `docs/adr/0014-subscription-inference-boundary.md` amendment): a pinned
 * `@openai/codex` binary, run as `codex app-server` and spoken to over
 * newline-delimited JSON-RPC 2.0 on stdin/stdout. This module owns the
 * subprocess itself — binary resolution, spawning, framing, and pooling.
 * `model-connection-codex.ts` owns the ChatGPT/Codex adapter that speaks
 * this transport; it never spawns anything directly, so every test there
 * can drive `codex-app-server-fake.ts`'s deterministic fake instead.
 */

/** The exact upstream version this build supports (issue #47: an exact pin, not a `major.minor`, because a strict parse over hand-transcribed schemas is only as safe as the version it was transcribed from). */
export const CODEX_PINNED_VERSION = '0.146.1'

/** Hosts the spawned child reaches on its own — the daemon's egress dispatcher cannot intercept a subprocess's sockets (`docs/SECURITY.md` §3.4). Allowed only while at least one Codex connection exists (`server.ts`'s egress wiring). */
export const CODEX_EGRESS_HOSTS = ['auth.openai.com', 'chatgpt.com', 'api.openai.com'] as const

/** The exact reason `model-connection-codex.ts`'s `availability()` reports when no binary is configured — shared with `codex-app-server.ts`'s own production transport factory so a caller that skips the availability check still fails with the same actionable message rather than a bare `ENOENT`. */
export const CODEX_BINARY_MISSING_REASON =
  'the Codex app-server binary is not installed: set VEDUTA_CODEX_BIN to a pinned @openai/codex 0.146.1 binary — see docs/SECURITY.md'

/**
 * The Gateway-owned JSON-RPC seam to one running `codex app-server`
 * process. `request` resolves or rejects one call; two tiers can be
 * concurrent on the same pooled transport — a heartbeat/device-code poll
 * and an in-flight chat turn — so `notifications()` returns an INDEPENDENT
 * subscription per caller (backed by `createNotificationHub`'s bounded
 * ring): each subscription replays recent history, then yields live frames,
 * and nothing one subscription's reader does ever removes a frame another
 * subscription still needs. `recentNotifications()` is the non-blocking,
 * non-destructive alternative for a one-shot check (`model-connection-codex.ts`'s
 * device-code login poll) that must never compete with a live turn's own
 * subscription for frames. `idle()` — no in-flight request AND no live
 * subscription — is what `CodexSessionPool`'s timer checks before closing an
 * entry, so a transport mid-turn is never killed out from under it. `close()`
 * is idempotent and safe to call more than once.
 */
export interface CodexTransport {
  request(method: string, params?: unknown): Promise<unknown>
  /**
   * An INDEPENDENT subscription over every notification frame from now on:
   * it replays a snapshot of the retained ring taken at subscription time,
   * then yields live frames as they arrive. Terminates by throwing
   * `ModelConnectionError('unreachable', …)` once the transport exits or is
   * closed. A `break`/`return()`/`throw()` on the consumer's `for await`
   * deregisters this subscription, so an abandoned reader never lingers as
   * a permanent live listener.
   */
  notifications(): AsyncIterable<{ method: string; params: unknown }>
  /** A non-destructive copy of the retained notification ring (most recent `MAX_RETAINED_NOTIFICATIONS` frames) — never blocks, never consumes a frame a live `notifications()` subscription still needs. */
  recentNotifications(): { method: string; params: unknown }[]
  /** True when this transport has no in-flight request and no live notification subscription. */
  idle(): boolean
  close(): void
}

/** Builds one `CodexTransport` bound to a specific connection's `CODEX_HOME`. The real one spawns the pinned binary; tests inject `createFakeCodexTransport` instead. */
export type CodexTransportFactory = (options: { codexHome: string }) => Promise<CodexTransport>

/**
 * Resolves the Codex binary path with **no `$PATH` scan** (issue #47,
 * `docs/SECURITY.md` §3.4): an implicit `$PATH` lookup under the daemon's
 * service user would let anything writable on that `$PATH` — not
 * necessarily something the operator ever chose to trust — get spawned
 * with a live ChatGPT session's `CODEX_HOME`. `VEDUTA_CODEX_BIN` must be an
 * absolute path that exists; otherwise the data-directory convention
 * `<rootDir>/codex/bin/codex` is used if present; otherwise `undefined` —
 * the Codex method reports itself unavailable rather than guessing.
 */
export function resolveCodexBinary(env: NodeJS.ProcessEnv, rootDir: string): string | undefined {
  const override = env['VEDUTA_CODEX_BIN']
  if (override !== undefined && isAbsolute(override) && existsSync(override)) return override
  const dataDirBinary = join(rootDir, 'codex', 'bin', 'codex')
  if (existsSync(dataDirBinary)) return dataDirBinary
  return undefined
}

/**
 * Creates (or recreates) `codexHome` as an empty, `0700` directory with its
 * own `tmp` subdirectory (also `0700`) — the child's `cwd`, `HOME`,
 * `CODEX_HOME` and `TMPDIR` all point inside it, so it never sees another
 * connection's credentials, and nothing it writes is readable by anything
 * else on the box. Called by the real `CodexTransportFactory` before every
 * spawn (idempotent: an existing directory just gets its permissions
 * reasserted, its contents — the pinned binary's own `auth.json` — left
 * alone across an idle-timeout respawn).
 */
export function ensureCodexHome(codexHome: string): void {
  mkdirSync(codexHome, { recursive: true })
  chmodSync(codexHome, 0o700)
  const tmpDir = join(codexHome, 'tmp')
  mkdirSync(tmpDir, { recursive: true })
  chmodSync(tmpDir, 0o700)
}

/** How long one request may take before the caller sees `unreachable` rather than a hung promise. */
export const CODEX_REQUEST_TIMEOUT_MS = 60_000

interface PendingRequest {
  resolve(value: unknown): void
  reject(error: unknown): void
  timer: NodeJS.Timeout
}

interface JsonRpcFrame {
  jsonrpc?: unknown
  id?: unknown
  method?: unknown
  params?: unknown
  result?: unknown
  error?: { code?: unknown; message?: unknown } | unknown
}

/** The bounded ring size `createNotificationHub` retains — enough recent history that a late subscription (a fresh `notifications()` call right after a burst of item frames) still sees what already arrived, without retaining an unbounded transcript for a long-lived pooled transport. */
export const MAX_RETAINED_NOTIFICATIONS = 500

interface NotificationSubscriber {
  push(frame: { method: string; params: unknown }): void
  end(error: ModelConnectionError): void
}

/**
 * Backs `notifications()` on both the real transport below and
 * `codex-app-server-fake.ts`'s fake (issue #47: notifications used to be
 * one shared buffer that `notifications()` spliced empty on every call, so a
 * second concurrent consumer — a heartbeat poll racing an in-flight chat
 * turn on the same pooled transport — stole frames the other still needed).
 * `retain` appends to a bounded ring and pushes to every live subscriber;
 * nothing a reader does ever removes a frame. `subscribe()` returns an
 * INDEPENDENT iterator: it replays a snapshot of the ring taken at
 * subscription time, then yields live frames as `retain` pushes them, and
 * throws the hub's terminal error (set by `endAll`) instead of hanging
 * forever once the transport exits or closes. A `break`/`return()`/`throw()`
 * on the consumer's `for await` deregisters the subscription.
 */
export function createNotificationHub(): {
  retain(frame: { method: string; params: unknown }): void
  subscribe(): AsyncIterable<{ method: string; params: unknown }>
  recent(): { method: string; params: unknown }[]
  subscriberCount(): number
  endAll(error: ModelConnectionError): void
} {
  const ring: { method: string; params: unknown }[] = []
  const subscribers = new Set<NotificationSubscriber>()
  let terminal: ModelConnectionError | undefined

  function retain(frame: { method: string; params: unknown }): void {
    ring.push(frame)
    if (ring.length > MAX_RETAINED_NOTIFICATIONS) ring.shift()
    for (const subscriber of subscribers) subscriber.push(frame)
  }

  function endAll(error: ModelConnectionError): void {
    terminal = error
    for (const subscriber of subscribers) subscriber.end(error)
    subscribers.clear()
  }

  function subscribe(): AsyncIterable<{ method: string; params: unknown }> {
    return {
      [Symbol.asyncIterator]() {
        const queue: { method: string; params: unknown }[] = [...ring]
        let wake: (() => void) | undefined
        let endError: ModelConnectionError | undefined = terminal
        let ended = terminal !== undefined

        const subscriber: NotificationSubscriber = {
          push(frame) {
            queue.push(frame)
            wake?.()
            wake = undefined
          },
          end(error) {
            endError = error
            ended = true
            wake?.()
            wake = undefined
          },
        }
        if (!ended) subscribers.add(subscriber)

        function deregister(): void {
          subscribers.delete(subscriber)
        }

        return {
          async next() {
            while (queue.length === 0 && !ended) {
              await new Promise<void>((resolve) => {
                wake = resolve
              })
            }
            if (queue.length > 0) {
              return { value: queue.shift()!, done: false }
            }
            deregister()
            throw (
              endError ?? new ModelConnectionError('unreachable', 'the Codex transport was closed')
            )
          },
          async return(value?: unknown) {
            deregister()
            return { value, done: true as const }
          },
          async throw(error?: unknown) {
            deregister()
            throw error
          },
        }
      },
    }
  }

  return {
    retain,
    subscribe,
    recent: () => [...ring],
    subscriberCount: () => subscribers.size,
    endAll,
  }
}

/** Fixed, child-controlled-text-free diagnostics for a JSON-RPC error response (issue #47): the child process's own `error.message` must never reach `ModelConnectionError`, `connections.json`, or the PWA — only a safe string keyed by the standard JSON-RPC error code, with one fallback for anything this table does not name. */
const CODEX_RPC_ERROR_DIAGNOSTICS: Record<number, string> = {
  [-32700]: 'the Codex app-server rejected the request: malformed JSON-RPC',
  [-32600]: 'the Codex app-server rejected the request: invalid request',
  [-32601]: 'the Codex app-server rejected the request: unknown method',
  [-32602]: 'the Codex app-server rejected the request: invalid parameters',
  [-32603]: 'the Codex app-server rejected the request: internal error',
}

function rpcErrorCode(error: unknown): number | undefined {
  return typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof (error as { code?: unknown }).code === 'number'
    ? (error as { code: number }).code
    : undefined
}

/** Maps a JSON-RPC error response onto a fixed, safe diagnostic — never the child's own `error.message` (issue #47). */
function diagnosticForRpcError(error: unknown): string {
  const code = rpcErrorCode(error)
  if (code === undefined) return 'the Codex app-server rejected the request'
  return (
    CODEX_RPC_ERROR_DIAGNOSTICS[code] ?? `the Codex app-server rejected the request (code ${code})`
  )
}

/**
 * Spawns `codex app-server` and speaks newline-delimited JSON-RPC 2.0 over
 * its stdio, with the subprocess isolation issue #47 requires. The child's
 * stderr is consumed and byte-counted **only** — never logged raw, since
 * the redactor has no shape for a Codex token (`redaction.ts`'s own doc
 * comment) — and a non-zero exit or a closed stream rejects every in-flight
 * request with `ModelConnectionError('unreachable', …)` rather than
 * hanging them forever.
 */
export function spawnCodexAppServer(options: {
  binary: string
  codexHome: string
  clientInfo: { name: string; version: string }
}): CodexTransport {
  const child: ChildProcessWithoutNullStreams = spawn(options.binary, ['app-server'], {
    cwd: options.codexHome,
    env: {
      HOME: options.codexHome,
      CODEX_HOME: options.codexHome,
      TMPDIR: join(options.codexHome, 'tmp'),
      PATH: process.env['PATH'] ?? '',
    },
  })

  let nextId = 1
  const pending = new Map<number, PendingRequest>()
  const hub = createNotificationHub()
  let stderrBytes = 0
  let exited = false
  let stdoutBuffer = ''

  function failAllPending(error: unknown): void {
    for (const [id, request] of pending) {
      clearTimeout(request.timer)
      request.reject(error)
      pending.delete(id)
    }
  }

  function handleLine(line: string): void {
    const trimmed = line.trim()
    if (trimmed.length === 0) return
    let frame: JsonRpcFrame
    try {
      frame = JSON.parse(trimmed) as JsonRpcFrame
    } catch {
      // A malformed line from the child is not this transport's to
      // interpret — it is dropped rather than crashing the daemon over a
      // framing glitch in a subprocess whose stderr we already never echo.
      return
    }
    if (typeof frame.id === 'number') {
      const request = pending.get(frame.id)
      if (!request) return
      clearTimeout(request.timer)
      pending.delete(frame.id)
      if (frame.error !== undefined) {
        // The child's own `error.message` never reaches `ModelConnectionError`
        // (issue #47) — only a fixed diagnostic keyed by the JSON-RPC
        // error code.
        request.reject(new ModelConnectionError('unreachable', diagnosticForRpcError(frame.error)))
        return
      }
      request.resolve(frame.result)
      return
    }
    if (typeof frame.method === 'string') {
      hub.retain({ method: frame.method, params: frame.params })
    }
  }

  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    stdoutBuffer += chunk
    let newlineIndex = stdoutBuffer.indexOf('\n')
    while (newlineIndex !== -1) {
      const line = stdoutBuffer.slice(0, newlineIndex)
      stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1)
      handleLine(line)
      newlineIndex = stdoutBuffer.indexOf('\n')
    }
  })

  // Never logged raw (`redaction.ts`'s own doc comment: the redactor has no
  // shape for a Codex token) — byte-counted only, surfaced in the one
  // structured exit line below.
  child.stderr.on('data', (chunk: Buffer | string) => {
    stderrBytes += Buffer.byteLength(chunk)
  })

  child.on('error', (error) => {
    exited = true
    const connectionError = new ModelConnectionError(
      'unreachable',
      `codex app-server failed to start: ${error.message}`,
    )
    failAllPending(connectionError)
    hub.endAll(connectionError)
  })

  // `close` (not `exit`) fires once stdio has fully flushed, so `stderrBytes`
  // reflects everything the child ever wrote before this logs — `exit`
  // alone can race the last stderr chunk still in flight.
  child.on('close', (code, signal) => {
    if (exited) return
    exited = true
    // Exactly one structured diagnostic line, no raw payload — the stderr
    // discipline this module's doc comment describes.
    console.error('codex app-server exited', { code, signal, stderrBytes })
    const connectionError = new ModelConnectionError(
      'unreachable',
      `the Codex app-server process exited (code ${code ?? 'null'}, signal ${signal ?? 'null'})`,
    )
    failAllPending(connectionError)
    hub.endAll(connectionError)
  })

  async function request(method: string, params?: unknown): Promise<unknown> {
    if (exited) {
      throw new ModelConnectionError('unreachable', 'the Codex app-server process is not running')
    }
    const id = nextId++
    const frame = { jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(
          new ModelConnectionError(
            'unreachable',
            `codex app-server request timed out waiting for "${method}"`,
          ),
        )
      }, CODEX_REQUEST_TIMEOUT_MS)
      pending.set(id, { resolve, reject, timer })
      child.stdin.write(`${JSON.stringify(frame)}\n`, (error) => {
        if (error) {
          pending.delete(id)
          clearTimeout(timer)
          reject(
            new ModelConnectionError(
              'unreachable',
              `failed to write to codex app-server: ${error.message}`,
            ),
          )
        }
      })
    })
  }

  function idle(): boolean {
    return pending.size === 0 && hub.subscriberCount() === 0
  }

  function close(): void {
    if (exited) return
    exited = true
    const connectionError = new ModelConnectionError(
      'unreachable',
      'the Codex transport was closed',
    )
    failAllPending(connectionError)
    hub.endAll(connectionError)
    child.kill()
  }

  return {
    request,
    notifications: hub.subscribe,
    recentNotifications: hub.recent,
    idle,
    close,
  }
}

interface PoolEntry {
  transport: CodexTransport
  timer: NodeJS.Timeout
}

const DEFAULT_IDLE_MS = 5 * 60_000

/**
 * One live `CodexTransport` per connection id, so a chat turn and a
 * refresh poll for the same connection share one running app-server
 * process instead of spawning a fresh one per call. An entry's idle timer
 * (default 5 minutes, rearmed by every `get()`) does not close the entry
 * outright when it fires — it closes it only when `transport.idle()`
 * reports no in-flight request and no live notification subscription
 * (issue #47: the timer used to close unconditionally, which could kill
 * a transport mid-turn — after which the old shared-buffer `notifications()`
 * would return empty batches forever and the adapter's poll loop would hang
 * forever). Otherwise the timer re-arms and checks again later. Every timer
 * is `unref()`d so an idle pool never keeps the daemon process alive on its
 * own. `closeAll()` is wired into `server.ts`'s existing `onClose` hook.
 */
export class CodexSessionPool {
  private readonly factory: CodexTransportFactory
  private readonly idleMs: number
  private readonly entries = new Map<string, PoolEntry>()
  private readonly pending = new Map<string, Promise<CodexTransport>>()

  constructor(options: { factory: CodexTransportFactory; idleMs?: number; now?: () => number }) {
    this.factory = options.factory
    this.idleMs = options.idleMs ?? DEFAULT_IDLE_MS
  }

  /** Returns the live transport for `connectionId`, creating one via the injected factory if none exists yet. Concurrent callers for the same id share one in-flight creation. */
  async get(connectionId: string, codexHome: string): Promise<CodexTransport> {
    const existing = this.entries.get(connectionId)
    if (existing) {
      this.rearm(connectionId, existing)
      return existing.transport
    }

    const inFlight = this.pending.get(connectionId)
    if (inFlight) return inFlight

    const created = this.factory({ codexHome })
    this.pending.set(connectionId, created)
    try {
      const transport = await created
      const entry: PoolEntry = { transport, timer: this.armTimer(connectionId) }
      this.entries.set(connectionId, entry)
      return transport
    } finally {
      this.pending.delete(connectionId)
    }
  }

  private armTimer(connectionId: string): NodeJS.Timeout {
    const timer = setTimeout(() => {
      const entry = this.entries.get(connectionId)
      if (!entry) return
      if (entry.transport.idle()) {
        entry.transport.close()
        this.entries.delete(connectionId)
        return
      }
      // Busy (an in-flight request or a live notification subscription,
      // e.g. mid-turn) — re-arm and check again later rather than closing a
      // transport a caller is still using.
      entry.timer = this.armTimer(connectionId)
    }, this.idleMs)
    timer.unref()
    return timer
  }

  private rearm(connectionId: string, entry: PoolEntry): void {
    clearTimeout(entry.timer)
    entry.timer = this.armTimer(connectionId)
  }

  /** Closes every live transport — the daemon's `onClose` hook, so no app-server child outlives the daemon process. */
  async closeAll(): Promise<void> {
    for (const entry of this.entries.values()) {
      clearTimeout(entry.timer)
      entry.transport.close()
    }
    this.entries.clear()
  }
}
