// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { enablePush } from './push.ts'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('enablePush permission outcomes', () => {
  function browser(permission: NotificationPermission) {
    const requestPermission = vi.fn()
    const fetch = vi.fn()
    vi.stubGlobal('Notification', { permission, requestPermission })
    vi.stubGlobal('PushManager', class {})
    vi.stubGlobal('navigator', { serviceWorker: {} })
    vi.stubGlobal('fetch', fetch)
    return { requestPermission, fetch }
  }

  it('does not prompt or contact the Gateway when permission is blocked', async () => {
    const { requestPermission, fetch } = browser('denied')
    expect(await enablePush(null)).toBe('denied')
    expect(requestPermission).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each(['default', 'denied'] as const)(
    'distinguishes a prompt returning %s',
    async (permission) => {
      const { requestPermission, fetch } = browser('default')
      requestPermission.mockResolvedValue(permission)
      expect(await enablePush(null)).toBe(permission === 'default' ? 'dismissed' : 'denied')
      expect(requestPermission).toHaveBeenCalledOnce()
      expect(fetch).not.toHaveBeenCalled()
    },
  )

  it('reports a rejected browser permission request as a recoverable error', async () => {
    const { requestPermission } = browser('default')
    requestPermission.mockRejectedValue(new Error('Permission request unavailable'))
    expect(await enablePush(null)).toBe('error')
  })
})
