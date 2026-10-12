import { afterEach, expect, it, vi } from 'vitest'
import { createFakeCodexTransport } from './codex-app-server-fake.ts'
import { CodexSessionPool, type CodexTransport } from './codex-app-server.ts'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

afterEach(() => vi.useRealTimers())

it('retires one connection immediately and waits for pending creation and actual child exit', async () => {
  const initialized = deferred<CodexTransport>()
  const exited = deferred<void>()
  const fake = createFakeCodexTransport({ responses: {} })
  const transport = {
    ...fake,
    closeAndWait: async () => {
      fake.close()
      await exited.promise
    },
  }
  const other = createFakeCodexTransport({ responses: {} })
  const pool = new CodexSessionPool({
    factory: async ({ codexHome, onCreate }) => {
      if (codexHome === '/unused/other') return other
      onCreate(transport)
      return initialized.promise
    },
  })
  await pool.get('other', '/unused/other')
  const call = Promise.allSettled([pool.get('removing', '/unused/removing')])
  let removed = false
  const removal = pool.evict('removing').then(() => {
    removed = true
  })
  await expect(pool.get('removing', '/unused/removing')).rejects.toMatchObject({
    code: 'unreachable',
  })
  expect(fake.closed).toBe(true)
  expect(removed).toBe(false)
  initialized.resolve(transport)
  await Promise.resolve()
  expect(removed).toBe(false)
  exited.resolve()
  await removal
  expect((await call)[0]?.status).toBe('rejected')
  expect(other.closed).toBe(false)
  await pool.evict('removing')
  await pool.closeAll()
})

it('keeps failed termination owned so a later removal can retry safely', async () => {
  const fake = createFakeCodexTransport({ responses: {} })
  let attempts = 0
  const transport = {
    ...fake,
    closeAndWait: async () => {
      fake.close()
      if (++attempts === 1) throw new Error('child still running')
    },
  }
  const pool = new CodexSessionPool({ factory: async () => transport })
  await pool.get('one', '/unused/one')
  await expect(pool.evict('one')).rejects.toThrow('child')
  await expect(pool.get('one', '/unused/one')).rejects.toMatchObject({ code: 'unreachable' })
  await pool.evict('one')
  expect(attempts).toBe(2)
})

it.each([false, true])(
  'removes locally after an established logout, including failure=%s',
  async (fails) => {
    const transport = createFakeCodexTransport({
      responses: {
        'account/logout': () => {
          if (fails) throw new Error('provider unavailable')
          return {}
        },
      },
    })
    const pool = new CodexSessionPool({ factory: async () => transport })
    await pool.get('one', '/unused/one')
    await pool.evict('one', async (owned) => {
      await owned.request('account/logout', {})
    })
    expect(transport.requests.map(({ method }) => method)).toEqual(['account/logout'])
    expect(transport.closed).toBe(true)
  },
)

it('does not spawn a child just to revoke an idle connection', async () => {
  const factory = vi.fn(async () => createFakeCodexTransport({ responses: {} }))
  const pool = new CodexSessionPool({ factory })
  const revoke = vi.fn()
  await pool.evict('idle', revoke)
  expect(factory).not.toHaveBeenCalled()
  expect(revoke).not.toHaveBeenCalled()
})

it('bounds a stuck pending factory and clears the eviction timer while retaining late ownership', async () => {
  vi.useFakeTimers()
  const initialized = deferred<CodexTransport>()
  const pool = new CodexSessionPool({ factory: async () => initialized.promise })
  const callers = Promise.allSettled([pool.get('one', '/unused'), pool.get('one', '/unused')])
  const removals = Promise.allSettled([pool.evict('one'), pool.evict('one')])
  await vi.advanceTimersByTimeAsync(70_000)
  expect((await removals).map((result) => result.status)).toEqual(['rejected', 'rejected'])
  expect(vi.getTimerCount()).toBe(0)
  const transport = createFakeCodexTransport({ responses: {} })
  initialized.resolve(transport)
  expect((await callers).map((result) => result.status)).toEqual(['rejected', 'rejected'])
  expect(transport.closed).toBe(true)
  await pool.evict('one')
  expect(vi.getTimerCount()).toBe(0)
})
