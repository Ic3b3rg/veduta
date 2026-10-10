import { expect, test, type APIResponse } from '@playwright/test'
import { OnboardingStatusSchema } from '../../protocol/src/index.ts'
import { ActionWire, signal } from './fast-actions-journey.ts'
import { cleanupStackDirs, startLocalVpsStack } from './stack.ts'

for (const lateResult of ['status', 'error'] as const) {
  test(`onboarding keeps confirmed progress after a delayed reconnect ${lateResult}`, async ({
    page,
    context,
  }) => {
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
    const wire = new ActionWire(page, [])
    wire.disconnected = true
    await wire.install()
    const stack = await startLocalVpsStack()
    const captured = signal<APIResponse>()
    const release = signal<void>()
    try {
      const [setup] = await Promise.all([stack.waitForSetupUrl(), stack.waitForReadyLine()])
      await page.goto(setup.url)
      await page.getByRole('button', { name: 'Register passkey' }).click()
      await expect(page.getByText('Step 1 of 5: Browser access')).toBeVisible()

      let holdNext = true
      await page.route('**/api/onboarding', async (route) => {
        if (!holdNext) {
          await route.continue()
          return
        }
        holdNext = false
        const response = await route.fetch()
        captured.resolve(response)
        await release.promise
        if (lateResult === 'status') await route.fulfill({ response })
        else await route.fulfill({ status: 503, json: { error: 'Delayed status unavailable' } })
      })
      wire.disconnected = false
      expect(OnboardingStatusSchema.parse(await (await captured.promise).json()).currentStep).toBe(
        'domain',
      )
      await page.getByRole('button', { name: 'Continue' }).click()
      const mock = page.getByLabel(/built-in mock provider/i)
      await expect(mock).toBeVisible()
      const delivered = page.waitForResponse('**/api/onboarding')
      release.resolve()
      await (await delivered).finished()
      await page.evaluate(
        () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
      )
      await expect(page.getByText('Step 2 of 5: Model connection')).toBeVisible()
      await expect(page.getByRole('alert')).toHaveCount(0)
      await mock.click()
      await expect(mock).toBeChecked()
      await page.getByRole('button', { name: 'Continue' }).click()
      await expect(page.getByRole('button', { name: 'Create' })).toBeVisible()
      await page.reload()
      await expect(page.getByRole('button', { name: 'Create' })).toBeVisible()
    } finally {
      release.resolve()
      await stack.stop()
      await cleanupStackDirs(stack)
    }
  })
}
