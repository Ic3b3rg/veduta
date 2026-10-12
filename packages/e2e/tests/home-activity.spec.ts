import { expect, test } from './surface-contracts-fixture.ts'
import { ActionWire } from './fast-actions-journey.ts'

for (const width of [320, 1440]) {
  test.describe(`Home Surface activity at ${width}px`, () => {
    test.use({
      viewport: { width, height: 900 },
      isMobile: width === 320,
      hasTouch: width === 320,
      contextOptions: { reducedMotion: 'reduce' },
    })

    test('acknowledges a Space locally and restores its dot after live Pin, reload and reconnect', async ({
      page,
      surfaceStack,
    }, info) => {
      const shell = page.locator('.app-shell')
      const wire = new ActionWire(page, [])
      await wire.install()
      await page.getByRole('link', { name: 'Home', exact: true }).click()
      await page.evaluate(() => localStorage.removeItem('veduta.homeActivityLastSeen'))
      await page.reload()
      const home = page.getByRole('main', { name: 'Home' })
      const health = home.getByRole('link', { name: /Health/ })
      await expect(shell).toHaveAttribute('data-gateway-online', 'true')
      await expect(health.getByText('New activity')).toBeVisible()
      await health.click()
      const focused = page.getByRole('main', { name: 'Health Space' })
      await expect(focused).toBeVisible()
      await page.getByRole('link', { name: 'Home', exact: true }).click()
      await expect(health.getByText('New activity')).toHaveCount(0)
      await page.reload()
      await expect(shell).toHaveAttribute('data-gateway-online', 'true')
      await expect(health.getByText('New activity')).toHaveCount(0)

      await health.click()
      await focused.getByRole('button', { name: 'Pin Weight goal', exact: true }).click()
      await expect(
        focused.getByRole('button', { name: 'Pinned Weight goal', exact: true }),
      ).toHaveAttribute('aria-pressed', 'true')
      await page.getByRole('link', { name: 'Home', exact: true }).click()
      await expect(health.getByText('New activity')).toBeVisible()
      await expect(health.getByText('Attention', { exact: true })).toBeVisible()
      await wire.disconnect()
      await expect(shell).toHaveAttribute('data-gateway-online', 'false')
      await expect(health.getByText('New activity')).toBeVisible()
      wire.disconnected = false
      await expect(shell).toHaveAttribute('data-gateway-online', 'true')
      await expect(health.getByText('New activity')).toBeVisible()
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        ),
      ).toBeLessThanOrEqual(1)
      await page.screenshot({ path: info.outputPath(`home-activity-${width}.png`) })

      await health.click()
      await page.getByRole('link', { name: 'Home', exact: true }).click()
      await expect(health.getByText('New activity')).toHaveCount(0)
      expect(surfaceStack.origin).toBeTruthy()
    })
  })
}
