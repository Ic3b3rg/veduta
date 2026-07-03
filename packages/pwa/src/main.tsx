import { createRoot } from 'react-dom/client'
import { App } from './app.tsx'

createRoot(document.getElementById('root')!).render(<App />)

// Dev is excluded: a cache-first worker would serve Vite's transformed
// modules stale and break hot reload. Dev also unregisters any worker left
// behind by an earlier build so it stops controlling localhost.
if ('serviceWorker' in navigator) {
  if (import.meta.env.PROD) {
    window.addEventListener('load', () => {
      void navigator.serviceWorker.register('/service-worker.js').catch(() => undefined)
    })
  } else {
    void navigator.serviceWorker
      .getRegistrations()
      .then((registrations) => registrations.forEach((registration) => registration.unregister()))
      .catch(() => undefined)
  }
}
