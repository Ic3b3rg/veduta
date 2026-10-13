import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, type Browser } from '@playwright/test'
import { AuthStore } from '../../daemon/src/auth-store.ts'
import { loadAuthState, saveAuthState } from '../../daemon/src/auth-state-file.ts'
import { OnboardingConfigSchema, saveOnboardingConfig } from '../../daemon/src/onboarding-config.ts'
import { buildServer } from '../../daemon/src/server.ts'
import { Store } from '../../daemon/src/store.ts'
import { formatFactsMarkdown } from '../../daemon/src/facts.ts'
import { SimpleWebAuthnRelyingParty } from '../../daemon/src/webauthn.ts'
import { findFreePort } from './stack.ts'

const INITIAL_TIME = '2026-10-13T10:00:00.000Z'

/** Real Local VPS auth/PWA/Gateway with the existing injectable clock, no external provider. */
export async function memoryHealthStack(browser: Browser, width: number) {
  const previousTimezone = process.env['TZ']
  process.env['TZ'] = 'UTC'
  const root = await mkdtemp(join(tmpdir(), 'veduta-e2e-memory-health-'))
  const port = await findFreePort()
  const origin = `http://localhost:${port}`
  let instant = INITIAL_TIME
  const now = () => new Date(instant)
  const initial = new Store({
    rootDir: root,
    now,
    seed: { spaces: [], surfaces: [] },
    memoryBudget: { low: 30, high: 40, hard: 150 },
  })
  initial.spacesEngine.createSpace({ name: 'Health', instructions: 'x'.repeat(2000) })
  initial.close()
  await writeFile(
    join(root, 'memory.json'),
    JSON.stringify({ timezone: 'Europe/Rome', budget: { low: 30, high: 40, hard: 150 } }),
  )
  await writeFile(join(root, 'USER.md'), '😀'.repeat(1000))
  await writeFile(join(root, 'connections.json'), JSON.stringify({ mockEnabled: true }))
  saveOnboardingConfig(root, OnboardingConfigSchema.parse({ steps: { finish: 'completed' } }))
  const context = await browser.newContext({
    viewport: { width, height: 900 },
    timezoneId: 'Europe/Rome',
    locale: 'it-IT',
    reducedMotion: 'reduce',
  })
  const page = await context.newPage()
  const boot = () => {
    const path = join(root, 'auth.json')
    const state = loadAuthState(path)
    const auth = new AuthStore({
      mode: 'production',
      publicOrigin: origin,
      bootstrapCode: 'disposable-relative-bootstrap',
      passkeys: new SimpleWebAuthnRelyingParty({ rpName: 'Veduta', rpID: 'localhost', origin }),
      ...(state ? { state } : {}),
      persist: (next) => saveAuthState(path, next),
    })
    return buildServer({
      dataDir: root,
      profile: 'local-vps',
      now,
      auth: { mode: 'production', store: auth, allowedOrigins: [origin] },
      onboarding: { env: { VEDUTA_LEGACY_HOME: root } },
    })
  }
  let server = boot()
  return {
    origin,
    page,
    async update() {
      instant = '2026-10-13T10:05:00.000Z'
      await page.clock.setFixedTime(new Date(instant))
      await writeFile(join(root, 'USER.md'), '😀'.repeat(1000) + 'x')
      const engine = server.store.spacesEngine
      engine.updateInstructions(
        'spc-health',
        'x'.repeat(2001),
        engine.readInstructions('spc-health'),
      )
      engine.writeFact(
        'spc-health',
        'I walk every morning and evening to maintain my daily exercise routine.',
      )
    },
    async injectPersistenceFailure() {
      await rm(join(root, 'memory-health.json'))
      await mkdir(join(root, 'memory-health.json'))
      await writeFile(
        join(root, 'spaces', 'health', 'FACTS.md'),
        formatFactsMarkdown(
          { active: [{ text: 'x'.repeat(200) }], dormant: [], superseded: [] },
          '2026-10-13',
        ),
      )
      server.store.spacesEngine.auditMemoryHealth('spc-health')
    },
    async repairPersistence() {
      await rm(join(root, 'memory-health.json'), { recursive: true })
      server.store.spacesEngine.auditMemoryHealth()
    },
    notificationStats() {
      return server.notificationCenter.stats()
    },
    notificationEvents() {
      return server.store
        .listSpaces()
        .flatMap((space) =>
          server.store.eventLog(space.id).filter((event) => event.type === 'notification'),
        )
    },
    async start() {
      await server.app.listen({ host: '127.0.0.1', port })
      const cdp = await context.newCDPSession(page)
      await cdp.send('WebAuthn.enable')
      await cdp.send('WebAuthn.addVirtualAuthenticator', {
        options: {
          protocol: 'ctap2',
          transport: 'internal',
          hasResidentKey: true,
          hasUserVerification: true,
          isUserVerified: true,
          automaticPresenceSimulation: true,
        },
      })
      await page.clock.setFixedTime(new Date(instant))
      await page.goto(`${origin}/setup?code=disposable-relative-bootstrap`)
      await page.getByRole('button', { name: 'Register passkey' }).click()
      await expect(page.getByRole('main', { name: 'Home' })).toBeVisible()
    },
    async restart() {
      await server.app.close()
      server = boot()
      await server.app.listen({ host: '127.0.0.1', port })
      await page.reload()
    },
    async stop() {
      await context.close()
      await server.app.close()
      await rm(root, { recursive: true, force: true })
      if (previousTimezone === undefined) delete process.env['TZ']
      else process.env['TZ'] = previousTimezone
    },
  }
}
