import { expect, test } from './surface-contracts-fixture.ts'
import { createDatePickerFixtures } from './date-picker-fixture.ts'
import { CONTROL_SURFACE_TITLE, createControlSurface } from './control-surfaces.ts'

for (const settings of [
  {
    locale: 'en-US',
    timezoneId: 'America/Los_Angeles',
    width: 1440,
    day: /Friday, October 2nd, 2026/,
    date: 'Oct 2, 2026',
  },
  {
    locale: 'it-IT',
    timezoneId: 'Europe/Rome',
    width: 320,
    day: /venerdì 2 ottobre 2026/,
    date: '2 ott 2026',
  },
]) {
  test.describe(settings.locale, () => {
    test.use({
      locale: settings.locale,
      timezoneId: settings.timezoneId,
      hasTouch: settings.locale === 'it-IT',
      viewport: { width: settings.width, height: 900 },
    })
    test('shared calendar saves Surface dates and Automation instants through refresh', async ({
      page,
      surfaceStack,
    }, testInfo) => {
      test.setTimeout(5 * 60_000)
      const errors: string[] = []
      page.on('pageerror', (error) => errors.push(error.message))
      createDatePickerFixtures(surfaceStack.baseDir)
      await page.reload()
      const card = page.locator('article.surface-card').filter({
        has: page.getByRole('button', { name: `Focus ${CONTROL_SURFACE_TITLE}`, exact: true }),
      })
      const date = card.getByRole('button', { name: 'Date', exact: true })
      await date.click()
      await expect(page.getByRole('grid')).toBeVisible()
      const nextMonth = page.getByRole('button', {
        name: settings.locale === 'it-IT' ? /mese successivo/i : /Next Month/,
      })
      await expect(nextMonth).toHaveAttribute(
        'title',
        (await nextMonth.getAttribute('aria-label'))!,
      )
      expect((await nextMonth.boundingBox())!.height).toBe(settings.locale === 'it-IT' ? 44 : 32)
      expect((await date.boundingBox())!.height).toBe(settings.locale === 'it-IT' ? 44 : 32)
      if (settings.locale === 'it-IT') {
        const target = await page.getByRole('button', { name: settings.day }).boundingBox()
        expect(target!.width).toBeGreaterThanOrEqual(44)
        expect(target!.height).toBeGreaterThanOrEqual(44)
      } else {
        const target = await page.getByRole('button', { name: settings.day }).boundingBox()
        expect(target!.height).toBe(32)
      }
      await page.screenshot({ path: testInfo.outputPath('surface-calendar.png') })
      const calendar = page.locator('[data-slot="popover-content"]')
      const bounds = await calendar.boundingBox()
      expect(bounds).not.toBeNull()
      expect(bounds!.x).toBeGreaterThanOrEqual(0)
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(settings.width)
      await page.keyboard.press('Escape')
      await expect(date).toBeFocused()
      await expect(page.getByRole('grid')).toHaveCount(0)
      await date.press('Enter')
      await page.getByRole('button', { name: settings.day }).click()
      await expect(date).toHaveText(settings.date)
      await page.reload()
      await expect(date).toHaveText(settings.date)

      await page.goto(`${surfaceStack.origin}/app/connections?section=automations`)
      await page
        .locator('.connections-list')
        .getByRole('button', { name: /^Health/ })
        .click()
      const automation = page
        .locator('article.space-automation-setting')
        .filter({ has: page.getByRole('heading', { name: 'Calendar reminder', exact: true }) })
      await automation.getByText('Edit Automation', { exact: true }).click()
      await expect(
        automation.getByRole('group', {
          name: `New date and time (${settings.timezoneId})`,
          exact: true,
        }),
      ).toBeVisible()
      await automation.getByLabel('Time', { exact: true }).fill('09:30')
      await expect(
        automation.getByRole('button', { name: 'Save Automation', exact: true }),
      ).toBeDisabled()
      await automation.getByRole('button', { name: 'Date', exact: true }).click()
      const target = await page.evaluate(() => {
        const now = new Date()
        const next = new Date(now)
        next.setDate(next.getDate() + 2)
        next.setHours(9, 30, 0, 0)
        return {
          monthChanges: now.getMonth() !== next.getMonth(),
          label: next.toLocaleDateString(navigator.language, { month: 'long', day: 'numeric' }),
          day: next.getDate(),
          year: next.getFullYear(),
          month: next.toLocaleDateString(navigator.language, { month: 'long' }),
          iso: next.toISOString(),
        }
      })
      if (target.monthChanges)
        await page
          .getByRole('button', {
            name: settings.locale === 'it-IT' ? /mese successivo/i : /Next Month/,
          })
          .click()
      const chosenDay =
        settings.locale === 'it-IT'
          ? new RegExp(`${target.day} ${target.month} ${target.year}`)
          : new RegExp(`${target.month} ${target.day}(?:st|nd|rd|th), ${target.year}`)
      await page.getByRole('button', { name: chosenDay }).click()
      await expect(
        automation.getByRole('button', { name: 'Save Automation', exact: true }),
      ).toBeEnabled()
      await page.screenshot({ path: testInfo.outputPath('automation-date-and-time.png') })
      await automation.getByRole('button', { name: 'Save Automation', exact: true }).click()
      await expect(automation.locator(`time[datetime="${target.iso}"]`).first()).toBeVisible()
      await expect(
        automation.getByRole('button', { name: 'Save Automation', exact: true }),
      ).toBeDisabled()
      await page.reload()
      await page
        .locator('.connections-list')
        .getByRole('button', { name: /^Health/ })
        .click()
      await expect(automation.locator(`time[datetime="${target.iso}"]`).first()).toBeVisible()
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
      ).toBe(true)
      expect(errors).toEqual([])
    })
  })
}

test.describe('calendar-only dates in a timezone with a skipped civil day', () => {
  test.use({ locale: 'en-US', timezoneId: 'Pacific/Apia' })
  test('preserves December 30, 2011 through selection and refresh', async ({
    page,
    surfaceStack,
  }) => {
    createControlSurface(surfaceStack.baseDir, '2011-12-30')
    await page.reload()
    const card = page.locator('article.surface-card').filter({
      has: page.getByRole('button', { name: `Focus ${CONTROL_SURFACE_TITLE}`, exact: true }),
    })
    const date = card.getByRole('button', { name: 'Date', exact: true })
    await expect(date).toHaveText('Dec 30, 2011')
    await date.click()
    const day = page.getByRole('button', { name: /Friday, December 30th, 2011/ })
    await expect(day).toBeVisible()
    await expect(page.getByRole('gridcell', { selected: true })).toContainText('30')
    await expect(page.getByRole('button', { name: /Saturday, December 31st, 2011/ })).toHaveCount(1)
    await page.getByRole('button', { name: /Thursday, December 29th, 2011/ }).click()
    await expect(date).toHaveText('Dec 29, 2011')
    await date.click()
    await day.click()
    await expect(date).toHaveText('Dec 30, 2011')
    await page.reload()
    await expect(date).toHaveText('Dec 30, 2011')
  })
})
