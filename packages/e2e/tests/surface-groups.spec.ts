import { expect, test } from './surface-contracts-fixture.ts'
import { ActionWire, surfaceCard } from './fast-actions-journey.ts'

for (const width of [320, 1440]) {
  test.describe(`Surface groups at ${width}px`, () => {
    test.use({
      viewport: { width, height: 900 },
      isMobile: width === 320,
      hasTouch: width === 320,
      contextOptions: { reducedMotion: 'reduce' },
    })

    test('follows confirmed groups and group-local Move boundaries across reload and reconnect', async ({
      page,
      surfaceStack,
    }, info) => {
      expect(surfaceStack.origin).toBeTruthy()
      const wire = new ActionWire(page, [])
      await wire.install()
      await page.reload()
      const main = page.getByRole('main', { name: 'Health Space' })
      const shell = page.locator('.app-shell')
      await expect(shell).toHaveAttribute('data-gateway-online', 'true')
      await expect(main.getByRole('heading', { name: /^Pinned \(/ })).toHaveCount(0)
      await expect(main.getByRole('heading', { name: 'Surfaces (6)' })).toBeVisible()
      await expect(
        surfaceCard(page, 'Nightly Reflection').getByRole('button', { name: /^Pin/ }),
      ).toHaveCount(0)

      for (const title of ['Weight goal', 'Groceries']) {
        await main.getByRole('button', { name: `Pin ${title}`, exact: true }).click()
        await expect(
          main.getByRole('button', { name: `Pinned ${title}`, exact: true }),
        ).toHaveAttribute('aria-pressed', 'true')
      }
      await expect(main.getByRole('heading', { name: 'Pinned (2)' })).toBeVisible()
      await expect(main.getByRole('heading', { name: 'Surfaces (4)' })).toBeVisible()
      const titles = () =>
        main
          .getByRole('button', { name: /^Focus / })
          .evaluateAll((buttons) => buttons.map((b) => b.getAttribute('aria-label')))
      expect((await titles()).slice(0, 2)).toEqual(['Focus Groceries', 'Focus Weight goal'])
      await expect(main.getByRole('button', { name: 'Move Groceries up' })).toBeDisabled()
      await expect(main.getByRole('button', { name: 'Move Weight goal down' })).toBeDisabled()
      await main.getByRole('button', { name: 'Move Groceries down' }).click()
      await expect
        .poll(async () => (await titles()).slice(0, 2))
        .toEqual(['Focus Weight goal', 'Focus Groceries'])
      await expect(main.getByRole('button', { name: 'Move Weight goal up' })).toBeDisabled()
      await expect(main.getByRole('button', { name: 'Move Groceries down' })).toBeDisabled()
      const firstRegular = (await titles())[2]?.replace('Focus ', '')
      expect(firstRegular).toBeTruthy()
      await expect(main.getByRole('button', { name: `Move ${firstRegular} up` })).toBeDisabled()

      for (const title of ['Groceries', 'Weight goal']) {
        await main.getByRole('button', { name: `Pinned ${title}`, exact: true }).click()
        await expect(
          main.getByRole('button', { name: `Pin ${title}`, exact: true }),
        ).toHaveAttribute('aria-pressed', 'false')
      }
      await expect(main.getByRole('heading', { name: /^Pinned \(/ })).toHaveCount(0)
      await expect(main.getByRole('heading', { name: 'Surfaces (6)' })).toBeVisible()
      for (const title of ['Groceries', 'Weight goal']) {
        await main.getByRole('button', { name: `Pin ${title}`, exact: true }).click()
        await expect(
          main.getByRole('button', { name: `Pinned ${title}`, exact: true }),
        ).toBeVisible()
      }
      await page.reload()
      await expect(shell).toHaveAttribute('data-gateway-online', 'true')
      await expect(main.getByRole('heading', { name: 'Pinned (2)' })).toBeVisible()
      expect((await titles()).slice(0, 2)).toEqual(['Focus Weight goal', 'Focus Groceries'])
      await wire.disconnect()
      await expect(shell).toHaveAttribute('data-gateway-online', 'false')
      await expect(main.getByRole('heading', { name: 'Pinned (2)' })).toBeVisible()
      wire.disconnected = false
      await expect(shell).toHaveAttribute('data-gateway-online', 'true')
      expect((await titles()).slice(0, 2)).toEqual(['Focus Weight goal', 'Focus Groceries'])
      await main.getByRole('heading', { name: 'Pinned (2)' }).scrollIntoViewIfNeeded()
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        ),
      ).toBeLessThanOrEqual(1)
      await page.screenshot({ path: info.outputPath(`surface-groups-${width}.png`) })
    })
  })
}
