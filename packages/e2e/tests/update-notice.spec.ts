import { expect, test } from '@playwright/test'
import { startUpdateNoticeStack } from './update-notice-stack.ts'

for (const width of [320, 1440]) {
  test.describe(`software update notice at ${width}px`, () => {
    test.use({ viewport: { width, height: 900 }, hasTouch: width === 320 })
    test('verified offer lifecycle', async ({ page }, info) => {
      const stack = await startUpdateNoticeStack()
      const errors: string[] = []
      page.on('pageerror', (error) => errors.push(error.message))
      const notice = page.getByRole('region', { name: 'Veduta software update' })
      try {
        await page.goto(stack.origin)
        await expect(page.getByRole('main', { name: 'Home', exact: true })).toBeVisible()
        await expect(notice).toHaveCount(0)
        if (width === 320) await stack.discoverAutomatically()
        else {
          await page.goto(`${stack.origin}/app/space/system/surface/srf-update`)
          await page.getByRole('button', { name: 'Check now', exact: true }).click()
        }
        await expect(notice).toContainText('Veduta 1.2.3 is available')
        await page.goto(stack.origin)
        await expect(notice).toBeInViewport({ ratio: 1 })
        await expect(
          page.getByRole('button', { name: '1 decision awaits review' }),
        ).toHaveAttribute('aria-expanded', 'false')
        await page
          .getByRole('main', { name: 'Home', exact: true })
          .getByRole('link', { name: /Health/ })
          .click()
        await expect(page.getByRole('main', { name: 'Health Space', exact: true })).toBeVisible()
        await expect(notice).toBeVisible()
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
        ).toBeLessThanOrEqual(1)
        const review = notice.getByRole('link', { name: 'Review update', exact: true })
        expect((await review.boundingBox())?.height).toBeGreaterThanOrEqual(width === 320 ? 44 : 32)
        await review.focus()
        await expect(review).toBeFocused()
        await page.keyboard.press('Enter')
        await expect(page).toHaveURL(`${stack.origin}/app/space/system/surface/srf-update`)
        await expect(
          page.getByText('Release notes for Veduta 1.2.3: update notice verification.', {
            exact: true,
          }),
        ).toBeVisible()
        await expect(notice).toBeVisible()
        await page.reload()
        await expect(notice).toContainText('Veduta 1.2.3 is available')
        await stack.restart()
        await expect(page.locator('.app-shell')).toHaveAttribute('data-gateway-online', 'true', {
          timeout: 15_000,
        })
        await expect(notice).toContainText('Veduta 1.2.3 is available')
        stack.offer('1.2.4', false)
        await page.getByRole('button', { name: 'Check now', exact: true }).click()
        await expect(page.getByText(/Update check failed:/)).toBeVisible()
        await expect(notice).toContainText('Veduta 1.2.3 is available')
        stack.offer('1.2.4')
        await page.getByRole('button', { name: 'Check now', exact: true }).click()
        await expect(notice).toContainText('Veduta 1.2.4 is available')
        await expect(notice).toHaveCount(1)
        await page.screenshot({ path: info.outputPath(`update-notice-${width}.png`) })
        await stack.restart('1.2.4')
        await expect(notice).toHaveCount(0, { timeout: 15_000 })
        expect(errors).toEqual([])
      } finally {
        await stack.stop()
      }
    })
  })
}
