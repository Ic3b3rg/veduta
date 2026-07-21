const CACHE_NAME = 'veduta-shell-v1'
const APP_SHELL = ['/', '/manifest.webmanifest', '/icons/icon-192.svg', '/icons/icon-512.svg']

// A push must never be usable to redirect the client off-origin, so any url
// carried by a push payload or a notification's stored data is required to
// be a same-origin relative path. This is a classic worker (no imports), so
// this rule is duplicated by hand from src/push.ts's `isRelativePushUrl` —
// the pure-function tests for the identical logic live in push.test.ts.
// Keep both copies in sync if you change the rule.
//
// Backslashes are rejected because `new URL('/\evil.com/x', base)` treats `\`
// as `/`, so a leading `/\` can resolve cross-origin despite passing a naive
// `startsWith('/')` check. ASCII control characters (charCode < 0x20) are
// rejected too, since they can smuggle injections into whatever eventually
// consumes this path.
function isRelativeUrl(url) {
  return (
    typeof url === 'string' &&
    url.startsWith('/') &&
    !url.startsWith('//') &&
    // eslint-disable-next-line no-control-regex -- matching control chars is the point
    !/[\\\x00-\x1f]/.test(url)
  )
}

function isValidPushPayload(data) {
  return (
    data !== null &&
    typeof data === 'object' &&
    typeof data.title === 'string' &&
    data.title.length > 0 &&
    typeof data.body === 'string' &&
    isRelativeUrl(data.url)
  )
}

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)))
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))),
      ),
  )
  self.clients.claim()
})

// Hashed /assets/* files enter the cache the first time this worker serves
// them, i.e. from the second visit onward; the first offline load still has
// the Home data via the localStorage snapshot.
self.addEventListener('fetch', (event) => {
  const request = event.request
  if (request.method !== 'GET') return

  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/ws/')) return

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          cacheIfOk(event, '/', response)
          return response
        })
        .catch(() => caches.match('/').then((cached) => cached ?? Response.error())),
    )
    return
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached
      return fetch(request).then((response) => {
        cacheIfOk(event, request, response)
        return response
      })
    }),
  )
})

// Only successful same-origin responses may enter the shell cache: a cached
// error page (e.g. a 500 mid-deploy) would poison offline loads forever.
function cacheIfOk(event, key, response) {
  if (!response.ok || response.type !== 'basic') return
  const copy = response.clone()
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.put(key, copy)))
}

// Web Push (issue 018): malformed or empty payloads (a push carries no
// guarantee of shape — it's attacker-observable ciphertext until decrypted
// by the browser) fall back to a generic notification rather than crashing
// the event or showing nothing.
self.addEventListener('push', (event) => {
  let payload
  try {
    payload = event.data?.json()
  } catch {
    payload = undefined
  }

  const valid = isValidPushPayload(payload)
  const title = valid ? payload.title : 'Veduta'
  const body = valid ? payload.body : 'New update'
  const url = valid ? payload.url : '/'

  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon: '/icons/icon-192.svg',
      data: { url },
    }),
  )
})

// Focus an already-open client and hand it the deep link rather than always
// opening a new window/tab; app.tsx's service-worker 'message' listener
// routes { type: 'navigate', url } through the same deep-link focus logic
// popstate uses.
self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const url = isRelativeUrl(event.notification.data?.url) ? event.notification.data.url : '/'

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      const client = clientList[0]
      if (!client) return self.clients.openWindow(url)
      return client.focus().then(() => client.postMessage({ type: 'navigate', url }))
    }),
  )
})
