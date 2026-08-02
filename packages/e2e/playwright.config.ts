import { defineConfig, devices } from '@playwright/test'

/**
 * Real-browser e2e suite for the Local VPS profile (issue 023,
 * `docs/adr/0009-local-vps-profile.md`): each spec spawns its own
 * `deploy/local-vps.sh` process (see `tests/stack.ts`) and drives it through
 * a real Chromium instance, so there is exactly one project (no
 * cross-browser matrix — WebAuthn virtual authenticators are a Chrome
 * DevTools Protocol feature) and `workers: 1` (the suite serializes daemon
 * boots on a single port/base-dir per journey; parallel workers would race
 * over the same process group).
 */
export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  workers: 1,
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
