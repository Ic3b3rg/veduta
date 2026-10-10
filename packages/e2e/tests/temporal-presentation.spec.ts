import type { Page } from '@playwright/test'
import { expect, test } from './surface-contracts-fixture.ts'
import {
  createTemporalPresentationFixtures,
  HEALTH_RECORDED_AT,
  TEMPORAL_SURFACE_TITLE,
} from './temporal-presentation-fixture.ts'

for (const settings of [
  {
    locale: 'en-US',
    timezoneId: 'America/Los_Angeles',
    width: 1440,
    date: 'Oct 8, 2026',
    calendarDate: 'Oct 9, 2026',
    clock: '9:08 PM',
    daily: 'At 4:00 AM every day',
    weekday: 'At 8:15 AM on Monday–Friday',
    next: 'Next run: Jul 9, 2030, 4:00 AM',
  },
  {
    locale: 'it-IT',
    timezoneId: 'Europe/Rome',
    width: 390,
    date: '9 ott 2026',
    calendarDate: '9 ott 2026',
    clock: '06:08',
    daily: 'Alle 04:00 ogni giorno',
    weekday: 'Alle 08:15 di lunedì–venerdì',
    next: 'Prossima esecuzione: 9 lug 2030, 04:00',
  },
]) {
  test.describe(settings.locale, () => {
    test.use({
      locale: settings.locale,
      timezoneId: settings.timezoneId,
      viewport: { width: settings.width, height: 900 },
    })
    test('existing Surface dates and System/user schedules survive refresh with the browser locale', async ({
      page,
      surfaceStack,
    }, testInfo) => {
      test.setTimeout(5 * 60_000)
      const errors: string[] = []
      page.on('pageerror', (error) => errors.push(error.message))
      createTemporalPresentationFixtures(surfaceStack.baseDir)
      await page.reload()
      const card = page.locator('article.surface-card').filter({
        has: page.getByRole('button', { name: `Focus ${TEMPORAL_SURFACE_TITLE}`, exact: true }),
      })

      for (let refresh = 0; refresh < 2; refresh += 1) {
        await expect(card).toBeVisible()
        const point = card.locator('[data-veduta-atom-id="weight-chart"] time')
        await expect(point).toContainText(settings.date)
        await expect(point).toContainText(settings.clock)
        await expect(point).toHaveAttribute('datetime', HEALTH_RECORDED_AT)
        await expect(point).toHaveAttribute(
          'aria-label',
          new RegExp(HEALTH_RECORDED_AT.replaceAll('.', '\\.')),
        )
        await expect(card.getByRole('img')).toHaveAttribute(
          'aria-label',
          new RegExp(HEALTH_RECORDED_AT.replaceAll('.', '\\.')),
        )
        await expect(card.getByRole('table').locator('time').nth(0)).toContainText(settings.date)
        await expect(card.getByRole('table').locator('time').nth(1)).toHaveText(
          settings.calendarDate,
        )
        await expect(card.getByRole('cell', { name: '2026-02-30', exact: true })).toBeVisible()
        await expect(card.getByRole('cell', { name: '10/09/2026', exact: true })).toBeVisible()
        await expect(card).toContainText(settings.daily)
        await expect(card).not.toContainText('cron 0 4 * * *')
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
        ).toBe(true)
        if (refresh === 0) await page.reload()
      }
      await card
        .locator('[data-veduta-atom-id="weight-chart"]')
        .screenshot({ path: testInfo.outputPath('saved-health-chart.png'), animations: 'disabled' })
      await card
        .getByRole('table')
        .screenshot({ path: testInfo.outputPath('saved-health-table.png'), animations: 'disabled' })
      const complex = card.locator('[data-veduta-atom-id="complex-rule"]')
      await expect(complex).toContainText(settings.locale === 'it-IT' ? 'oppure' : 'or')
      await expect(complex).toContainText(
        settings.locale === 'it-IT' ? 'gennaio e giugno' : 'January and June',
      )
      await complex.screenshot({
        path: testInfo.outputPath('complex-schedule.png'),
        animations: 'disabled',
      })

      await page.goto(`${surfaceStack.origin}/app/connections?section=automations`)
      await openSpace(page, 'Health')
      const userSchedule = page
        .locator('article.space-automation-setting')
        .filter({ has: page.getByRole('heading', { name: 'Health date presentation check' }) })
      await expect(userSchedule).toContainText(settings.weekday)
      await expect(userSchedule).toContainText('UTC')
      await page.getByRole('button', { name: 'Close details', exact: true }).click()
      await openSpace(page, 'System')
      const systemSchedule = page
        .locator('article.space-automation-setting')
        .filter({ has: page.getByRole('heading', { name: 'System date presentation check' }) })
      await expect(systemSchedule).toContainText(settings.daily)
      await expect(systemSchedule).toContainText('Europe/Rome')
      await expect(systemSchedule).toContainText(settings.next)
      await page.reload()
      await openSpace(page, 'System')
      await expect(systemSchedule).toContainText(settings.next)
      await systemSchedule.screenshot({
        path: testInfo.outputPath('system-schedule.png'),
        animations: 'disabled',
      })
      expect(errors).toEqual([])
    })
  })
}

async function openSpace(page: Page, name: string): Promise<void> {
  await page
    .locator('.connections-list')
    .getByRole('button', { name: new RegExp(`^${name}`) })
    .click()
}
