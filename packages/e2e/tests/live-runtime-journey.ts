import {
  expect,
  test,
  type Browser,
  type BrowserContext,
  type Page,
  type WebSocketRoute,
} from '@playwright/test'
import { AuthSessionSchema, PairingCodeSchema } from '../../protocol/src/auth.ts'

/** Extends the real authenticated Local VPS journey with client lifecycle failure paths (#155). */
export async function verifyLiveRuntime(
  browser: Browser,
  primary: Page,
  origin: string,
): Promise<void> {
  const token = await primary.evaluate(() => localStorage.getItem('veduta.authToken'))
  if (!token) throw new Error('Primary authenticated session is missing')
  const headers = { authorization: `Bearer ${token}` }
  const pairingResponse = await primary.request.post(`${origin}/api/auth/pairing-codes`, {
    headers,
  })
  expect(pairingResponse.ok()).toBe(true)
  const pairing = PairingCodeSchema.parse(await pairingResponse.json())
  const observerContext: BrowserContext = await browser.newContext()
  const observer = await observerContext.newPage()
  try {
    const cdp = await observerContext.newCDPSession(observer)
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
    await observer.goto(origin)
    const registered = await observer.evaluate(async (code) => {
      const optionsResponse = await fetch('/api/auth/register/options', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ oneTimeCode: code, deviceName: 'Runtime observer' }),
      })
      const envelope = await optionsResponse.json()
      const publicKey = PublicKeyCredential.parseCreationOptionsFromJSON(envelope.options)
      const credential = await navigator.credentials.create({ publicKey })
      if (!(credential instanceof PublicKeyCredential))
        throw new Error('Observer passkey registration failed')
      const verified = await fetch('/api/auth/register/verify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ceremonyId: envelope.ceremonyId, response: credential.toJSON() }),
      })
      if (!verified.ok) throw new Error(`Observer registration failed: ${verified.status}`)
      return verified.json()
    }, pairing.code)
    const session = AuthSessionSchema.parse(registered)
    await observer.evaluate(
      (token) => localStorage.setItem('veduta.authToken', token),
      session.token,
    )
    let disconnected = false
    let liveSocket: WebSocketRoute | undefined
    let queuedSends = 0
    await observer.routeWebSocket('**/ws/gateway', (route) => {
      if (disconnected) {
        void route.close()
        return
      }
      liveSocket = route
      const server = route.connectToServer()
      route.onMessage((message) => {
        if (String(message).includes('Hello from queued runtime')) queuedSends += 1
        server.send(message)
      })
    })
    await observer.goto(`${origin}/app/space/health`)
    await expect(observer.locator('.app-shell')).toHaveAttribute('data-gateway-online', 'true')
    const primaryMilk = groceries(primary).getByRole('checkbox', { name: 'Milk' })
    const observerMilk = groceries(observer).getByRole('checkbox', { name: 'Milk' })
    const original = await primaryMilk.getAttribute('aria-checked')
    await test.step('two authenticated devices converge live', async () => {
      await primaryMilk.click()
      await expect(observerMilk).toHaveAttribute(
        'aria-checked',
        original === 'true' ? 'false' : 'true',
      )
    })
    await test.step('missed-event reconnect preserves one queued Chat submission without reloading', async () => {
      disconnected = true
      await liveSocket?.close()
      await expect(observer.locator('.app-shell')).toHaveAttribute('data-gateway-online', 'false')
      await primaryMilk.click()
      await expect(primaryMilk).toHaveAttribute('aria-checked', original ?? 'false')
      await expect(observerMilk).toHaveAttribute(
        'aria-checked',
        original === 'true' ? 'false' : 'true',
      )
      const composer = observer.getByRole('textbox', { name: 'Message Veduta in Health' })
      await composer.fill('Hello from queued runtime')
      await composer.press('Enter')
      await expect(observer.getByText('1 queued', { exact: true })).toBeVisible()
      const queuedId = await observer.evaluate(
        () => JSON.parse(localStorage.getItem('veduta.chatQueue') ?? '[]')[0]?.id,
      )
      expect(queuedId).toBeTruthy()
      disconnected = false
      await expect(observer.locator('.app-shell')).toHaveAttribute('data-gateway-online', 'true', {
        timeout: 20_000,
      })
      await expect(observerMilk).toHaveAttribute('aria-checked', original ?? 'false')
      await expect(observer.getByText('1 queued', { exact: true })).toHaveCount(0)
      expect(queuedSends).toBe(1)
      expect(await observer.evaluate(() => performance.getEntriesByType('navigation').length)).toBe(
        1,
      )
      expect(
        await observer.evaluate(() => JSON.parse(localStorage.getItem('veduta.chatQueue') ?? '[]')),
      ).toEqual([])
    })
    await test.step('malformed and unresolvable updates remain visible and recover confirmed state', async () => {
      liveSocket?.send('{malformed')
      await expect(observer.locator('.app-shell > [role="alert"]')).toContainText(
        'Malformed Gateway frame',
      )
      await expect(observerMilk).toHaveAttribute('aria-checked', original ?? 'false')
      const current = await primary.request.get(`${origin}/api/spaces`, { headers })
      const snapshot = await current.json()
      liveSocket?.send(
        JSON.stringify({
          type: 'surface.patch',
          event: {
            cursor: snapshot.surfaceCursor + 1,
            spaceId: 'spc-health',
            at: new Date().toISOString(),
            patch: {
              surfaceId: 'srf-does-not-exist',
              operations: [{ target: 'state', op: 'replace', path: '/value', value: 'unknown' }],
            },
            freshness: { updatedAt: new Date().toISOString(), updatedBy: 'user' },
          },
        }),
      )
      await expect(observer.locator('.app-shell > [role="alert"]')).toContainText(
        'Surface update could not be applied',
      )
      await expect(observerMilk).toHaveAttribute('aria-checked', original ?? 'false')
      expect(await observer.evaluate(() => performance.getEntriesByType('navigation').length)).toBe(
        1,
      )
    })
    await test.step('device revocation shuts down live authority and returns to sign-in', async () => {
      const revoked = await primary.request.post(
        `${origin}/api/auth/devices/${session.device.id}/revoke`,
        { headers },
      )
      expect(revoked.status()).toBe(204)
      await expect(observer.getByRole('button', { name: 'Sign in with passkey' })).toBeVisible()
      expect(await observer.evaluate(() => localStorage.getItem('veduta.authToken'))).toBeNull()
      await expect(primary.locator('.app-shell')).toHaveAttribute('data-gateway-online', 'true')
    })
  } finally {
    await observerContext.close()
  }
}

function groceries(page: Page) {
  return page.locator('article.surface-card', {
    has: page.getByRole('button', { name: 'Focus Groceries' }),
  })
}
