import { test, expect } from './surface-contracts-fixture.ts'

test('link and revoke a second device through the PWA, with independent passkeys and refresh', async ({
  page,
  browser,
  surfaceStack,
}) => {
  await page.getByRole('button', { name: 'Connections', exact: true }).click()
  await page.getByRole('link', { name: 'Devices', exact: true }).click()
  await expect(page.getByText('This access', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Link a device', exact: true }).click()
  await expect(page.getByRole('img', { name: 'Scan to link a device' })).toBeVisible()
  const link = await page.getByLabel('Device linking link').inputValue()
  expect(new URL(link).origin).toBe(surfaceStack.origin)

  const phoneContext = await browser.newContext({ viewport: { width: 390, height: 844 } })
  try {
    const phone = await phoneContext.newPage()
    const cdp = await phoneContext.newCDPSession(phone)
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
    await phone.goto(link)
    await phone.getByLabel('Device name').fill('Test phone')
    await phone.getByRole('button', { name: 'Register passkey', exact: true }).click()
    await expect(phone.getByRole('main', { name: 'Home', exact: true })).toBeVisible()
    await expect(
      phone.getByRole('main', { name: 'Home' }).getByRole('link', { name: /Health/ }),
    ).toBeVisible()
    await phone.reload()
    await expect(phone.getByRole('main', { name: 'Home', exact: true })).toBeVisible()
    await phone.evaluate(() => localStorage.removeItem('veduta.authToken'))
    await phone.reload()
    await phone.getByLabel('Device name').fill('Test phone')
    await phone.getByRole('button', { name: 'Sign in with passkey' }).click()
    await expect(phone.getByRole('main', { name: 'Home', exact: true })).toBeVisible()

    await page.getByRole('button', { name: 'Refresh devices' }).click()
    const phoneEntry = page.getByRole('group', { name: 'Test phone', exact: true })
    await expect(phoneEntry).toBeVisible()
    await page.reload()
    await expect(phoneEntry).toBeVisible()
    await phoneEntry.getByRole('button', { name: 'Revoke access' }).click()
    await phoneEntry.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(phone.getByRole('main', { name: 'Home', exact: true })).toBeVisible()
    await phoneEntry.getByRole('button', { name: 'Revoke access' }).click()
    await phoneEntry.getByRole('button', { name: 'Confirm revoke' }).click()
    await expect(phoneEntry).toBeHidden()
    await expect(phone.getByRole('button', { name: 'Sign in with passkey' })).toBeVisible()
    await phone.reload()
    await expect(phone.getByRole('button', { name: 'Sign in with passkey' })).toBeVisible()
    await page.reload()
    await expect(page.getByText('This access', { exact: true })).toBeVisible()

    await phone.goto(link)
    await phone.getByRole('button', { name: 'Register passkey', exact: true }).click()
    await expect(phone.getByRole('alert')).toContainText(/code|authentication failed/)
    await expect(phone.getByRole('button', { name: 'Register passkey', exact: true })).toBeVisible()
  } finally {
    await phoneContext.close()
  }
})
