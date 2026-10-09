import { expect, test } from './surface-contracts-fixture.ts'
import { ActionWire, signal, surfaceCard } from './fast-actions-journey.ts'

for (const width of [320, 1440]) {
  test.describe(`Surface ordering feedback at ${width}px`, () => {
    test.use({ viewport: { width, height: 900 }, isMobile: width === 320, hasTouch: width === 320 })

    test('keeps commands single-flight and refuses offline replay while retaining confirmed content', async ({
      page,
      surfaceStack,
    }, info) => {
      expect(surfaceStack.origin).toBeTruthy()
      const wire = new ActionWire(page, [])
      await wire.install()
      await page.reload()
      const shell = page.locator('.app-shell')
      const main = page.getByRole('main', { name: 'Health Space' })
      await expect(shell).toHaveAttribute('data-gateway-online', 'true')
      const card = surfaceCard(page, 'Weight goal')
      const pin = card.getByRole('button', { name: 'Pin Weight goal', exact: true })
      const titles = () =>
        main
          .getByRole('button', { name: /^Focus / })
          .evaluateAll((buttons) => buttons.map((b) => b.getAttribute('aria-label')))
      const before = await titles()
      const releaseFailure = signal<void>()
      let pinRequests = 0
      await page.route('**/api/surfaces/*/pin', async (route) => {
        pinRequests += 1
        if (pinRequests === 1) {
          await releaseFailure.promise
          await route.fulfill({ status: 409, json: { error: 'Pin rejected by the Gateway' } })
        } else await route.continue()
      })
      await pin.click()
      await expect(card.getByRole('status')).toHaveText('Pin "Weight goal" in progress…')
      await expect(pin).toBeDisabled()
      await expect(card.getByRole('button', { name: 'Move Weight goal up' })).toBeDisabled()
      await expect(main.getByRole('button', { name: 'Pin Groceries', exact: true })).toBeEnabled()
      await pin.evaluate((button) => {
        if (button instanceof HTMLButtonElement) button.click()
      })
      expect(pinRequests).toBe(1)
      expect(await titles()).toEqual(before)
      await expect(pin).toHaveAttribute('aria-pressed', 'false')
      releaseFailure.resolve()
      await expect(card.getByRole('alert')).toContainText('Pin "Weight goal" failed')
      await expect(pin).toBeEnabled()
      expect(await titles()).toEqual(before)

      const queues = () =>
        page.evaluate(() =>
          Object.fromEntries(
            Object.keys(localStorage)
              .filter((key) => /queue|outbox/i.test(key))
              .map((key) => [key, localStorage.getItem(key)]),
          ),
        )
      const beforeQueues = await queues()
      await wire.disconnect()
      await expect(shell).toHaveAttribute('data-gateway-online', 'false')
      await expect(pin).toBeDisabled()
      await expect(surfaceCard(page, 'Groceries').getByRole('status')).toHaveText(
        'Pin and Move are unavailable while offline.',
      )
      await pin.evaluate((button) => {
        if (button instanceof HTMLButtonElement) button.click()
      })
      expect(await queues()).toEqual(beforeQueues)
      wire.disconnected = false
      await expect(shell).toHaveAttribute('data-gateway-online', 'true')
      await expect(pin).toBeEnabled()
      expect(pinRequests).toBe(1)
      await pin.click()
      await expect(
        card.getByRole('button', { name: 'Pinned Weight goal', exact: true }),
      ).toBeEnabled()
      expect(pinRequests).toBe(2)
      await expect(card.getByRole('alert')).toHaveCount(0)
      await page.reload()
      await expect(shell).toHaveAttribute('data-gateway-online', 'true')
      await expect(main.getByRole('heading', { name: 'Pinned (1)' })).toBeVisible()
      expect((await titles())[0]).toBe('Focus Weight goal')

      let moveRequests = 0
      await page.route('**/api/spaces/*/surfaces/*/move', async (route) => {
        moveRequests += 1
        if (moveRequests === 1) await route.abort('failed')
        else await route.continue()
      })
      const move = main.getByRole('button', { name: 'Move Groceries up' })
      const moveBefore = await titles()
      await move.click()
      await expect(surfaceCard(page, 'Groceries').getByRole('alert')).toContainText(
        'Move "Groceries" up failed',
      )
      expect(await titles()).toEqual(moveBefore)
      await move.click()
      await expect.poll(titles).not.toEqual(moveBefore)
      expect(moveRequests).toBe(2)
      await expect(surfaceCard(page, 'Groceries').getByRole('alert')).toHaveCount(0)
      expect(await queues()).toEqual(beforeQueues)
      await page.screenshot({ path: info.outputPath(`surface-order-${width}.png`) })
    })
  })
}
