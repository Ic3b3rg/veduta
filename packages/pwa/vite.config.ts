import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Dev profile (issue #1): the PWA dev server proxies API and chat WS
// to the daemon on loopback. No TLS, no domain — that's issue #5.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:8787',
      '/ws': { target: 'ws://127.0.0.1:8787', ws: true },
    },
  },
})
