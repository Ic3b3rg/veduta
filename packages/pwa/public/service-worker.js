const CACHE_NAME = 'veduta-shell-v1'
const APP_SHELL = ['/', '/manifest.webmanifest', '/icons/icon-192.svg', '/icons/icon-512.svg']

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
