import { expect, test } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AuthStore } from '../../daemon/src/auth-store.ts'
import { loadAuthState, saveAuthState } from '../../daemon/src/auth-state-file.ts'
import { OnboardingConfigSchema, saveOnboardingConfig } from '../../daemon/src/onboarding-config.ts'
import { buildServer } from '../../daemon/src/server.ts'
import { SimpleWebAuthnRelyingParty } from '../../daemon/src/webauthn.ts'
import { findFreePort } from './stack.ts'

test('Gmail token rejection shows safe recovery across authenticated tabs, reload, and restart', async ({
  browser,
}) => {
  const root = await mkdtemp(join(tmpdir(), 'veduta-e2e-gmail-failure-'))
  const port = await findFreePort()
  const origin = `http://localhost:${port}`
  const previousKey = process.env['VEDUTA_VAULT_KEY']
  process.env['VEDUTA_VAULT_KEY'] = 'disposable-gmail-failure-vault-key'
  const context = await browser.newContext()
  const page = await context.newPage()
  const providerRequests: string[] = []
  let server: ReturnType<typeof buildServer> | undefined
  const boot = () => {
    const path = join(root, 'auth.json')
    const state = loadAuthState(path)
    const auth = new AuthStore({
      mode: 'production',
      publicOrigin: origin,
      bootstrapCode: 'disposable-gmail-bootstrap',
      passkeys: new SimpleWebAuthnRelyingParty({ rpName: 'Veduta', rpID: 'localhost', origin }),
      ...(state ? { state } : {}),
      persist: (next) => saveAuthState(path, next),
    })
    return buildServer({
      dataDir: root,
      profile: 'local-vps',
      auth: { mode: 'production', store: auth, allowedOrigins: [origin] },
      onboarding: { env: { VEDUTA_LEGACY_HOME: root } },
      // Only Google's token transport is replaced; this does not claim successful real OAuth.
      gmailFetch: async (input) => {
        providerRequests.push(String(input))
        expect(String(input)).toBe('https://oauth2.googleapis.com/token')
        return new Response(
          JSON.stringify({ error: 'invalid_client', error_description: 'PROVIDER-ECHO-SECRET' }),
          { status: 400, headers: { 'content-type': 'application/json' } },
        )
      },
    })
  }
  try {
    saveOnboardingConfig(root, OnboardingConfigSchema.parse({ steps: { finish: 'completed' } }))
    server = boot()
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
    await page.goto(`${origin}/setup?code=disposable-gmail-bootstrap`)
    await page.getByRole('button', { name: 'Register passkey' }).click()
    await expect(page.getByRole('main', { name: 'Home' })).toBeVisible()
    await page.goto(`${origin}/app/connections`)
    await page.getByRole('button', { name: 'Add account', exact: true }).click()
    await page.getByRole('button', { name: 'Review access', exact: true }).click()
    const details = page.getByRole('dialog', { name: 'Gmail setup', exact: true })
    await details.getByLabel('Connection name', { exact: true }).fill('Disposable Gmail failure')
    await details.getByLabel('Google OAuth client ID').fill('disposable-client')
    await details.getByLabel('Google OAuth client secret').fill('disposable-secret')
    await page.route('https://accounts.google.com/o/oauth2/v2/auth?**', (route) =>
      route.fulfill({ contentType: 'text/html', body: '<p>Disposable Google consent fixture</p>' }),
    )
    await details.getByRole('button', { name: 'Continue to Google' }).click()
    await page.waitForURL('https://accounts.google.com/o/oauth2/v2/auth?**')
    const authorization = new URL(page.url())
    const gmailId = authorization.searchParams.get('state')!.split('.')[0]
    const callback = new URL(`${origin}/app/connections`)
    callback.searchParams.set('state', authorization.searchParams.get('state')!)
    callback.searchParams.set('code', 'disposable-authorization-code')
    await page.goto(callback.toString())
    await expect(details).toContainText('State: failed')
    await expect(details).toContainText('invalid_client')
    await expect(details).toContainText('full Client secret')
    await expect(details.getByRole('button', { name: 'Save access' })).toHaveCount(0)
    await expect(page.getByText(/PROVIDER-ECHO/)).toHaveCount(0)
    expect(page.url()).not.toMatch(/[?&](code|state)=/)
    await page.reload()
    await expect(details).toContainText('invalid_client')
    const observer = await context.newPage()
    await observer.goto(page.url())
    await expect(observer.getByRole('dialog', { name: 'Gmail setup', exact: true })).toContainText(
      'full Client secret',
    )

    await server.app.close()
    server = boot()
    await server.app.listen({ host: '127.0.0.1', port })
    await page.reload()
    await expect(details).toContainText('invalid_client')
    expect(server.serviceConnections.snapshot().grants).toEqual([])
    expect(providerRequests).toEqual(['https://oauth2.googleapis.com/token'])

    await details.getByRole('button', { name: 'Return to review' }).click()
    await expect(details).toContainText('State: reviewing')
    await details.getByRole('button', { name: 'Continue to Google' }).click()
    await page.waitForURL('https://accounts.google.com/o/oauth2/v2/auth?**')
    const retry = new URL(page.url())
    expect(retry.searchParams.get('redirect_uri')).toBe(`${origin}/app/connections`)
    const declined = new URL(`${origin}/app/connections`)
    declined.searchParams.set('state', retry.searchParams.get('state')!)
    declined.searchParams.set('error', 'access_denied')
    await page.goto(declined.toString())
    await expect(details).toContainText('Gmail authorization was declined.')
    expect(providerRequests).toEqual(['https://oauth2.googleapis.com/token'])
    await details.getByRole('button', { name: 'Return to review' }).click()
    await expect(details).toContainText('State: reviewing')
    await expect(details.getByRole('button', { name: 'Continue to Google' })).toBeEnabled()
    await details.getByRole('button', { name: 'Continue to Google' }).click()
    await page.waitForURL('https://accounts.google.com/o/oauth2/v2/auth?**')
    const resumed = new URL(page.url())
    expect(resumed.searchParams.get('state')?.split('.')[0]).toBe(gmailId)
    declined.searchParams.set('state', resumed.searchParams.get('state')!)
    await page.goto(declined.toString())
    await expect(details).toContainText('Gmail authorization was declined.')
    await details.getByRole('button', { name: 'Return to review' }).click()
    await details.getByRole('button', { name: 'Cancel setup' }).click()
  } finally {
    try {
      await context.close()
    } finally {
      try {
        await server?.app.close()
      } finally {
        await rm(root, { recursive: true, force: true })
        if (previousKey === undefined) delete process.env['VEDUTA_VAULT_KEY']
        else process.env['VEDUTA_VAULT_KEY'] = previousKey
      }
    }
  }
})
