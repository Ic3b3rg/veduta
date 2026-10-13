import { defineConfig } from '@playwright/test'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  testDir: '.',
  testMatch: 'public-demo.spec.ts',
  workers: 1,
  timeout: 30_000,
  use: { baseURL: 'http://127.0.0.1:5191/veduta/', colorScheme: 'dark' },
  webServer: {
    command: 'pnpm --filter @veduta/e2e exec tsx demo/static-server.ts',
    cwd: fileURLToPath(new URL('../../../', import.meta.url)),
    url: 'http://127.0.0.1:5191/veduta/',
    reuseExistingServer: false,
  },
})
