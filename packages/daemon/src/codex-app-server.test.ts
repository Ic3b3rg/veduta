import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createFakeCodexTransport } from './codex-app-server-fake.ts'
import {
  CodexSessionPool,
  ensureCodexHome,
  resolveCodexBinary,
  spawnCodexAppServer,
  type CodexTransport,
  type CodexTransportFactory,
} from './codex-app-server.ts'

/**
 * `spawnCodexAppServer` spawns `<binary> app-server` with `cwd: codexHome`.
 * Passing `process.execPath` as the binary makes Node itself the "pinned
 * binary": Node resolves the fixed `app-server` argument as a script path
 * relative to `cwd`, so writing a fake JSON-RPC echo script to
 * `<codexHome>/app-server` and using `process.execPath` as `binary` drives
 * the real framing/id-matching/exit-handling code without ever needing an
 * actual Codex install (no daemon test spawns a real one, per issue #47's
 * "no test spawns a real binary" rule).
 */
const FAKE_APP_SERVER_SCRIPT = `
process.stdin.setEncoding('utf8')
let buffer = ''
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let newlineIndex
  while ((newlineIndex = buffer.indexOf('\\n')) !== -1) {
    const line = buffer.slice(0, newlineIndex)
    buffer = buffer.slice(newlineIndex + 1)
    if (!line.trim()) continue
    let message
    try {
      message = JSON.parse(line)
    } catch {
      continue
    }
    handle(message)
  }
})
function send(frame) {
  process.stdout.write(JSON.stringify(frame) + '\\n')
}
function handle(message) {
  process.stderr.write('diagnostic-noise-that-must-never-be-logged-raw\\n')
  if (message.method === 'exit-now') {
    process.exit(1)
  }
  if (message.method === 'slow') {
    setTimeout(() => {
      send({ jsonrpc: '2.0', id: message.id, result: { echoedMethod: message.method } })
    }, 30)
    return
  }
  if (message.method === 'emit') {
    send({ jsonrpc: '2.0', method: message.params.method, params: message.params.params })
    send({ jsonrpc: '2.0', id: message.id, result: {} })
    return
  }
  if (message.method === 'boom') {
    send({
      jsonrpc: '2.0',
      id: message.id,
      error: { code: message.params.code, message: 'sensitive-child-controlled-text-do-not-leak' },
    })
    return
  }
  send({ jsonrpc: '2.0', id: message.id, result: { echoedMethod: message.method, params: message.params ?? null } })
}
`

let rootDir: string | undefined
const openTransports: CodexTransport[] = []

afterEach(() => {
  for (const transport of openTransports) transport.close()
  openTransports.length = 0
  if (rootDir) rmSync(rootDir, { recursive: true, force: true })
  rootDir = undefined
})

function freshRoot(): string {
  rootDir = mkdtempSync(join(tmpdir(), 'veduta-codex-app-server-'))
  return rootDir
}

/** Writes the fake app-server script into `codexHome/app-server` and returns a transport speaking to it, tracked for teardown. */
function spawnFake(codexHome: string): CodexTransport {
  mkdirSync(codexHome, { recursive: true })
  writeFileSync(join(codexHome, 'app-server'), FAKE_APP_SERVER_SCRIPT)
  const transport = spawnCodexAppServer({
    binary: process.execPath,
    codexHome,
    clientInfo: { name: 'veduta', version: '0.0.0-test' },
  })
  openTransports.push(transport)
  return transport
}

describe('resolveCodexBinary', () => {
  it('prefers VEDUTA_CODEX_BIN over the data-dir path when both exist', () => {
    const root = freshRoot()
    const overridePath = join(root, 'custom-codex-bin')
    writeFileSync(overridePath, '#!/bin/sh\n')
    const dataDirBin = join(root, 'codex', 'bin', 'codex')
    mkdirSync(join(root, 'codex', 'bin'), { recursive: true })
    writeFileSync(dataDirBin, '#!/bin/sh\n')

    const resolved = resolveCodexBinary({ VEDUTA_CODEX_BIN: overridePath }, root)
    expect(resolved).toBe(overridePath)
  })

  it('falls back to the data-dir path when VEDUTA_CODEX_BIN is unset', () => {
    const root = freshRoot()
    const dataDirBin = join(root, 'codex', 'bin', 'codex')
    mkdirSync(join(root, 'codex', 'bin'), { recursive: true })
    writeFileSync(dataDirBin, '#!/bin/sh\n')

    expect(resolveCodexBinary({}, root)).toBe(dataDirBin)
  })

  it('returns undefined when neither VEDUTA_CODEX_BIN nor the data-dir binary exists', () => {
    const root = freshRoot()
    expect(resolveCodexBinary({}, root)).toBeUndefined()
  })

  it('ignores a VEDUTA_CODEX_BIN that is not an absolute path', () => {
    const root = freshRoot()
    expect(resolveCodexBinary({ VEDUTA_CODEX_BIN: 'relative/codex' }, root)).toBeUndefined()
  })
})

describe('spawnCodexAppServer', () => {
  it('frames one JSON object per line and matches responses by id regardless of arrival order', async () => {
    const root = freshRoot()
    const transport = spawnFake(join(root, 'codex', 'conn-1'))

    const [slow, fast] = await Promise.all([
      transport.request('slow', {}),
      transport.request('ping', { a: 1 }),
    ])
    expect(slow).toEqual({ echoedMethod: 'slow' })
    expect(fast).toEqual({ echoedMethod: 'ping', params: { a: 1 } })
  })

  it('rejects an in-flight request with unreachable when the child exits', async () => {
    const root = freshRoot()
    const transport = spawnFake(join(root, 'codex', 'conn-2'))

    await expect(transport.request('exit-now')).rejects.toMatchObject({ code: 'unreachable' })
  })

  it('never logs raw stderr, only its byte count in one structured exit line', async () => {
    const root = freshRoot()
    const transport = spawnFake(join(root, 'codex', 'conn-3'))
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await transport.request('exit-now').catch(() => {})
    // Give the child's 'exit' event a tick to fire after the request settles.
    await new Promise((resolve) => setTimeout(resolve, 50))

    const exitCalls = spy.mock.calls.filter((call) => call[0] === 'codex app-server exited')
    expect(exitCalls).toHaveLength(1)
    const [, payload] = exitCalls[0] ?? []
    expect(payload).toMatchObject({ code: 1 })
    expect((payload as { stderrBytes: number }).stderrBytes).toBeGreaterThan(0)
    for (const call of spy.mock.calls) {
      expect(JSON.stringify(call)).not.toContain('diagnostic-noise-that-must-never-be-logged-raw')
    }
    spy.mockRestore()
  })

  it("a child JSON-RPC error becomes a fixed diagnostic, never the child's text", async () => {
    const root = freshRoot()
    const transport = spawnFake(join(root, 'codex', 'conn-boom'))

    const error = await transport
      .request('boom', { code: -32602 })
      .catch((caught: unknown) => caught)

    expect(error).toMatchObject({ code: 'unreachable' })
    const message = (error as { message: string }).message
    expect(message).not.toContain('sensitive-child-controlled-text-do-not-leak')
    expect(message).toContain('invalid parameters')
  })

  it('two notification consumers each see every frame', async () => {
    const root = freshRoot()
    const transport = spawnFake(join(root, 'codex', 'conn-multi'))
    const subA = transport.notifications()[Symbol.asyncIterator]()
    const subB = transport.notifications()[Symbol.asyncIterator]()
    const nextA = subA.next()
    const nextB = subB.next()

    await transport.request('emit', { method: 'item/updated', params: { threadId: 't1' } })

    await expect(nextA).resolves.toMatchObject({
      value: { method: 'item/updated', params: { threadId: 't1' } },
    })
    await expect(nextB).resolves.toMatchObject({
      value: { method: 'item/updated', params: { threadId: 't1' } },
    })
  })

  it('a consumer never removes frames from another', async () => {
    const root = freshRoot()
    const transport = spawnFake(join(root, 'codex', 'conn-multi2'))

    await transport.request('emit', { method: 'account/updated', params: { n: 1 } })

    const subA = transport.notifications()[Symbol.asyncIterator]()
    const first = await subA.next()
    expect(first.value).toEqual({ method: 'account/updated', params: { n: 1 } })

    // A second, later subscription still sees the same frame via the
    // retained ring — subA's own read did not remove it.
    const subB = transport.notifications()[Symbol.asyncIterator]()
    const second = await subB.next()
    expect(second.value).toEqual({ method: 'account/updated', params: { n: 1 } })
  })

  it('a closed transport ends its notification subscriptions', async () => {
    const root = freshRoot()
    const transport = spawnFake(join(root, 'codex', 'conn-close-sub'))

    const sub = transport.notifications()[Symbol.asyncIterator]()
    const pending = sub.next()
    transport.close()

    await expect(pending).rejects.toMatchObject({ code: 'unreachable' })
  })
})

describe('ensureCodexHome', () => {
  it('creates CODEX_HOME 0700 and empty, with an empty 0700 tmp subdirectory', () => {
    const root = freshRoot()
    const codexHome = join(root, 'codex', 'conn-home-1')

    ensureCodexHome(codexHome)

    expect(statSync(codexHome).mode & 0o777).toBe(0o700)
    expect(statSync(join(codexHome, 'tmp')).mode & 0o777).toBe(0o700)
    // "Empty" means no leftover credential material — the `tmp` scaffolding
    // this function itself creates is the only entry, never an `auth.json`
    // or any other file a previous session might have left behind.
    expect(readdirSync(codexHome)).toEqual(['tmp'])
    expect(readdirSync(join(codexHome, 'tmp'))).toEqual([])
  })
})

describe('CodexSessionPool', () => {
  function fakeFactory(): { factory: CodexTransportFactory; created: string[] } {
    const created: string[] = []
    const factory: CodexTransportFactory = async ({ codexHome }) => {
      created.push(codexHome)
      return createFakeCodexTransport({ responses: {} })
    }
    return { factory, created }
  }

  it('reuses a live transport for the same connection id', async () => {
    const root = freshRoot()
    const codexHome = join(root, 'codex', 'conn-pool-2')
    const { factory, created } = fakeFactory()
    const pool = new CodexSessionPool({ factory })

    const first = await pool.get('conn-pool-2', codexHome)
    const second = await pool.get('conn-pool-2', codexHome)

    expect(second).toBe(first)
    expect(created).toHaveLength(1)
    await pool.closeAll()
  })

  it('closeAll closes every live transport', async () => {
    const root = freshRoot()
    const codexHome = join(root, 'codex', 'conn-pool-3')
    const { factory } = fakeFactory()
    const pool = new CodexSessionPool({ factory })

    const transport = await pool.get('conn-pool-3', codexHome)
    await pool.closeAll()
    // A fake transport tracks its own `closed` flag; closeAll must have
    // reached it through the pool, not merely resolved without doing so.
    expect((transport as ReturnType<typeof createFakeCodexTransport>).closed).toBe(true)
  })

  it('the idle timer re-arms while a transport is busy', async () => {
    vi.useFakeTimers()
    try {
      let resolveSlow: (() => void) | undefined
      const transport = createFakeCodexTransport({
        responses: {
          slow: () =>
            new Promise<void>((resolve) => {
              resolveSlow = resolve
            }),
        },
      })
      const pool = new CodexSessionPool({
        factory: async () => transport,
        idleMs: 1_000,
      })

      await pool.get('conn-pool-busy', '/tmp/veduta-codex-app-server-busy')
      const pending = transport.request('slow')

      // The timer fires while the request above is still in flight — the
      // transport is not idle, so it must re-arm rather than close.
      await vi.advanceTimersByTimeAsync(1_000)
      expect(transport.closed).toBe(false)

      resolveSlow?.()
      await pending

      // Now idle (no in-flight request, no live subscription) — the
      // re-armed timer's next fire closes it.
      await vi.advanceTimersByTimeAsync(1_000)
      expect(transport.closed).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})
