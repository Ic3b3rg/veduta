import { expect, test, type Locator } from '@playwright/test'
import { JsonObjectSchema } from '../../protocol/src/index.ts'
import { closeChat, openChat } from './chat-journey.ts'
import { readEvents, readSurface, surfaceCard } from './fast-actions-journey.ts'
import {
  BEFORE_BOUNDARY,
  SPENDING_ID,
  openHealth,
  prepareRelativeFixtures,
  relativeTimeStack,
} from './relative-time-acceptance-fixture.ts'

function relativeTimeStatus(card: Locator): Locator {
  return card.getByRole('status').filter({ hasText: 'relative-time view' })
}

for (const width of [320, 1440]) {
  test(`two relative-time domains retain history and expire without a mutation at ${width}px`, async ({
    browser,
  }, info) => {
    const stack = await relativeTimeStack(browser, width)
    const { page, origin } = stack
    try {
      await prepareRelativeFixtures(stack)
      await stack.start()
      expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe('UTC')
      await openHealth(page, origin)
      const meals = surfaceCard(page, 'Meals')
      const spending = surfaceCard(page, 'Daily spending')
      await expect(meals).toContainText('Current lunch')
      await expect(spending).toContainText('Bookshop')
      for (const card of [meals, spending]) {
        await expect(card.getByRole('note')).toContainText('1 source record has no occurrence date')
        await expect(relativeTimeStatus(card)).toHaveCount(0)
      }
      await expect(meals.getByRole('cell', { name: 'Old lunch', exact: true })).toHaveCount(0)
      await expect(meals.getByRole('cell', { name: 'Undated breakfast', exact: true })).toHaveCount(
        0,
      )
      await expect(spending.getByRole('cell', { name: 'Old shop', exact: true })).toHaveCount(0)
      const before = await readSurface(page, origin, 'srf-meals')
      await meals.getByRole('button', { name: 'Pin Meals', exact: true }).click()
      await expect(
        meals.getByRole('button', { name: 'Pinned Meals', exact: true }),
      ).toHaveAttribute('aria-pressed', 'true')
      await openChat(page)
      await page
        .getByRole('textbox', { name: 'Message Veduta in Health', exact: true })
        .fill('aggiungi ai meals la fesa di tacchino')
      await page.getByRole('button', { name: 'Send message', exact: true }).click()
      await expect(page.locator('.chat-entry.assistant').last()).toContainText(
        'Saved Surface “Meals”',
      )
      await closeChat(page)
      await expect(meals.getByRole('cell', { name: 'fesa di tacchino', exact: true })).toBeVisible()
      const logged = await readSurface(page, origin, 'srf-meals')
      expect(logged.pinned).toBe(true)
      expect(logged.tree).toEqual(before.tree)
      expect(logged.state['mealCount']).toBe(2)
      expect(logged.state['lastMeal']).toBe('fesa di tacchino')
      expect(logged.state['meals']).toEqual([
        { occurredAt: BEFORE_BOUNDARY, time: '23:59', meal: 'fesa di tacchino' },
        { occurredAt: '2026-03-29T10:00:00.000Z', time: '12:00', meal: 'Current lunch' },
      ])
      expect(logged.state['mealRecords']).toEqual([
        { occurredAt: BEFORE_BOUNDARY, time: '23:59', meal: 'fesa di tacchino' },
        { occurredAt: '2026-03-29T10:00:00.000Z', time: '12:00', meal: 'Current lunch' },
        { occurredAt: '2026-03-28T11:00:00.000Z', time: '12:00', meal: 'Old lunch' },
        { time: '08:00', meal: 'Undated breakfast' },
      ])
      const expense = await readSurface(page, origin, SPENDING_ID)
      expect(expense.state).toMatchObject({
        todayCount: 1,
        todayTotal: 18,
        latestMerchant: 'Bookshop',
        todayRows: [{ merchant: 'Bookshop', amount: 18 }],
      })
      for (const surface of [logged, expense]) {
        expect(surface.validity).toMatchObject({
          timeZone: 'Europe/Rome',
          startsAt: '2026-03-28T23:00:00.000Z',
          expiresAt: '2026-03-29T22:00:00.000Z',
        })
      }
      const eventsBeforeExpiry = await readEvents(page, origin)
      const patch = eventsBeforeExpiry
        .filter(
          (event) =>
            event.type === 'surface.patch_state' && event.payload?.['surfaceId'] === 'srf-meals',
        )
        .at(-1)
      expect(patch).toMatchObject({ at: BEFORE_BOUNDARY, origin: 'trusted:system' })
      await stack.crossBoundary()
      for (const card of [meals, spending])
        await expect(relativeTimeStatus(card)).toContainText('expired')
      expect(await readSurface(page, origin, 'srf-meals')).toEqual(logged)
      expect(await readSurface(page, origin, SPENDING_ID)).toEqual(expense)
      for (const surfaceId of ['srf-meals', SPENDING_ID]) {
        const read = await stack.invoke('read_surface', { surfaceId })
        expect(JsonObjectSchema.parse(JSON.parse(read.content))['relativeTime']).toMatchObject({
          status: 'expired',
          undatedRecords: 1,
          caveat:
            '1 source record has no occurrence date and is excluded from this relative-time view.',
        })
      }
      expect(await readEvents(page, origin)).toEqual(eventsBeforeExpiry)
      await page.reload()
      for (const card of [meals, spending])
        await expect(relativeTimeStatus(card)).toContainText('expired')
      await stack.restart()
      for (const card of [meals, spending]) {
        await expect(relativeTimeStatus(card)).toContainText('expired')
        await expect(card.getByRole('note')).toContainText('no occurrence date')
      }
      expect(await readSurface(page, origin, 'srf-meals')).toEqual(logged)
      expect(await readSurface(page, origin, SPENDING_ID)).toEqual(expense)
      await stack.invoke('patch_state', {
        surfaceId: SPENDING_ID,
        operations: [
          { target: 'state', op: 'replace', path: '/todayRows', value: [] },
          { target: 'state', op: 'replace', path: '/todayCount', value: 0 },
          { target: 'state', op: 'replace', path: '/todayTotal', value: 0 },
          { target: 'state', op: 'replace', path: '/latestMerchant', value: 'Nothing today' },
        ],
      })
      await expect(relativeTimeStatus(spending)).toHaveCount(0)
      await expect(spending).toContainText('Nothing today')
      await expect(spending.getByRole('cell', { name: 'Bookshop', exact: true })).toHaveCount(0)
      const refreshed = await readSurface(page, origin, SPENDING_ID)
      expect(refreshed.state['spendingRecords']).toEqual(expense.state['spendingRecords'])
      expect(refreshed.state).toMatchObject({
        todayRows: [],
        todayCount: 0,
        todayTotal: 0,
        latestMerchant: 'Nothing today',
      })
      expect(refreshed.validity).toMatchObject({
        startsAt: '2026-03-29T22:00:00.000Z',
        expiresAt: '2026-03-30T22:00:00.000Z',
      })
      await openChat(page)
      await expect(page.locator('.chat-entry.assistant').last()).toContainText(
        'Saved Surface “Meals”',
      )
      await closeChat(page)
      await page.getByRole('link', { name: 'Home', exact: true }).click()
      await expect(
        page.getByRole('main', { name: 'Home' }).getByRole('link', { name: /Health/ }),
      ).toContainText('4 Surfaces')
      await openHealth(page, origin)
      await stack.disconnect()
      await expect(
        meals
          .getByRole('status')
          .filter({ hasText: 'Pin and Move are unavailable while offline.' }),
      ).toBeVisible()
      await expect(relativeTimeStatus(meals)).toContainText('expired')
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        ),
      ).toBeLessThanOrEqual(1)
      await page.screenshot({ path: info.outputPath(`relative-time-${width}.png`) })
      await stack.restart()
      // Durable Chat must retain the same legacy-data caveat as the Surface.
      await openChat(page)
      await expect(page.locator('.chat-entry.assistant').last()).toContainText('no occurrence date')
    } finally {
      await stack.stop()
    }
  })
}
