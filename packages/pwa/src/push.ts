import { PushSubscriptionSchema } from '@veduta/protocol'
import { z } from 'zod'
import { authHeaders } from './api.ts'

// Backslashes are rejected because `new URL('/\evil.com/x', base)` treats `\`
// as `/`, so a leading `/\` can resolve cross-origin despite passing a naive
// `startsWith('/')` check. ASCII control characters (charCode < 0x20, e.g.
// `\n`, `\0`) are rejected too, since they can smuggle injections into
// whatever eventually consumes this path.
// eslint-disable-next-line no-control-regex -- matching control chars is the point
const UNSAFE_RELATIVE_URL_CHARS = /[\\\x00-\x1f]/

/**
 * Mirrors the inline `isRelativeUrl` in `public/service-worker.js`: a push
 * payload's `url` (and a notification's stored `data.url`) must be a
 * same-origin relative path, never an absolute or protocol-relative one — a
 * push must never be usable to redirect the client off-origin. The service
 * worker is a classic script with no imports, so this logic can't be shared
 * directly; the two copies are kept in sync by hand and this file is the
 * tested one (see push.test.ts). If you change one, change the other.
 */
export function isRelativePushUrl(url: unknown): url is string {
  return (
    typeof url === 'string' &&
    url.startsWith('/') &&
    !url.startsWith('//') &&
    !UNSAFE_RELATIVE_URL_CHARS.test(url)
  )
}

/** Standard VAPID applicationServerKey conversion: `PushManager.subscribe`
 * needs a `Uint8Array`, the daemon hands back a base64url string. */
export function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4)
  const base64Safe = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(base64Safe)
  const output = new Uint8Array(raw.length)
  for (let index = 0; index < raw.length; index += 1) {
    output[index] = raw.charCodeAt(index)
  }
  return output
}

export function pushSupported(): boolean {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window
}

export type EnablePushResult = 'subscribed' | 'denied' | 'unsupported' | 'error'

/**
 * Subscribes this browser to Web Push and registers the subscription with
 * the daemon. MUST be invoked from a user gesture (e.g. a click handler) —
 * `Notification.requestPermission()` requires one, and calling this outside
 * a gesture silently resolves to the browser's default (denied) behavior in
 * most engines.
 */
export async function enablePush(token: string | null): Promise<EnablePushResult> {
  if (!pushSupported()) return 'unsupported'

  if (Notification.permission === 'denied') return 'denied'
  if (Notification.permission === 'default') {
    const permission = await Notification.requestPermission()
    if (permission !== 'granted') return 'denied'
  }

  try {
    const registration = await navigator.serviceWorker.ready
    const publicKey = await fetchVapidPublicKey(token)
    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    })
    await postSubscription(subscription.toJSON(), token)
    return 'subscribed'
  } catch {
    return 'error'
  }
}

/**
 * Re-posts an already-granted subscription to the daemon at app boot, so a
 * daemon data-dir reset (which wipes `push.sqlite`) doesn't silently strand
 * a browser that already has notification permission. A no-op whenever
 * permission isn't already 'granted' or there's no live subscription — this
 * never itself prompts the user.
 */
export async function syncPush(token: string | null): Promise<void> {
  if (!pushSupported()) return
  if (Notification.permission !== 'granted') return

  try {
    const registration = await navigator.serviceWorker.ready
    const subscription = await registration.pushManager.getSubscription()
    if (!subscription) return
    await postSubscription(subscription.toJSON(), token)
  } catch {
    // Best-effort resync; a future explicit enablePush() call will retry.
  }
}

const VapidPublicKeyResponseSchema = z.object({ publicKey: z.string().min(1) })

async function fetchVapidPublicKey(token: string | null): Promise<string> {
  const res = await fetch('/api/push/vapid-public-key', {
    headers: authHeaders(token ?? undefined),
  })
  if (!res.ok) throw new Error(`GET /api/push/vapid-public-key failed: ${res.status}`)
  return VapidPublicKeyResponseSchema.parse(await res.json()).publicKey
}

async function postSubscription(subscriptionJson: unknown, token: string | null): Promise<void> {
  const body = PushSubscriptionSchema.parse(subscriptionJson)
  const res = await fetch('/api/push/subscriptions', {
    method: 'POST',
    headers: { ...authHeaders(token ?? undefined), 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`POST /api/push/subscriptions failed: ${res.status}`)
}
