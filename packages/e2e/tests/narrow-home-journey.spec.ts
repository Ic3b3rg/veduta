import type { Locator } from '@playwright/test'
import { join } from 'node:path'
import { PushStore } from '../../daemon/src/push-store.ts'
import { openChat, closeChat } from './chat-journey.ts'
import { ActionWire, surfaceCard } from './fast-actions-journey.ts'
import { expect, test } from './surface-contracts-fixture.ts'

for (const width of [320, 1440]) {
  test.describe(`Complete Home and Space journey at ${width}px`, () => {
    test.use({
      viewport: { width, height: 900 },
      isMobile: width === 320,
      hasTouch: width === 320,
      contextOptions: { reducedMotion: 'reduce' },
    })

    test('keeps decisions, attention and activity distinct through keyboard navigation, history and reconnect', async ({
      page,
      surfaceStack,
    }, info) => {
      const errors: string[] = []
      page.on('pageerror', (error) => errors.push(error.message))
      const wire = new ActionWire(page, [])
      await wire.install()
      await page.reload()
      const shell = page.locator('.app-shell')
      const space = page.getByRole('main', { name: 'Health Space' })
      const home = page.getByRole('main', { name: 'Home', exact: true })
      const health = home.getByRole('link', { name: /Health/ })
      const homeLink = page.getByRole('link', { name: 'Home', exact: true })
      const summary = home.getByRole('region', { name: 'Pending decisions', exact: true })
      const assertFits = async () => {
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
          ),
        ).toBeLessThanOrEqual(1)
      }
      const assertTarget = async (control: Locator) => {
        const box = await control.boundingBox()
        expect(box).not.toBeNull()
        if (width === 320) {
          expect(box!.width).toBeGreaterThanOrEqual(44)
          expect(box!.height).toBeGreaterThanOrEqual(44)
        }
      }
      const activate = async (control: Locator) => {
        if (width === 320) await control.tap()
        else await control.click()
      }
      await expect(shell).toHaveAttribute('data-gateway-online', 'true')
      expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(width === 320)
      await openChat(page)
      await page
        .getByRole('textbox', { name: 'Message Veduta in Health' })
        .fill('send to narrow@example.com: Please confirm the appointment.')
      await activate(page.getByRole('button', { name: 'Send message' }))
      await expect(
        page.locator('.chat-dock').getByRole('button', {
          name: 'Reject Send message to narrow@example.com',
          exact: true,
        }),
      ).toBeVisible()
      await closeChat(page)
      await activate(space.getByRole('button', { name: 'Pin Weight goal', exact: true }))
      await expect(
        space.getByRole('button', { name: 'Pinned Weight goal', exact: true }),
      ).toHaveAttribute('aria-pressed', 'true')
      await homeLink.click()
      // Server attention is independent durable fixture metadata, not a side effect of Pin.
      const attention = new PushStore({ rootDir: join(surfaceStack.baseDir, 'data') })
      try {
        attention.incrementAttention('spc-health')
      } finally {
        attention.close()
      }
      await page.reload()
      await expect(shell).toHaveAttribute('data-gateway-online', 'true')
      await expect(home).toBeVisible()
      await expect(health.getByText('New activity')).toBeVisible()
      await expect(health.getByLabel('1 pending decision', { exact: true })).toBeVisible()
      await expect(health.getByText('Attention', { exact: true })).toBeVisible()
      await expect(health.getByLabel('1 updates', { exact: true })).toBeVisible()
      await expect(health.getByText('Clear', { exact: true })).toHaveCount(0)
      await expect(health.getByText('4 Surfaces', { exact: true })).toBeVisible()
      await expect(health.locator('time')).toHaveAttribute('datetime', /\d{4}-\d{2}-\d{2}T/)
      await expect(health.locator('time')).toBeVisible()
      await assertFits()
      if (width === 320) {
        expect(
          await home
            .locator('.home-space-grid')
            .first()
            .evaluate((grid) => {
              const columns = getComputedStyle(grid).gridTemplateColumns.split(' ')
              return columns.length
            }),
        ).toBe(1)
      }
      const expand = summary.getByRole('button', { name: '1 decision awaits review' })
      await expect(expand).toHaveAttribute('aria-expanded', 'false')
      await assertTarget(expand)
      await expand.focus()
      await expand.press('Enter')
      await expect(expand).toHaveAttribute('aria-expanded', 'true')
      const review = summary.getByRole('link', {
        name: 'Review Send message to narrow@example.com',
        exact: true,
      })
      await assertTarget(review)
      await assertFits()
      await page.screenshot({ path: info.outputPath(`home-composition-${width}.png`) })
      await activate(review)
      await expect(page).toHaveURL(/\/app\/space\/health\/surface\//)
      await expect(
        surfaceCard(page, 'Approval required: Send message to narrow@example.com').getByRole(
          'button',
          { name: 'Focus Approval required: Send message to narrow@example.com', exact: true },
        ),
      ).toHaveAttribute('aria-pressed', 'true')
      await page.goBack()
      await expect(home).toBeVisible()
      await expect(health.getByText('New activity')).toHaveCount(0)
      await expect(health.getByText('Clear', { exact: true })).toBeVisible()
      await expect(health.getByLabel('1 pending decision', { exact: true })).toBeVisible()
      await page.goForward()
      await expect(space).toBeVisible()
      await homeLink.click()
      await activate(health)
      await expect(page).toHaveURL(`${surfaceStack.origin}/app/space/health`)
      await expect(space.getByRole('region', { name: 'Pending decisions' })).toBeVisible()
      await assertTarget(homeLink)
      const goal = surfaceCard(page, 'Weight goal')
      const toolbar = await goal.locator('.surface-toolbar').boundingBox()
      expect(toolbar).not.toBeNull()
      for (const control of await goal.locator('.surface-toolbar button').all()) {
        await assertTarget(control)
        const box = await control.boundingBox()
        expect(box!.x).toBeGreaterThanOrEqual(toolbar!.x)
        expect(box!.x + box!.width).toBeLessThanOrEqual(toolbar!.x + toolbar!.width)
      }
      const focus = goal.getByRole('button', { name: 'Focus Weight goal', exact: true })
      await activate(focus)
      const surfaceUrl = `${surfaceStack.origin}/app/space/health/surface/srf-goal`
      await expect(page).toHaveURL(surfaceUrl)
      await expect(focus).toHaveAttribute('aria-pressed', 'true')
      await page.reload()
      await expect(shell).toHaveAttribute('data-gateway-online', 'true')
      await expect(page).toHaveURL(surfaceUrl)
      await page.goBack()
      await expect(page).toHaveURL(`${surfaceStack.origin}/app/space/health`)
      await page.goForward()
      await expect(page).toHaveURL(surfaceUrl)
      await page.goto(surfaceUrl)
      await expect(space).toBeVisible()
      await expect(focus).toHaveAttribute('aria-pressed', 'true')
      await wire.disconnect()
      await expect(shell).toHaveAttribute('data-gateway-online', 'false')
      wire.disconnected = false
      await expect(shell).toHaveAttribute('data-gateway-online', 'true')
      await expect(page).toHaveURL(surfaceUrl)
      await assertFits()
      if (width === 320) {
        const navigation = page.getByRole('combobox', { name: 'Change Space' })
        await assertTarget(navigation)
        await navigation.focus()
        await navigation.press('Home')
        await navigation.press('Enter')
        await expect(home).toBeVisible()
        await activate(health)
        const spaceBox = await space.boundingBox()
        expect(spaceBox!.width).toBeGreaterThanOrEqual(width - 32)
        await expect(page.getByRole('textbox', { name: 'Message Veduta in Health' })).toHaveCount(0)
        await openChat(page)
        await closeChat(page)
        await expect(homeLink).toBeVisible()
      }
      await page.screenshot({ path: info.outputPath(`space-composition-${width}.png`) })
      expect(errors).toEqual([])
    })
  })
}
