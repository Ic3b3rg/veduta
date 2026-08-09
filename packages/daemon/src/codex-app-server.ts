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
 * process. `request` resolves or rejects one call; `notifications()`
 * drains whatever notification frames have arrived since the last call —
 * it never blocks waiting for one that has not arrived yet, so a caller
 * (`model-connection-codex.ts`'s `refresh()`, polled every ~2s by the PWA)
 * can check "has anything happened yet?" without hanging a request on a
 * device-code login the user has not finished. `close()` is idempotent and
 * safe to call more than once.
 */
export interface CodexTransport {
  request(method: string, params?: unknown): Promise<unknown>
  notifications(): AsyncIterable<{ method: string; params: unknown }>
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
  error?: { message?: unknown } | unknown
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
  const notificationBuffer: { method: string; params: unknown }[] = []
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
        const message =
          typeof frame.error === 'object' &&
          frame.error !== null &&
          'message' in frame.error &&
          typeof (frame.error as { message?: unknown }).message === 'string'
            ? (frame.error as { message: string }).message
            : 'the Codex app-server returned an error response'
        request.reject(new ModelConnectionError('unreachable', message))
        return
      }
      request.resolve(frame.result)
      return
    }
    if (typeof frame.method === 'string') {
      notificationBuffer.push({ method: frame.method, params: frame.params })
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
    failAllPending(
      new ModelConnectionError('unreachable', `codex app-server failed to start: ${error.message}`),
    )
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
    failAllPending(
      new ModelConnectionError(
        'unreachable',
        `the Codex app-server process exited (code ${code ?? 'null'}, signal ${signal ?? 'null'})`,
      ),
    )
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

  function notifications(): AsyncIterable<{ method: string; params: unknown }> {
    const batch = notificationBuffer.splice(0, notificationBuffer.length)
    return {
      async *[Symbol.asyncIterator]() {
        for (const item of batch) yield item
      },
    }
  }

  function close(): void {
    if (exited) return
    exited = true
    failAllPending(new ModelConnectionError('unreachable', 'the Codex transport was closed'))
    child.kill()
  }

  return { request, notifications, close }
}

interface PoolEntry {
  transport: CodexTransport
  timer: NodeJS.Timeout
}

const DEFAULT_IDLE_MS = 5 * 60_000

/**
 * One live `CodexTransport` per connection id, so a chat turn and a
 * refresh poll for the same connection share one running app-server
 * process instead of spawning a fresh one per call. An entry is killed
 * after `idleMs` (default 5 minutes) of no `get()` calls; the timer is
 * `unref()`d so an idle pool never keeps the daemon process alive on its
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
      if (entry) {
        entry.transport.close()
        this.entries.delete(connectionId)
      }
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
