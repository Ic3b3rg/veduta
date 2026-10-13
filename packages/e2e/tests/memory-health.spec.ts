import { expect, test } from '@playwright/test'
import { surfaceCard } from './fast-actions-journey.ts'
import { memoryHealthStack } from './memory-health-fixture.ts'

for (const width of [320, 1440]) {
  test(`Memory health stays live and durable with warnings and recovery at ${width}px`, async ({
    browser,
  }, info) => {
    const stack = await memoryHealthStack(browser, width)
    const { page, origin } = stack
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    try {
      await stack.start()
      await page.goto(`${origin}/app/space/system`)
      const card = surfaceCard(page, 'Memory health')
      await expect(card).toContainText('Current')
      await expect(card.getByRole('row').filter({ hasText: 'USER' })).toContainText('2000')
      await expect(card.getByRole('row').filter({ hasText: 'USER' })).toContainText('Within limit')
      await card.getByRole('button', { name: 'Pin Memory health', exact: true }).click()
      await expect(
        card.getByRole('button', { name: 'Pinned Memory health', exact: true }),
      ).toHaveAttribute('aria-pressed', 'true')
      await stack.update()
      for (const document of ['USER', 'INSTRUCTIONS']) {
        const row = card
          .getByRole('row')
          .filter({ hasText: document === 'INSTRUCTIONS' ? /INSTRUCTIONS.*Health/ : 'USER' })
        await expect(row).toContainText('2001')
        await expect(row).toContainText('Warning')
      }
      await expect(card).toContainText('over-high')
      await page.reload()
      await expect(card).toContainText('over-high')
      await stack.injectPersistenceFailure()
      await expect(card).toContainText('over-hard')
      await expect(card).toContainText('Over hard — recovery required')
      await page.reload()
      await expect(card).toContainText('over-hard')
      await stack.repairPersistence()
      await stack.restart()
      await expect(card).toContainText('over-hard')
      await expect(
        card.getByRole('button', { name: 'Pinned Memory health', exact: true }),
      ).toHaveAttribute('aria-pressed', 'true')
      await expect(page.getByRole('heading', { name: 'Memory health', exact: true })).toHaveCount(1)
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true)
      expect(errors).toEqual([])
      expect(stack.notificationStats()).toMatchObject({
        queuedCount: 0,
        perSpace: expect.arrayContaining([
          expect.objectContaining({ spaceId: 'spc-health', sentToday: 0, degradedToday: 0 }),
        ]),
      })
      expect(stack.notificationEvents()).toEqual([])
      await expect(page.locator('.chat-entry.assistant')).toHaveCount(0)
      await page.screenshot({ path: info.outputPath(`memory-health-${width}.png`), fullPage: true })
    } finally {
      await stack.stop()
    }
  })
}
