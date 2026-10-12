import { expect, test } from './surface-contracts-fixture.ts'
import { referenceModels } from '../../pwa/src/product-reference-data.ts'

for (const width of [320, 1280]) {
  test.describe(`Notification navigation at ${width}px`, () => {
    test.use({ viewport: { width, height: 900 }, hasTouch: width === 320 })

    test('keeps blocked notification feedback stable and reaches Models through Settings', async ({
      page,
      context,
      surfaceStack,
    }, info) => {
      const errors: string[] = []
      page.on('pageerror', (error) => errors.push(error.message))
      await page.route('**/api/model-connections', (route) =>
        route.fulfill({
          json: {
            ...referenceModels,
            connections: referenceModels.connections.map((connection) => ({
              ...connection,
              catalog: [
                ...(connection.catalog ?? []),
                { id: 'other-model', label: 'Other model', routable: true },
              ],
            })),
          },
        }),
      )
      await page.route('**/api/model-connections/selection', (route) =>
        route.fulfill({
          status: 400,
          json: { error: 'The provider rejected the selected model.' },
        }),
      )
      const cdp = await context.newCDPSession(page)
      const { targetInfo } = await cdp.send('Target.getTargetInfo')
      if (!targetInfo.browserContextId) throw new Error('An isolated browser context is required')
      const bell = page.getByRole('button', { name: 'Enable notifications', exact: true })
      await expect(bell).toBeVisible()
      await cdp.send('Browser.setPermission', {
        permission: { name: 'notifications' },
        setting: 'denied',
        origin: surfaceStack.origin,
        browserContextId: targetInfo.browserContextId,
      })
      expect(await page.evaluate(() => Notification.permission)).toBe('denied')
      const before = await page.locator('.topbar').boundingBox()
      const controlsBefore = await page
        .locator('.topbar button')
        .evaluateAll((buttons) => buttons.map((button) => button.getBoundingClientRect().toJSON()))
      const gear = page.getByRole('button', { name: 'Settings', exact: true })
      await expect(gear).toBeVisible()
      await expect(
        page.getByRole('button', { name: /^(Choose model|Model connections|Connections)$/ }),
      ).toHaveCount(0)
      await bell.click()
      await expect(
        page.getByText('Notifications are blocked in the browser settings.'),
      ).toBeVisible()
      expect(await page.locator('.topbar').boundingBox()).toEqual(before)
      expect(
        await page
          .locator('.topbar button')
          .evaluateAll((buttons) =>
            buttons.map((button) => button.getBoundingClientRect().toJSON()),
          ),
      ).toEqual(controlsBefore)
      const notice = page.getByRole('dialog', { name: 'Notifications', exact: true })
      await expect(notice).toBeInViewport({ ratio: 1 })
      for (const button of await notice.getByRole('button').all()) {
        const target = await button.boundingBox()
        expect(target?.height).toBeGreaterThanOrEqual(width === 320 ? 44 : 32)
        expect(target?.width).toBeGreaterThanOrEqual(width === 320 ? 44 : 32)
      }
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
      ).toBeLessThanOrEqual(1)
      await page.screenshot({ path: info.outputPath(`notifications-denied-${width}.png`) })
      await notice.getByRole('button', { name: 'Dismiss notification notice' }).click()
      await expect(notice).toHaveCount(0)
      await expect(bell).toBeFocused()
      await bell.click()
      await expect(notice).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(notice).toHaveCount(0)
      await expect(bell).toBeFocused()
      await page.reload()
      await bell.click()
      await expect(notice).toContainText('Notifications are blocked in the browser settings.')
      await page.getByRole('heading', { name: 'Veduta', exact: true }).click()
      await expect(notice).toHaveCount(0)
      await gear.click()
      await page.getByRole('link', { name: 'Models', exact: true }).click()
      const model = page.getByRole('combobox', { name: 'Model', exact: true })
      await expect(model).toHaveValue('reference-model')
      await expect(page.getByRole('combobox', { name: 'Connection', exact: true })).toHaveValue(
        referenceModels.selection!.connectionId,
      )
      await model.selectOption('other-model')
      await page.getByRole('button', { name: 'Use this model', exact: true }).click()
      await expect(page.getByRole('alert')).toContainText(
        'The provider rejected the selected model.',
      )
      await expect(model).toHaveValue('reference-model')
      await page.reload()
      await expect(model).toHaveValue('reference-model')
      await page.getByRole('link', { name: 'Accounts & services', exact: true }).click()
      await expect(
        page.getByRole('heading', { name: 'Accounts & services', exact: true }),
      ).toBeVisible()
      await page.goBack()
      await expect(model).toHaveValue('reference-model')
      await page.getByRole('link', { name: 'Back to Veduta', exact: true }).click()
      await expect(gear).toBeVisible()
      expect(errors).toEqual([])
    })
  })
}
