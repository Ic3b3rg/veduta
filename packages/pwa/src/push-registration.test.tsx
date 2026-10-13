// @vitest-environment jsdom
import { fromPartial } from '@total-typescript/shoehorn'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NotificationBell } from './notification-bell.tsx'
import { enablePush, syncPush } from './push.ts'

const subscriptionJson = {
  endpoint: 'https://web.push.apple.com/test-subscription',
  keys: { p256dh: 'A'.repeat(87), auth: 'B'.repeat(22) },
}

function browser(options: { key?: number[]; registrationStatus?: number } = {}) {
  const unsubscribe = vi.fn(async () => true)
  const subscription = fromPartial<PushSubscription>({
    options: fromPartial<PushSubscriptionOptions>({
      applicationServerKey: new Uint8Array(options.key ?? [1, 2, 3]).buffer,
    }),
    toJSON: () => subscriptionJson,
    unsubscribe,
  })
  const subscribe = vi.fn(async () =>
    fromPartial<PushSubscription>({ toJSON: () => subscriptionJson }),
  )
  const registration = fromPartial<ServiceWorkerRegistration>({
    pushManager: fromPartial<PushManager>({
      getSubscription: vi.fn(async () => subscription),
      subscribe,
    }),
  })
  vi.stubGlobal('Notification', { permission: 'granted' })
  vi.stubGlobal('PushManager', class {})
  vi.stubGlobal(
    'navigator',
    fromPartial<Navigator>({
      userAgent: 'Chrome',
      serviceWorker: fromPartial<ServiceWorkerContainer>({
        ready: Promise.resolve(registration),
        getRegistration: vi.fn(async () => registration),
      }),
    }),
  )
  vi.stubGlobal('matchMedia', () => fromPartial<MediaQueryList>({ matches: false }))
  const fetch = vi.fn(async (url: string) =>
    url === '/api/push/vapid-public-key'
      ? Response.json({ publicKey: 'AQID' })
      : new Response(null, { status: options.registrationStatus ?? 503 }),
  )
  vi.stubGlobal('fetch', fetch)
  return { fetch, unsubscribe, subscribe }
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('browser push registration readiness', () => {
  it('renews a subscription with an old signing key when the owner enables notifications', async () => {
    const { fetch, unsubscribe, subscribe } = browser({
      key: [9, 9, 9],
      registrationStatus: 204,
    })

    expect(await enablePush('owner-session')).toBe('subscribed')
    expect(unsubscribe).toHaveBeenCalledOnce()
    expect(subscribe).toHaveBeenCalledWith({
      userVisibleOnly: true,
      applicationServerKey: new Uint8Array([1, 2, 3]),
    })
    expect(fetch).toHaveBeenCalledWith('/api/push/subscriptions', expect.anything())
  })

  it('hides activation after the Gateway acknowledges the current subscription', async () => {
    browser({ registrationStatus: 204 })
    render(<NotificationBell token="owner-session" />)

    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Enable notifications' })).toBeNull(),
    )
  })

  it('does not synchronize a subscription belonging to an old Gateway signing key', async () => {
    const { fetch } = browser({ key: [9, 9, 9], registrationStatus: 204 })

    expect(await syncPush('owner-session')).toBe(false)
    expect(fetch).not.toHaveBeenCalledWith('/api/push/subscriptions', expect.anything())
  })

  it('offers activation again when permission is granted but the Gateway rejects registration', async () => {
    const { fetch } = browser()
    render(<NotificationBell token="owner-session" />)

    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith('/api/push/subscriptions', {
        method: 'POST',
        headers: { authorization: 'Bearer owner-session', 'content-type': 'application/json' },
        body: JSON.stringify(subscriptionJson),
      }),
    )
    expect(screen.getByRole('button', { name: 'Enable notifications' })).toBeDefined()
  })
})
