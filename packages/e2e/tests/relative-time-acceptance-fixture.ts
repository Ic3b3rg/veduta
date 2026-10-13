import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, type Browser, type Page } from '@playwright/test'
import { AuthStore } from '../../daemon/src/auth-store.ts'
import { loadAuthState, saveAuthState } from '../../daemon/src/auth-state-file.ts'
import { createFocusedSurfaceTools } from '../../daemon/src/focused-surface-tools.ts'
import { OnboardingConfigSchema, saveOnboardingConfig } from '../../daemon/src/onboarding-config.ts'
import { buildServer } from '../../daemon/src/server.ts'
import { Store } from '../../daemon/src/store.ts'
import { TemplateEngine } from '../../daemon/src/template-engine.ts'
import { TurnTaintAccumulator } from '../../daemon/src/taint.ts'
import { SimpleWebAuthnRelyingParty } from '../../daemon/src/webauthn.ts'
import { findFreePort } from './stack.ts'

export const BEFORE_BOUNDARY = '2026-03-29T21:59:58.000Z'
export const AFTER_BOUNDARY = '2026-03-29T22:00:01.000Z'
export const SPENDING_ID = 'srf-daily-spending'

/** Real Local VPS auth/PWA/Gateway with the existing injectable clock, no external provider. */
export async function relativeTimeStack(browser: Browser, width: number) {
  const previousTimezone = process.env['TZ']
  process.env['TZ'] = 'UTC'
  const root = await mkdtemp(join(tmpdir(), 'veduta-e2e-relative-time-'))
  const port = await findFreePort()
  const origin = `http://localhost:${port}`
  let instant = BEFORE_BOUNDARY
  const now = () => new Date(instant)
  new Store({ rootDir: root, now, timeZone: 'Europe/Rome' }).close()
  await writeFile(join(root, 'connections.json'), JSON.stringify({ mockEnabled: true }))
  await writeFile(join(root, 'memory.json'), JSON.stringify({ timezone: 'Europe/Rome' }))
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
  const invoke = async (name: string, input: unknown) => {
    const tools = createFocusedSurfaceTools({
      store: server.store,
      templateEngine: new TemplateEngine({ store: server.store }),
      spaceId: 'spc-health',
    })
    const tool = tools.find((tool) => tool.name === name)
    if (!tool) throw new Error(`Missing focused tool ${name}`)
    return tool.handler(tool.schema.parse(input), {
      toolCallId: 'relative-time-acceptance',
      origin: 'trusted:user',
      origins: ['trusted:user'],
      taint: new TurnTaintAccumulator(['trusted:user']),
      contextHash: 'relative-time-acceptance',
    })
  }
  return {
    origin,
    page,
    invoke,
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
    async crossBoundary() {
      instant = AFTER_BOUNDARY
      await page.clock.setFixedTime(new Date(instant))
    },
    async restart() {
      await server.app.close()
      server = boot()
      await server.app.listen({ host: '127.0.0.1', port })
      await page.reload()
    },
    async disconnect() {
      await server.app.close()
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

export async function prepareRelativeFixtures(
  stack: Awaited<ReturnType<typeof relativeTimeStack>>,
) {
  await stack.invoke('patch_state', {
    surfaceId: 'srf-meals',
    operations: [
      {
        target: 'state',
        op: 'replace',
        path: '/mealRecords',
        value: [
          { occurredAt: '2026-03-29T12:00:00+02:00', time: '12:00', meal: 'Current lunch' },
          { occurredAt: '2026-03-28T12:00:00+01:00', time: '12:00', meal: 'Old lunch' },
          { time: '08:00', meal: 'Undated breakfast' },
        ],
      },
      {
        target: 'state',
        op: 'replace',
        path: '/meals',
        value: [{ occurredAt: '2026-03-29T10:00:00.000Z', time: '12:00', meal: 'Current lunch' }],
      },
      { target: 'state', op: 'replace', path: '/lastMeal', value: 'Current lunch' },
      { target: 'state', op: 'replace', path: '/mealCount', value: 1 },
    ],
  })
  await stack.invoke('create_surface', {
    id: SPENDING_ID,
    title: 'Daily spending',
    tree: {
      id: 'root',
      type: 'Col',
      children: [
        { id: 'count', type: 'Stat', binding: 'todayCount', props: { label: 'Today' } },
        { id: 'total', type: 'Stat', binding: 'todayTotal', props: { label: 'Total' } },
        { id: 'latest', type: 'Stat', binding: 'latestMerchant', props: { label: 'Latest' } },
        {
          id: 'rows',
          type: 'Table',
          binding: 'todayRows',
          props: { columns: ['merchant', 'amount'] },
        },
      ],
    },
    state: {
      spendingRecords: [
        { occurredAt: '2026-03-29T11:30:00+02:00', merchant: 'Bookshop', amount: 18 },
        { occurredAt: '2026-03-28T11:30:00+01:00', merchant: 'Old shop', amount: 99 },
        { merchant: 'Undated shop', amount: 25 },
      ],
      todayRows: [{ merchant: 'Bookshop', amount: 18 }],
      todayCount: 1,
      todayTotal: 18,
      latestMerchant: 'Bookshop',
    },
    relativeTime: {
      window: 'day',
      source: { stateKey: 'spendingRecords' },
      projectionStateKeys: ['todayRows', 'todayCount', 'todayTotal', 'latestMerchant'],
    },
  })
}

export async function openHealth(page: Page, origin: string) {
  await page.goto(`${origin}/app/space/health`)
}
