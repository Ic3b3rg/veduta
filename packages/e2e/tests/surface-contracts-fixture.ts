import { expect, test as base } from '@playwright/test'
import { cleanupStackDirs, startLocalVpsStack, type LocalVpsStack } from './stack.ts'

/** Clean authenticated Local VPS journey using the deterministic Model connection. */
export const test = base.extend<{ surfaceStack: LocalVpsStack }>({
  surfaceStack: async ({ page, context }, use) => {
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
    const stack = await startLocalVpsStack()
    try {
      const [setup] = await Promise.all([stack.waitForSetupUrl(), stack.waitForReadyLine()])
      await page.goto(setup.url)
      await page.getByRole('button', { name: 'Register passkey' }).click()
      await expect(page.getByRole('heading', { name: 'Set up Veduta' })).toBeVisible()
      await page.getByRole('button', { name: 'Continue' }).click()
      await page.getByLabel(/built-in mock provider/i).click()
      await expect(page.getByLabel(/built-in mock provider/i)).toBeChecked()
      await page.getByRole('button', { name: 'Continue' }).click()
      await page.getByRole('button', { name: 'Create' }).click()
      await page.getByRole('button', { name: 'Skip' }).click()
      await page.getByRole('button', { name: 'Finish' }).click()
      await stack.waitForReadyLine()
      await page
        .getByRole('main', { name: 'Home' })
        .getByRole('link', { name: /Health/ })
        .click()
      await expect(page.getByRole('main', { name: 'Health Space' })).toBeVisible()
      await use(stack)
    } finally {
      await stack.stop()
      await cleanupStackDirs(stack)
    }
  },
})
export { expect } from '@playwright/test'
