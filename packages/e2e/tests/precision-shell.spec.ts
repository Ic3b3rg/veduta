import { expect, test } from './surface-contracts-fixture.ts'
import { join } from 'node:path'
import { Store } from '../../daemon/src/store.ts'
import { referenceModels } from '../../pwa/src/product-reference-data.ts'
import { createActionControlSurface } from './action-control-surface.ts'
import { ActionWire } from './fast-actions-journey.ts'

const longName = 'Household maintenance, shared plans and everything we need to remember together'

for (const width of [320, 900, 1024, 1440]) {
  test.describe(`Precision Tool shell at ${width}px`, () => {
    test.use({
      viewport: { width, height: 900 },
      isMobile: width === 320,
      hasTouch: width !== 1440,
      colorScheme: 'light',
      contextOptions: { reducedMotion: 'reduce' },
    })

    test('keeps route-derived navigation compact, accessible and stable through reload and reconnect', async ({
      page,
      surfaceStack,
    }, info) => {
      expect(surfaceStack.origin).toBeTruthy()
      createActionControlSurface(surfaceStack.baseDir)
      const store = new Store({ rootDir: join(surfaceStack.baseDir, 'data') })
      try {
        store.spacesEngine.createSpace({ name: longName })
      } finally {
        store.close()
      }
      // Deterministic selector presentation; this journey never invokes an external model.
      await page.route('**/api/model-connections', (route) =>
        route.fulfill({ json: referenceModels }),
      )
      const wire = new ActionWire(page, [])
      await wire.install()
      await page.reload()
      expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(
        width !== 1440,
      )
      const shell = page.locator('.app-shell')
      const composer = page.getByRole('textbox', { name: 'Message Veduta in Health' })
      const selector = page.getByRole('combobox', { name: 'Change Space' })
      const navigation = page.getByRole('complementary', { name: 'Spaces' })
      const assertFits = async () => {
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
          ),
        ).toBeLessThanOrEqual(1)
      }
      await expect(shell).toHaveAttribute('data-gateway-online', 'true')
      await expect(shell).toHaveCSS('color-scheme', 'dark')
      await expect(page.getByRole('heading', { name: 'Veduta', exact: true })).toBeVisible()
      await expect(page.locator('.topbar')).toHaveCSS('backdrop-filter', 'none')
      await assertFits()
      for (const name of ['Connection', 'Model']) {
        const control = page.getByRole('combobox', { name, exact: true })
        await expect(control).toBeVisible()
        if (width !== 1440) {
          const target = await control.boundingBox()
          expect(target?.height).toBeGreaterThanOrEqual(44)
          expect(target?.width).toBeGreaterThanOrEqual(44)
        }
      }

      if (width === 320) {
        await expect(selector).toHaveValue('spc-health')
        await expect(navigation.getByRole('button')).toHaveCount(0)
        await expect(composer).not.toBeFocused()
        const target = await selector.boundingBox()
        expect(target?.height).toBeGreaterThanOrEqual(44)
        expect(target?.width).toBeGreaterThanOrEqual(44)
        await selector.selectOption('')
      } else {
        await expect(selector).toBeHidden()
        await expect(navigation.getByRole('button', { name: /^Health/ })).toHaveAttribute(
          'aria-pressed',
          'true',
        )
        const rows = await navigation.getByRole('button').evaluateAll((buttons) =>
          buttons.map((button) => {
            const rect = button.getBoundingClientRect()
            return {
              top: rect.top,
              bottom: rect.bottom,
              scrollHeight: button.scrollHeight,
              clientHeight: button.clientHeight,
            }
          }),
        )
        expect(rows.length).toBeGreaterThanOrEqual(4)
        rows.forEach((row, index) => {
          expect(row.scrollHeight).toBeLessThanOrEqual(row.clientHeight + 1)
          const previous = rows[index - 1]
          if (previous) expect(row.top).toBeGreaterThanOrEqual(previous.bottom)
        })
        await page.getByRole('link', { name: 'Home', exact: true }).click()
      }

      const home = page.getByRole('main', { name: 'Home', exact: true })
      await expect(home).toBeVisible()
      await expect(home.getByRole('region', { name: 'Your Spaces' })).toBeVisible()
      const health = home.getByRole('link', { name: /Health/ })
      await expect(health).toHaveCSS('backdrop-filter', 'none')
      await expect(health).toHaveCSS('box-shadow', 'none')
      const system = home.getByRole('region', { name: 'System' }).getByRole('link')
      await expect(system).toHaveCSS('box-shadow', 'none')
      expect(await system.evaluate((element) => getComputedStyle(element).backgroundColor)).toBe(
        await health.evaluate((element) => getComputedStyle(element).backgroundColor),
      )
      await assertFits()
      for (const name of ['Model connections', 'Connections']) {
        const utility = page.getByRole('button', { name, exact: true })
        await utility.focus()
        await expect(utility).toBeFocused()
        if (width === 320) {
          const target = await utility.boundingBox()
          expect(target?.width).toBeGreaterThanOrEqual(44)
          expect(target?.height).toBeGreaterThanOrEqual(44)
        }
      }
      expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(
        width !== 1440,
      )
      if (width === 320) await health.tap()
      else await health.click()
      await expect(page).toHaveURL(/\/app\/space\/health$/)
      if (width === 320) await expect(composer).not.toBeFocused()
      const focus = page.getByRole('button', { name: 'Focus Weight goal', exact: true })
      if (width === 320) await focus.tap()
      else await focus.click()
      await expect(page).toHaveURL(/\/surface\/srf-goal$/)
      await expect(
        page.getByRole('button', { name: 'Focus Weight goal', exact: true }),
      ).toHaveAttribute('aria-pressed', 'true')
      if (width === 320) await expect(selector).toHaveValue('spc-health')
      await page.reload()
      await expect(shell).toHaveAttribute('data-gateway-online', 'true')
      await expect(page).toHaveURL(/\/surface\/srf-goal$/)
      await expect(page.getByRole('main', { name: 'Health Space' })).toBeVisible()
      await assertFits()

      const city = page.getByRole('combobox', { name: 'City', exact: true })
      await city.focus()
      await city.press('ArrowDown')
      const popup = page.locator('[data-slot="combobox-content"]')
      await expect(popup).toBeVisible()
      await expect(popup).toHaveCSS('color-scheme', 'dark')
      await city.press('Escape')
      await expect(popup).toHaveCount(0)

      await wire.disconnect()
      await expect(shell).toHaveAttribute('data-gateway-online', 'false')
      await expect(page.getByRole('main', { name: 'Health Space' })).toBeVisible()
      wire.disconnected = false
      await expect(shell).toHaveAttribute('data-gateway-online', 'true')
      await expect(page).toHaveURL(/\/surface\/srf-goal$/)
      await page.screenshot({ path: info.outputPath(`shell-space-${width}.png`), fullPage: true })
      await page.goto(surfaceStack.origin)
      await expect(home).toBeVisible()
      await page.screenshot({ path: info.outputPath(`shell-home-${width}.png`), fullPage: true })
    })
  })
}
