import { expect, test } from './surface-contracts-fixture.ts'

test('the reported three-day plan visibly contains complete structured content after reload', async ({
  page,
  surfaceStack,
}) => {
  test.setTimeout(5 * 60_000)
  expect(surfaceStack.origin).toContain('localhost')
  const input = page.getByRole('textbox', { name: 'Message Veduta in Health' })
  await input.fill('data la mia dieta fammi una scheda per la palestra 3 giorni a settimana')
  await page.getByRole('button', { name: 'Send message' }).click()
  const plan = page.locator('article.surface-card', {
    has: page.getByRole('button', { name: 'Focus Gym plan — 3 days', exact: true }),
  })

  async function expectCompletePlan() {
    await expect(plan.getByRole('heading', { name: 'Session 1 — Strength' })).toBeVisible()
    await expect(plan.getByRole('heading', { name: 'Session 2 — Upper body' })).toBeVisible()
    await expect(plan.getByRole('heading', { name: 'Session 3 — Full body' })).toBeVisible()
    await expect(plan.getByRole('table')).toHaveCount(3)
    for (const cell of [
      'Squat',
      'Row',
      'Deadlift',
      '3 × 8',
      '3 × 10',
      '3 × 6',
      '90 seconds',
      '60 seconds',
      '120 seconds',
    ])
      await expect(plan.getByRole('cell', { name: cell, exact: true })).toBeVisible()
    await expect(plan.getByText(/Add one repetition before increasing load/)).toBeVisible()
    await expect(plan.getByText(/stop if you feel sharp pain/)).toBeVisible()
    await expect(plan.getByText('Keep a rest day between sessions.')).toBeVisible()
  }

  await expectCompletePlan()
  await expect(
    page.locator('.chat-entry.assistant').filter({
      hasText: 'Saved Surface “Gym plan — 3 days”',
    }),
  ).toHaveCount(1)
  await expect(page.locator('.chat-entry.assistant').last()).toContainText('Session 3 — Full body')
  await page.reload()
  await expectCompletePlan()
  await page.setViewportSize({ width: 390, height: 844 })
  await page.emulateMedia({ colorScheme: 'dark' })
  await expectCompletePlan()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
    true,
  )
})
