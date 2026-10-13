import { defineConfig, devices } from '@playwright/test'

/**
 * Real-browser e2e suite for the Local VPS profile (issue 023,
 * `docs/adr/0009-local-vps-profile.md`): each spec spawns its own
 * `deploy/local-vps.sh` process (see `tests/stack.ts`) and drives it through
 * a real Chromium instance, so there is exactly one project (no
 * cross-browser matrix — WebAuthn virtual authenticators are a Chrome
 * DevTools Protocol feature). Journeys own their ports, data directories and
 * process groups. Global setup prepares immutable PWA assets for all boots.
 */
export default defineConfig({
  testDir: './tests',
  globalSetup: './global-setup.ts',
  fullyParallel: false,
  workers: 2,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  use: {
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
})
