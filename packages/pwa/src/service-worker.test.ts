import { readFileSync } from 'node:fs'
import { createContext, runInContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'

const workerSource = readFileSync(new URL('../public/service-worker.js', import.meta.url), 'utf8')
const iconBytes = readFileSync(new URL('../public/icons/icon-192.png', import.meta.url))
const badgeBytes = readFileSync(new URL('../public/icons/notification-badge.png', import.meta.url))
const iconDataUrl = `data:image/png;base64,${iconBytes.toString('base64')}`
const badgeDataUrl = `data:image/png;base64,${badgeBytes.toString('base64')}`

interface WorkerEvent {
  data?: { json(): unknown }
  waitUntil(promise: Promise<unknown>): void
}

function loadWorker(cacheState: 'present' | 'missing' | 'unavailable' = 'present') {
  const listeners = new Map<string, (event: WorkerEvent) => void>()
  const showNotification = vi.fn<(title: string, options: NotificationOptions) => Promise<void>>()
  showNotification.mockResolvedValue(undefined)
  const addAll = vi.fn<(urls: string[]) => Promise<void>>()
  addAll.mockResolvedValue(undefined)
  const fetch = vi.fn().mockRejectedValue(new Error('network unavailable'))
  runInContext(
    workerSource,
    createContext({
      fetch,
      self: {
        btoa,
        addEventListener: (type: string, listener: (event: WorkerEvent) => void) =>
          listeners.set(type, listener),
        registration: { showNotification },
        skipWaiting: vi.fn(),
      },
      caches: {
        open: async () => ({ addAll }),
        match: async (path: string) => {
          if (cacheState === 'unavailable') throw new Error('cache unavailable')
          if (cacheState === 'missing') return undefined
          const bytes = path === '/icons/icon-192.png' ? iconBytes : badgeBytes
          return new Response(new Uint8Array(bytes))
        },
      },
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

  return { dispatch, showNotification, addAll, fetch }
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
      icon: iconDataUrl,
      badge: badgeDataUrl,
      data: { url: '/app/space/bugs' },
    })
    expect(worker.fetch).not.toHaveBeenCalled()
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
          badge: badgeDataUrl,
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

  it.each(['missing', 'unavailable'] as const)(
    'still shows the notification without network image requests when the cache is %s',
    async (cacheState) => {
      const worker = loadWorker(cacheState)
      await worker.dispatch('push', () => ({ title: 'Veduta', body: 'Health — Update', url: '/' }))
      expect(worker.showNotification).toHaveBeenCalledWith('Veduta', {
        body: 'Health — Update',
        icon: undefined,
        badge: undefined,
        data: { url: '/' },
      })
      expect(worker.fetch).not.toHaveBeenCalled()
    },
  )
})
