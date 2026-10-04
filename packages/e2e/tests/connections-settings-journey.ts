import { expect, type Page } from '@playwright/test'

/** Settings metadata and credentials are exercised on the journey's disposable Gateway root. */
export async function verifyConnectionsSettings(page: Page, observerPage: Page): Promise<void> {
  await page.getByRole('button', { name: 'Connections', exact: true }).click()
  await expect(
    page.getByRole('heading', { name: 'Accounts & services', exact: true }),
  ).toBeVisible()
  await expect(page.getByText('Overview', { exact: true })).toHaveCount(0)
  await expect(page.getByText('Connections & integrations', { exact: true })).toHaveCount(0)
  await page.getByRole('link', { name: 'Extensions', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Extensions', exact: true })).toBeVisible()
  await expect(page.getByText('Available to connect', { exact: true })).toBeVisible()
  await page.getByRole('link', { name: 'Models', exact: true }).click()
  await page.getByRole('button', { name: 'Add model', exact: true }).click()
  await expect(page.getByRole('complementary', { name: 'Add model details' })).toBeVisible()
  await page.getByRole('button', { name: 'Close details' }).click()
  await page.getByRole('link', { name: 'Accounts & services', exact: true }).click()
  await page.getByRole('button', { name: 'Add account', exact: true }).click()
  await page.getByRole('button', { name: 'Connect IMAP and SMTP' }).click()
  await page.getByLabel('Connection name', { exact: true }).fill('Disposable settings mailbox')
  await page.getByLabel('Email address', { exact: true }).fill('settings-proof@example.invalid')
  await page.getByLabel('IMAP server URL').fill('imaps://example.invalid:993')
  await page.getByLabel('IMAP username').fill('settings-proof@example.invalid')
  await page.getByLabel('IMAP password').fill('disposable-imap-credential')
  await page.getByLabel('SMTP server URL').fill('smtps://example.invalid:465')
  await page.getByLabel('SMTP username').fill('settings-proof@example.invalid')
  await page.getByLabel('SMTP password').fill('disposable-smtp-credential')
  await page.getByRole('button', { name: 'Add Mailbox', exact: true }).click()
  const account = page
    .locator('.connection-list-item')
    .filter({ hasText: 'Disposable settings mailbox' })
  await expect(account).toContainText('needs verification')
  expect((await account.boundingBox())!.height).toBeLessThan(140)
  await page.reload()
  await expect(
    page.getByRole('complementary', { name: 'Disposable settings mailbox details' }),
  ).toBeVisible()
  await expect(account).toContainText('needs verification')
  await observerPage.goto(page.url())
  await expect(
    observerPage
      .locator('.connection-list-item')
      .filter({ hasText: 'Disposable settings mailbox' }),
  ).toContainText('needs verification')

  await page.setViewportSize({ width: 390, height: 844 })
  const drawer = page.getByRole('dialog', { name: 'Disposable settings mailbox' })
  await expect(drawer).toBeVisible()
  const bounds = await drawer.boundingBox()
  expect(bounds?.width).toBe(390)
  expect(bounds?.height).toBe(844)
  await page.keyboard.press('Escape')
  await expect(drawer).toHaveCount(0)
  await expect(account).toBeFocused()
  await page.getByRole('button', { name: 'Add account', exact: true }).click()
  await page.getByRole('button', { name: 'Review access', exact: true }).click()
  const gmailDrawer = page.getByRole('dialog', { name: 'Gmail setup' })
  await expect(gmailDrawer).toBeVisible()
  const scrolling = await gmailDrawer
    .locator('.connection-detail-body')
    .evaluate((element) => ({ height: element.clientHeight, content: element.scrollHeight }))
  expect(scrolling.content).toBeGreaterThan(scrolling.height)
  await expect(gmailDrawer.getByRole('button', { name: 'Continue to Google' })).toBeInViewport()
  await expect(gmailDrawer.getByRole('button', { name: 'Continue to Google' })).toBeDisabled()
  await page.reload()
  await expect(gmailDrawer).toContainText('State: reviewing')
  await gmailDrawer.getByRole('button', { name: 'Cancel setup' }).click()
  await expect(gmailDrawer).toHaveCount(0)

  await account.click()
  page.once('dialog', (dialog) => void dialog.accept())
  await page
    .getByRole('dialog', { name: 'Disposable settings mailbox' })
    .getByRole('button', { name: 'Remove', exact: true })
    .click()
  await expect(account).toHaveCount(0)
  await expect(
    observerPage
      .locator('.connection-list-item')
      .filter({ hasText: 'Disposable settings mailbox' }),
  ).toHaveCount(0)
  await page.setViewportSize({ width: 1280, height: 720 })
  await page.getByRole('link', { name: 'Space access', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Space access', exact: true })).toBeVisible()
  await page.getByRole('link', { name: 'Back to Veduta' }).click()
  await expect(page.getByRole('main', { name: 'Home' })).toBeVisible()
}
