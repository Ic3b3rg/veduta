import { expect, test } from './surface-contracts-fixture.ts'
import { createTemporalPresentationFixtures } from './temporal-presentation-fixture.ts'
import { openChat } from './chat-journey.ts'

/** Owner settings and Chat exercise the same durable Space, Curator and Scheduler authorities. */
test('manages memory, columns, Automations and recoverable archival across devices', async ({
  page,
  context,
  surfaceStack,
}, testInfo) => {
  test.setTimeout(5 * 60_000)
  page.setDefaultTimeout(15000)
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  createTemporalPresentationFixtures(surfaceStack.baseDir)
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.reload()
  await expect(
    page.getByRole('button', { name: 'Focus What I know about you here', exact: true }),
  ).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Focus Automations', exact: true })).toHaveCount(0)
  await expect(
    page.getByRole('button', { name: 'Focus Nightly Reflection', exact: true }),
  ).toHaveCount(0)

  await page
    .getByRole('textbox', { name: /^Message Veduta/ })
    .fill('imposta lo spazio a due colonne')
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  const grid = page.locator('.surface-grid')
  await expect(grid).toHaveAttribute('data-presentation', 'two-columns')
  await expect
    .poll(() =>
      grid.evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(' ').length),
    )
    .toBe(2)
  await page.reload()
  await expect(grid).toHaveAttribute('data-presentation', 'two-columns')
  await page.setViewportSize({ width: 390, height: 844 })
  await expect
    .poll(() =>
      grid.evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(' ').length),
    )
    .toBe(1)
  await page.goto(`${surfaceStack.origin}/app/connections?section=spaces`)
  await page
    .locator('.connections-list')
    .getByRole('button', { name: /^Health/ })
    .click()
  await page
    .getByRole('textbox', { name: 'Add a fact', exact: true })
    .fill('This Space records my daily walking.')
  await page.getByRole('button', { name: 'Save fact', exact: true }).click()
  await expect(
    page.getByText('This Space records my daily walking.', { exact: true }),
  ).toBeVisible()
  await page
    .getByRole('textbox', { name: 'Instructions', exact: true })
    .fill('Use metric units and concise explanations.')
  await page.getByRole('button', { name: 'Save instructions', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Save instructions', exact: true })).toBeDisabled()
  await page.reload()
  await page
    .locator('.connections-list')
    .getByRole('button', { name: /^Health/ })
    .click()
  await expect(page.getByRole('textbox', { name: 'Instructions', exact: true })).toHaveValue(
    'Use metric units and concise explanations.',
  )
  await expect(page.getByRole('combobox', { name: 'Columns', exact: true })).toHaveValue(
    'two-columns',
  )
  await page.getByRole('button', { name: 'Archive Space', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Confirm archive', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Keep Space', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Restore Space', exact: true })).toHaveCount(0)
  await page.screenshot({ path: testInfo.outputPath('space-memory-phone.png') })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
    true,
  )

  const other = await context.newPage()
  try {
    await other.goto(`${surfaceStack.origin}/app/connections?section=spaces`)
    await other
      .locator('.connections-list')
      .getByRole('button', { name: /^Health/ })
      .click()
    await other
      .getByRole('textbox', { name: 'Instructions', exact: true })
      .fill('A stale instruction from another device')
    await page
      .getByRole('textbox', { name: 'Instructions', exact: true })
      .fill('Keep metric units. Ask before adding a new goal.')
    await page.getByRole('button', { name: 'Save instructions', exact: true }).click()
    await expect(
      page.getByRole('button', { name: 'Save instructions', exact: true }),
    ).toBeDisabled()
    await other.getByRole('button', { name: 'Save instructions', exact: true }).click()
    await expect(other.getByRole('alert')).toContainText('Instructions changed')
    await other.reload()
    await other
      .locator('.connections-list')
      .getByRole('button', { name: /^Health/ })
      .click()
    await expect(other.getByRole('textbox', { name: 'Instructions', exact: true })).toHaveValue(
      'Keep metric units. Ask before adding a new goal.',
    )
  } finally {
    await other.close()
  }

  await page.goto(`${surfaceStack.origin}/app/connections?section=automations`)
  const reflection = page.locator('.space-reflection-settings')
  await reflection.getByLabel('Enabled', { exact: true }).uncheck()
  await reflection.getByLabel('Daily time', { exact: true }).fill('03:45')
  await reflection.getByRole('button', { name: 'Save Reflection settings' }).click()
  await expect(reflection.getByRole('button', { name: 'Save Reflection settings' })).toBeDisabled()
  await page.reload()
  await expect(reflection.getByLabel('Enabled', { exact: true })).not.toBeChecked()
  await expect(reflection.getByLabel('Daily time', { exact: true })).toHaveValue('03:45')
  await reflection.getByLabel('Enabled', { exact: true }).check()
  await reflection.getByRole('button', { name: 'Save Reflection settings' }).click()
  await expect(reflection.getByRole('button', { name: 'Save Reflection settings' })).toBeDisabled()
  await page
    .locator('.connections-list')
    .getByRole('button', { name: /^Health/ })
    .click()
  const automation = page
    .locator('article.space-automation-setting')
    .filter({ has: page.getByRole('heading', { name: 'Health date presentation check' }) })
  await automation.getByRole('button', { name: 'Disable', exact: true }).click()
  await expect(automation.getByRole('button', { name: 'Enable', exact: true })).toBeVisible()
  await automation.getByText('Edit Automation', { exact: true }).click()
  await automation.getByRole('combobox', { name: 'Schedule', exact: true }).selectOption('weekdays')
  await automation.getByLabel('Time (UTC)', { exact: true }).fill('11:30')
  await automation.getByRole('button', { name: 'Save Automation', exact: true }).click()
  await expect(automation).toContainText('At 11:30 AM on Monday–Friday')
  await page.reload()
  await page
    .locator('.connections-list')
    .getByRole('button', { name: /^Health/ })
    .click()
  await expect(automation).toContainText('At 11:30 AM on Monday–Friday')
  await expect(automation.getByRole('button', { name: 'Enable', exact: true })).toBeVisible()

  await page.goto(`${surfaceStack.origin}/app/space/health`)
  await openChat(page)
  await page.getByRole('textbox', { name: /^Message Veduta/ }).fill('Archive this Space')
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  const focusedDecision = page
    .locator('.chat-pending-decision')
    .filter({ hasText: 'Archive Space “Health”' })
  await expect(focusedDecision).toBeVisible()
  await focusedDecision
    .getByRole('button', { name: 'Reject Archive Space “Health”', exact: true })
    .click()
  await expect(focusedDecision).toContainText('Rejected')
  await page.getByRole('button', { name: 'Back to Space', exact: true }).click()
  await expect(page.getByRole('main', { name: 'Health Space', exact: true })).toBeVisible()
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.goto(`${surfaceStack.origin}/`)
  await page.getByRole('textbox', { name: /^Message Veduta/ }).fill('Archive Health')
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  const archiveDecision = page
    .getByRole('region', { name: 'Pending decisions', exact: true })
    .getByRole('article', { name: 'Archive Space “Health”', exact: true })
  await expect(archiveDecision).toBeVisible()
  await expect(page.getByRole('main', { name: 'Health Space', exact: true })).toBeVisible()
  await page.reload()
  await expect(archiveDecision).toBeVisible()
  await archiveDecision
    .getByRole('link', { name: 'Review Archive Space “Health”', exact: true })
    .click()
  const review = page.locator('.surface-card').filter({
    has: page.getByRole('heading', {
      name: 'Approval required: Archive Space “Health”',
      exact: true,
    }),
  })
  await expect(review).toContainText('Nothing is permanently deleted')
  await expect(review.getByRole('checkbox')).toHaveCount(0)
  await review.getByRole('button', { name: 'Approve', exact: true }).click()
  await page.goto(`${surfaceStack.origin}/`)
  await expect(
    page.getByRole('main', { name: 'Home', exact: true }).getByRole('link', { name: /Health/ }),
  ).toHaveCount(0)
  await page.reload()
  await expect(
    page.getByRole('main', { name: 'Home', exact: true }).getByRole('link', { name: /Health/ }),
  ).toHaveCount(0)
  await page.getByRole('textbox', { name: /^Message Veduta/ }).fill('Restore Health')
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await expect(
    page.getByRole('main', { name: 'Home', exact: true }).getByRole('link', { name: /Health/ }),
  ).toBeVisible()
  await page.goto(`${surfaceStack.origin}/app/connections?section=spaces`)
  await page
    .locator('.connections-list')
    .getByRole('button', { name: /^Health/ })
    .click()
  await expect(
    page.getByText('This Space records my daily walking.', { exact: true }),
  ).toBeVisible()
  await expect(page.getByRole('textbox', { name: 'Instructions', exact: true })).toHaveValue(
    'Keep metric units. Ask before adding a new goal.',
  )
  await expect(page.getByRole('combobox', { name: 'Columns', exact: true })).toHaveValue(
    'two-columns',
  )
  expect(errors).toEqual([])
})
