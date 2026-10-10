import { expect, type Page } from '@playwright/test'

export async function openChat(page: Page): Promise<void> {
  if ((page.viewportSize()?.width ?? 1280) >= 960) return
  const dialog = page.getByRole('dialog', { name: /^Chat / })
  if (await dialog.isVisible()) return
  await page.getByRole('button', { name: 'Open Chat', exact: true }).click()
  await expect(dialog).toBeVisible()
}

export async function closeChat(page: Page): Promise<void> {
  const close = page.getByRole('button', { name: 'Back to Space', exact: true })
  if (await close.isVisible()) {
    await close.click()
    await expect(page.getByRole('button', { name: 'Open Chat', exact: true })).toBeFocused()
  }
}
