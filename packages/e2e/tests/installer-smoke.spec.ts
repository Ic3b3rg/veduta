import { expect, test } from '@playwright/test'

// Opt-in against a clean, operator-provided installation while its terminal is
// waiting for the first passkey. Never targets a real server in the normal suite.
const setupUrl = process.env['VEDUTA_INSTALLER_SMOKE_URL']
const accessLabels: Record<string, string> = {
  public: 'HTTPS active',
  tailnet: 'Private · Tailscale',
  tunnel: 'Private · SSH',
}
const accessLabel = accessLabels[process.env['VEDUTA_INSTALLER_SMOKE_MODE'] ?? 'tunnel']!
test.use({ ignoreHTTPSErrors: process.env['VEDUTA_INSTALLER_SMOKE_TEST_CA'] === '1' })
test.skip(!setupUrl, 'Set VEDUTA_INSTALLER_SMOKE_URL for the installer smoke journey')

test('installed VPS: passkey, private access details, refresh, and re-login', async ({
  page,
  context,
}) => {
  if (!setupUrl) throw new Error('setup URL required')
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
  await page.goto(setupUrl)
  await page.getByRole('button', { name: 'Register passkey' }).click()
  await expect(page.getByRole('button', { name: 'Register passkey' })).toBeHidden()
  await expect(page.getByText(accessLabel, { exact: true })).toBeVisible()
  await page.reload()
  await expect(page.getByText(accessLabel, { exact: true })).toBeVisible()
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await page.getByRole('button', { name: /sign in with passkey/i }).click()
  await expect(page.getByText(accessLabel, { exact: true })).toBeVisible()
})
