import { expect, test } from './surface-contracts-fixture.ts'
import { expectCompleteGymPlan } from './gym-plan-journey.ts'

test('the reported three-day plan visibly contains complete structured content after reload', async ({
  page,
  surfaceStack,
}) => {
  test.setTimeout(5 * 60_000)
  expect(surfaceStack.origin).toContain('localhost')
  const input = page.getByRole('textbox', { name: 'Message Veduta in Health' })
  await input.fill('data la mia dieta fammi una scheda per la palestra 3 giorni a settimana')
  await page.getByRole('button', { name: 'Send message' }).click()
  await expectCompleteGymPlan(page)
  await expect(
    page.locator('.chat-entry.assistant').filter({
      hasText: 'Saved Surface “Gym plan — 3 days”',
    }),
  ).toHaveCount(1)
  await expect(page.locator('.chat-entry.assistant').last()).toContainText('Session 3 — Full body')
  await page.reload()
  await expectCompleteGymPlan(page)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.emulateMedia({ colorScheme: 'dark' })
  await expectCompleteGymPlan(page)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
    true,
  )
})
