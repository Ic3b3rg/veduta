import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

// Dev profile (issue #1): the PWA dev server proxies API and Gateway WS
// to the daemon on loopback. No TLS, no domain — that's issue #5.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: process.env['VEDUTA_CHAT_PROTOTYPE'] === '1' ? 5184 : 5173,
    proxy: {
      '/api': 'http://127.0.0.1:8787',
      '/ws': { target: 'ws://127.0.0.1:8787', ws: true },
    },
  },
})
