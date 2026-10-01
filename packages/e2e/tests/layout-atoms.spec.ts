import { expect, test } from './surface-contracts-fixture.ts'

test('a composed Surface preserves media fallbacks, Pending replacement and canonical content after reload', async ({
  page,
  surfaceStack,
}) => {
  test.setTimeout(5 * 60_000)
  expect(surfaceStack.origin).toContain('localhost')
  await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'light' })
  await page
    .getByRole('textbox', { name: 'Message Veduta in Health' })
    .fill('show composed surface demo')
  await page.getByRole('button', { name: 'Send message' }).click()
  const surface = page.locator('article.surface-card', {
    has: page.getByRole('button', { name: 'Focus Composed Surface', exact: true }),
  })
  const slot = surface.locator('[data-veduta-atom-id="composed-preview"]')
  await expect(surface.getByRole('status', { name: 'Comparison preview loading' })).toBeVisible()
  await expect(slot).toHaveCount(1)
  const skeleton = slot.locator('[data-pending-skeleton-shape]').first()
  await expect(skeleton).toHaveCSS('animation-name', 'none')
  await expect(surface.getByText('Comparison preview ready', { exact: true })).toBeVisible()
  await expect(slot).toHaveCount(1)
  await expect(surface.getByRole('status', { name: 'Comparison preview loading' })).toHaveCount(0)

  async function expectComposition() {
    await expect(
      surface.getByRole('heading', { name: 'Composed Surface', exact: true }),
    ).toBeVisible()
    await expect(surface.getByText('Canonical overview', { exact: true })).toBeVisible()
    await expect(surface.getByRole('table', { name: 'Section status' })).toBeVisible()
    await expect(
      surface.getByRole('img', { name: 'All sections available', exact: true }),
    ).toBeVisible()
    const image = surface.getByRole('img', { name: 'Veduta mark', exact: true })
    await expect(image).toBeVisible()
    expect(
      await image.evaluate(
        (element) =>
          element instanceof HTMLImageElement && element.complete && element.naturalWidth > 0,
      ),
    ).toBe(true)
    await expect(surface.getByRole('img', { name: 'Surface preview unavailable' })).toBeVisible()
    await expect(
      surface.getByText('Canonical content stays visible with reduced motion.', { exact: true }),
    ).toBeVisible()
    await expect(surface.locator('[data-veduta-atom-id="composed-transition"]')).toHaveCSS(
      'transition-property',
      'none',
    )
    await expect(surface.getByText('Comparison preview ready', { exact: true })).toBeVisible()
    await expect(slot).toHaveCount(1)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
      true,
    )
  }

  await expectComposition()
  await page.reload()
  await expectComposition()
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.emulateMedia({ reducedMotion: 'reduce', colorScheme })
    await expectComposition()
    const stacked = await surface
      .locator('[data-veduta-atom-id="composed-row"]')
      .evaluate((row) => {
        const [first, second] = Array.from(row.children).map((child) =>
          child.getBoundingClientRect(),
        )
        return first !== undefined && second !== undefined && second.top >= first.bottom
      })
    expect(stacked).toBe(true)
    await page.setViewportSize({ width: 1280, height: 900 })
    await expectComposition()
  }
})
