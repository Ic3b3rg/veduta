import { readFileSync } from 'node:fs'
import { createContext, runInContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'

const workerSource = readFileSync(new URL('../public/service-worker.js', import.meta.url), 'utf8')

interface WorkerEvent {
  data?: { json(): unknown }
  waitUntil(promise: Promise<unknown>): void
}

function loadWorker() {
  const listeners = new Map<string, (event: WorkerEvent) => void>()
  const showNotification = vi.fn<(title: string, options: NotificationOptions) => Promise<void>>()
  showNotification.mockResolvedValue(undefined)
  const addAll = vi.fn<(urls: string[]) => Promise<void>>()
  addAll.mockResolvedValue(undefined)
  runInContext(
    workerSource,
    createContext({
      self: {
        addEventListener: (type: string, listener: (event: WorkerEvent) => void) =>
          listeners.set(type, listener),
        registration: { showNotification },
        skipWaiting: vi.fn(),
      },
      caches: { open: async () => ({ addAll }) },
    }),
  )

  async function dispatch(type: string, json?: () => unknown) {
    const listener = listeners.get(type)
    if (!listener) throw new Error(`missing ${type} listener`)
    const pending: Promise<unknown>[] = []
    listener({
      ...(json ? { data: { json } } : {}),
      waitUntil: (promise) => pending.push(promise),
    })
    await Promise.all(pending)
  }

  return { dispatch, showNotification, addAll }
}

describe('notification presentation in the shipped service worker', () => {
  it('shows Veduta branding, the Space message and the monochrome status icon', async () => {
    const worker = loadWorker()
    await worker.dispatch('push', () => ({
      title: 'Veduta',
      body: 'bugs — È ora di fare una pausa.',
      url: '/app/space/bugs',
    }))

    expect(worker.showNotification).toHaveBeenCalledWith('Veduta', {
      body: 'bugs — È ora di fare una pausa.',
      icon: '/icons/icon-192.png',
      badge: '/icons/notification-badge.png',
      data: { url: '/app/space/bugs' },
    })
  })

  it('formats older queued pushes with the Space in the title using the same presentation', async () => {
    const worker = loadWorker()
    await worker.dispatch('push', () => ({ title: 'Health', body: 'A reminder', url: '/' }))

    expect(worker.showNotification).toHaveBeenCalledWith(
      'Veduta',
      expect.objectContaining({ body: 'Health — A reminder' }),
    )
  })

  it('keeps long legacy messages within the lock-screen limit after adding the Space', async () => {
    const worker = loadWorker()
    await worker.dispatch('push', () => ({ title: 'Health', body: 'A'.repeat(140), url: '/' }))
    expect(worker.showNotification).toHaveBeenCalledWith(
      'Veduta',
      expect.objectContaining({ body: `Health — ${'A'.repeat(131)}` }),
    )
  })

  it.each([undefined, {}, { title: 'Other', body: 'Unsafe', url: 'https://example.com' }])(
    'uses a branded safe fallback for invalid payloads: %j',
    async (payload) => {
      const worker = loadWorker()
      await worker.dispatch('push', () => payload)
      expect(worker.showNotification).toHaveBeenCalledWith(
        'Veduta',
        expect.objectContaining({
          body: 'New update',
          badge: '/icons/notification-badge.png',
          data: { url: '/' },
        }),
      )
    },
  )

  it('still displays a safe notification when the push JSON cannot be parsed', async () => {
    const worker = loadWorker()
    await worker.dispatch('push', () => {
      throw new SyntaxError('invalid push JSON')
    })
    expect(worker.showNotification).toHaveBeenCalledWith(
      'Veduta',
      expect.objectContaining({ body: 'New update', data: { url: '/' } }),
    )
  })

  it('precaches the status icon so displaying a push does not depend on reaching the VPS', async () => {
    const worker = loadWorker()
    await worker.dispatch('install')
    expect(worker.addAll).toHaveBeenCalledWith(
      expect.arrayContaining(['/icons/notification-badge.png']),
    )
  })
})
