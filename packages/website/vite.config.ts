import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  base: './',
  plugins: [
    react(),
    tailwindcss(),
    {
      name: 'local-product-media',
      transformIndexHtml(html, context) {
        // Production resolves these assets normally; Vite development serves files through /@fs.
        if (context.server)
          return html.replaceAll(
            '../../docs/media/',
            `/@fs${fileURLToPath(new URL('../../docs/media/', import.meta.url))}`,
          )
        // Vite rewrites media src attributes, but leaves ordinary download hrefs untouched.
        const source = /<source\b[^>]*src="([^"]+)"/.exec(html)?.[1]
        return source ? html.replace('../../docs/media/veduta-demo.mp4', source) : html
      },
    },
  ],
  build: {
    assetsInlineLimit: 0,
    rollupOptions: {
      input: {
        landing: fileURLToPath(new URL('index.html', import.meta.url)),
        demo: fileURLToPath(new URL('demo.html', import.meta.url)),
      },
    },
  },
})
