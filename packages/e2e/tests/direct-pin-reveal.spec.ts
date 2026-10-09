import { expect, test } from './surface-contracts-fixture.ts'
import { GatewayServerMessageSchema, MoveSurfaceResultSchema } from '../../protocol/src/index.ts'
import {
  ActionWire,
  authenticatedHeaders,
  pairActionObserver,
  readSurfaceSnapshot,
  signal,
  surfaceCard,
} from './fast-actions-journey.ts'

declare global {
  interface Window {
    pinScrolls: ScrollIntoViewOptions[]
  }
}

test('failed and already-applied Pin remain quiet before a delayed remote event', async ({
  page,
  surfaceStack,
}) => {
  const held: (() => void)[] = []
  await page.routeWebSocket('**/ws/gateway', (socket) => {
    const server = socket.connectToServer()
    server.onMessage((message) => {
      const frame = GatewayServerMessageSchema.parse(JSON.parse(message.toString()))
      if (frame.type === 'surface.pinned') held.push(() => socket.send(message))
      else socket.send(message)
    })
  })
  await page.reload()
  await expect(page.locator('.app-shell')).toHaveAttribute('data-gateway-online', 'true')
  await page.evaluate(() => {
    window.pinScrolls = []
    const scroll = Element.prototype.scrollIntoView
    Element.prototype.scrollIntoView = function (options) {
      if (typeof options === 'object') window.pinScrolls.push(options)
      scroll.call(this, options)
    }
  })
  const card = surfaceCard(page, 'Weight goal')
  const pin = card.getByRole('button', { name: 'Pin Weight goal', exact: true })
  await page.route('**/api/surfaces/*/pin', (route) =>
    route.fulfill({ status: 409, json: { error: 'Pin refused' } }),
  )
  await pin.click()
  await expect(card.getByRole('alert')).toContainText('Pin refused')
  await expect(pin).toBeFocused()
  await expect(card).not.toHaveClass(/surface-reveal-highlight/)
  expect(await page.evaluate(() => window.pinScrolls)).toEqual([])
  await page.unroute('**/api/surfaces/*/pin')
  const snapshot = await readSurfaceSnapshot(page, surfaceStack.origin)
  const goal = snapshot.spaces
    .flatMap((space) => space.surfaces)
    .find((surface) => surface.title === 'Weight goal')
  if (!goal) throw new Error('Weight goal is missing')
  const response = await page.request.post(`${surfaceStack.origin}/api/surfaces/${goal.id}/pin`, {
    headers: await authenticatedHeaders(page),
    data: { pinned: true },
  })
  expect(response.ok()).toBe(true)
  await expect(pin).toHaveAttribute('aria-pressed', 'false')
  const reply = page.waitForResponse((response) => response.url().endsWith(`/${goal.id}/pin`))
  await pin.click()
  expect(await (await reply).json()).toMatchObject({ changed: false })
  await expect(card.getByRole('button', { name: 'Pinned Weight goal', exact: true })).toBeFocused()
  await expect(card).not.toHaveClass(/surface-reveal-highlight/)
  held.splice(0).forEach((send) => send())
  expect(await page.evaluate(() => window.pinScrolls)).toEqual([])
  await expect(card).not.toHaveClass(/surface-reveal-highlight/)
})

for (const reduced of [false, true]) {
  test.describe(`Direct Pin feedback with reduced motion ${reduced}`, () => {
    test.use({
      viewport: { width: reduced ? 320 : 1440, height: 600 },
    })

    test('reveals only local effective Pin and preserves route and keyboard focus', async ({
      page,
      browser,
      surfaceStack,
    }, info) => {
      const wire = new ActionWire(page, [])
      await wire.install()
      await page.reload()
      await expect(page.locator('.app-shell')).toHaveAttribute('data-gateway-online', 'true')
      const initial = await readSurfaceSnapshot(page, surfaceStack.origin)
      const health = initial.spaces.find((space) => space.slug === 'health')
      const regular = health?.surfaces.filter((surface) => !surface.pinned) ?? []
      const goalIndex = regular.findIndex((surface) => surface.title === 'Weight goal')
      const goal = regular[goalIndex]
      if (!goal || !health) throw new Error('Weight goal is missing')
      for (let index = goalIndex; index < regular.length - 1; index += 1) {
        const moved = await page.request.post(
          `${surfaceStack.origin}/api/spaces/${health.id}/surfaces/${goal.id}/move`,
          {
            headers: await authenticatedHeaders(page),
            data: { direction: 'down' },
          },
        )
        expect(moved.ok()).toBe(true)
        if (
          MoveSurfaceResultSchema.parse(await moved.json()).order.regularSurfaceIds.at(-1) ===
          goal.id
        )
          break
      }
      const observer = await pairActionObserver(browser, page, surfaceStack.origin)
      try {
        await observer.page.goto(`${surfaceStack.origin}/app/space/health`)
        await expect(observer.page.locator('.app-shell')).toHaveAttribute(
          'data-gateway-online',
          'true',
        )
        for (const target of [page, observer.page]) {
          await target.evaluate(() => {
            window.pinScrolls = []
            const scroll = Element.prototype.scrollIntoView
            Element.prototype.scrollIntoView = function (options) {
              if (typeof options === 'object') window.pinScrolls.push(options)
              scroll.call(this, options)
            }
          })
        }
        await page.emulateMedia({ reducedMotion: reduced ? 'reduce' : 'no-preference' })
        expect(
          await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches),
        ).toBe(reduced)
        const card = surfaceCard(page, 'Weight goal')
        const pin = card.getByRole('button', { name: 'Pin Weight goal', exact: true })
        const main = page.getByRole('main', { name: 'Health Space' })
        const observerMain = observer.page.getByRole('main', { name: 'Health Space' })
        await main.evaluate((element) => {
          element.scrollTop = 0
        })
        const beforeBox = await card.boundingBox()
        const mainBox = await main.boundingBox()
        if (!beforeBox || !mainBox) throw new Error('Surface or Space geometry is missing')
        expect(beforeBox.y).toBeGreaterThanOrEqual(mainBox.y + mainBox.height)
        const observerScroll = await observerMain.evaluate((element) => element.scrollTop)
        const observerChat = observer.page.getByRole('textbox', {
          name: 'Message Veduta in Health',
        })
        await observerChat.focus()
        const originalUrl = page.url()
        const release = signal<void>()
        await page.route('**/api/surfaces/*/pin', async (route) => {
          await release.promise
          await route.continue()
        })
        await pin.focus()
        await pin.press('Space')
        await expect(card.getByRole('status')).toContainText('in progress')
        await expect(pin).toBeFocused()
        await expect(card).not.toHaveClass(/surface-reveal-highlight/)
        expect(await page.evaluate(() => window.pinScrolls)).toEqual([])
        release.resolve()
        await expect(card).toHaveClass(/surface-reveal-highlight/)
        // The first pinned card can be centred only as far as the scroll region's start permits.
        await expect
          .poll(() =>
            card.evaluate((element) => {
              const main = element.closest('main')
              if (!main) throw new Error('Missing Space scroll region')
              const cardRect = element.getBoundingClientRect()
              const mainRect = main.getBoundingClientRect()
              const offset = cardRect.top - mainRect.top + main.scrollTop
              const centre = offset - (main.clientHeight - cardRect.height) / 2
              const expected = Math.min(Math.max(centre, 0), main.scrollHeight - main.clientHeight)
              return Math.abs(main.scrollTop - expected)
            }),
          )
          .toBeLessThan(2)
        await expect(card).toBeInViewport()
        const pinned = card.getByRole('button', { name: 'Pinned Weight goal', exact: true })
        await expect(pinned).toBeFocused()
        expect(page.url()).toBe(originalUrl)
        await expect(card).not.toHaveClass(/selected/)
        expect(await page.evaluate(() => window.pinScrolls)).toEqual([
          { behavior: reduced ? 'auto' : 'smooth', block: 'center' },
        ])
        await expect(surfaceCard(observer.page, 'Weight goal')).toHaveClass(/pinned/)
        await expect(surfaceCard(observer.page, 'Weight goal')).not.toHaveClass(
          /surface-reveal-highlight/,
        )
        expect(await observer.page.evaluate(() => window.pinScrolls)).toEqual([])
        expect(await observerMain.evaluate((element) => element.scrollTop)).toBe(observerScroll)
        await expect(observerChat).toBeFocused()
        if (reduced)
          expect(await card.evaluate((element) => getComputedStyle(element).animationName)).toBe(
            'none',
          )
        await page.screenshot({ path: info.outputPath(`direct-pin-${reduced ? 320 : 1440}.png`) })
        await expect(card).not.toHaveClass(/surface-reveal-highlight/)
        await page.unroute('**/api/surfaces/*/pin')
        await pinned.click()
        await expect(pin).toHaveAttribute('aria-pressed', 'false')
        await expect(card).not.toHaveClass(/surface-reveal-highlight/)
        expect(await page.evaluate(() => window.pinScrolls)).toHaveLength(1)

        // The other authenticated device changes the same Surface while this tab is disconnected.
        await wire.disconnect()
        const snapshot = await readSurfaceSnapshot(observer.page, surfaceStack.origin)
        const goal = snapshot.spaces
          .flatMap((space) => space.surfaces)
          .find((surface) => surface.title === 'Weight goal')
        if (!goal) throw new Error('Weight goal is missing')
        const response = await observer.page.request.post(
          `${surfaceStack.origin}/api/surfaces/${goal.id}/pin`,
          {
            headers: await authenticatedHeaders(observer.page),
            data: { pinned: true },
          },
        )
        expect(response.ok()).toBe(true)
        wire.disconnected = false
        await expect(page.locator('.app-shell')).toHaveAttribute('data-gateway-online', 'true')
        await expect(pinned).toHaveAttribute('aria-pressed', 'true')
        await expect(card).not.toHaveClass(/surface-reveal-highlight/)
        expect(await page.evaluate(() => window.pinScrolls)).toHaveLength(1)
        await page.reload()
        await expect(pinned).toHaveAttribute('aria-pressed', 'true')
        await expect(card).not.toHaveClass(/surface-reveal-highlight/)
      } finally {
        await observer.context.close()
      }
    })
  })
}
