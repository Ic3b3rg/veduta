import { afterEach, describe, expect, it, vi } from 'vitest'
import { createFakeCodexTransport } from './codex-app-server-fake.ts'
import { CodexSessionPool, type CodexTransport } from './codex-app-server.ts'

function deferredTransport() {
  let resolve!: (transport: CodexTransport) => void
  let reject!: (error: Error) => void
  const promise = new Promise<CodexTransport>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const pools: CodexSessionPool[] = []

afterEach(async () => {
  for (const pool of pools) await pool.closeAll()
  pools.length = 0
  vi.useRealTimers()
})

describe('Codex pool shutdown', () => {
  it('closes a late successful initializer once and rejects every concurrent caller', async () => {
    vi.useFakeTimers()
    const initialization = deferredTransport()
    const factory = vi.fn(() => initialization.promise)
    const pool = new CodexSessionPool({ factory })
    pools.push(pool)
    const transport = createFakeCodexTransport({ responses: {} })
    const close = vi.spyOn(transport, 'close')
    const callers = Promise.allSettled([
      pool.get('one', '/unused/one'),
      pool.get('one', '/unused/one'),
    ])

    await pool.closeAll()
    await pool.closeAll()
    initialization.resolve(transport)

    expect(await callers).toEqual([
      { status: 'rejected', reason: expect.objectContaining({ code: 'unreachable' }) },
      { status: 'rejected', reason: expect.objectContaining({ code: 'unreachable' }) },
    ])
    expect(transport.closed).toBe(true)
    expect(factory).toHaveBeenCalledTimes(1)
    await pool.closeAll()
    expect(close).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('settles a late initialization failure for all callers without timers or an unhandled rejection', async () => {
    vi.useFakeTimers()
    const initialization = deferredTransport()
    const pool = new CodexSessionPool({ factory: () => initialization.promise })
    pools.push(pool)
    const callers = Promise.allSettled([
      pool.get('one', '/unused/one'),
      pool.get('one', '/unused/one'),
    ])
    await pool.closeAll()
    const failure = new Error('initialization failed')
    initialization.reject(failure)

    expect(await callers).toEqual([
      { status: 'rejected', reason: failure },
      { status: 'rejected', reason: failure },
    ])
    await pool.closeAll()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('never invokes the factory for an acquisition after shutdown', async () => {
    const factory = vi.fn(async () => createFakeCodexTransport({ responses: {} }))
    const pool = new CodexSessionPool({ factory })
    pools.push(pool)
    await pool.closeAll()

    await expect(pool.get('new', '/unused/new')).rejects.toMatchObject({ code: 'unreachable' })
    expect(factory).not.toHaveBeenCalled()
  })

  it('closes established connections without waiting for another pending initializer', async () => {
    vi.useFakeTimers()
    const initialization = deferredTransport()
    const first = createFakeCodexTransport({ responses: {} })
    const second = createFakeCodexTransport({ responses: {} })
    const firstClose = vi.spyOn(first, 'close')
    const secondClose = vi.spyOn(second, 'close')
    const pool = new CodexSessionPool({
      factory: async ({ codexHome }) => {
        if (codexHome === '/unused/one') return first
        if (codexHome === '/unused/two') return second
        return initialization.promise
      },
    })
    pools.push(pool)
    await pool.get('one', '/unused/one')
    await pool.get('two', '/unused/two')
    const pending = Promise.allSettled([pool.get('pending', '/unused/pending')])

    await pool.closeAll()
    expect(first.closed).toBe(true)
    expect(second.closed).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
    await pool.closeAll()
    expect(firstClose).toHaveBeenCalledTimes(1)
    expect(secondClose).toHaveBeenCalledTimes(1)

    initialization.reject(new Error('factory deadline reached'))
    expect((await pending)[0]?.status).toBe('rejected')
  })
})
