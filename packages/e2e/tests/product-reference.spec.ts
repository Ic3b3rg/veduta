import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { test as base, expect } from '@playwright/test'
import { findFreePort } from './stack.ts'

const test = base.extend<Record<never, never>, { referenceOrigin: string }>({
  referenceOrigin: [
    // Playwright requires destructuring even when a fixture has no dependencies.
    // eslint-disable-next-line no-empty-pattern
    async ({}, use) => {
      const port = await findFreePort()
      const origin = `http://127.0.0.1:${port}`
      const child = spawn(
        'pnpm',
        [
          '--filter',
          '@veduta/pwa',
          'exec',
          'vite',
          '--host',
          '127.0.0.1',
          '--port',
          String(port),
          '--strictPort',
        ],
        {
          cwd: fileURLToPath(new URL('../../../', import.meta.url)),
          detached: true,
          stdio: 'pipe',
        },
      )
      let output = ''
      child.stdout.on('data', (data) => {
        output += String(data)
      })
      child.stderr.on('data', (data) => {
        output += String(data)
      })
      try {
        await expect
          .poll(async () => {
            if (child.exitCode !== null) throw new Error(`Reference server exited: ${output}`)
            return fetch(`${origin}/showcase/reference`)
              .then((response) => response.ok)
              .catch(() => false)
          })
          .toBe(true)
        await use(origin)
      } finally {
        if (child.pid && child.exitCode === null) {
          const exited = once(child, 'exit')
          process.kill(-child.pid, 'SIGTERM')
          await exited
        }
      }
    },
    { scope: 'worker' },
  ],
})

for (const width of [320, 1440]) {
  test.describe(`Precision Tool reference at ${width}px`, () => {
    test.use({
      viewport: { width, height: 900 },
      hasTouch: width === 320,
      colorScheme: 'light',
      serviceWorkers: 'block',
    })

    test('covers product states offline, keyboard overlay return, reflow and reload', async ({
      page,
      referenceOrigin,
    }, info) => {
      const unexpectedRequests: string[] = []
      page.on('request', (request) => {
        const url = new URL(request.url())
        if (
          url.protocol.startsWith('http') &&
          (url.origin !== referenceOrigin || /^\/(api|ws)(\/|$)/.test(url.pathname))
        )
          unexpectedRequests.push(url.href)
      })
      await page.goto(`${referenceOrigin}/showcase/reference`)
      await expect(page.getByRole('heading', { name: 'Precision Tool', exact: true })).toBeVisible()
      const state = page.getByRole('combobox', { name: 'Representative state' })
      const assertFits = async () =>
        expect
          .poll(() =>
            page.evaluate(
              () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
            ),
          )
          .toBeLessThanOrEqual(1)
      await assertFits()
      expect(
        await page.locator('main').evaluate((element) => getComputedStyle(element).colorScheme),
      ).toBe('dark')
      await expect(page.getByRole('status', { name: 'Next recommendation loading' })).toBeVisible()

      await state.selectOption('empty')
      await expect(page.getByText('No active Spaces', { exact: true })).toBeVisible()
      await expect(page.getByText('No completions yet.', { exact: true })).toBeVisible()
      await state.selectOption('loading')
      await expect(page.getByRole('status', { name: 'Loading Spaces' })).toBeVisible()
      await expect(
        page.getByRole('button', {
          name: 'Approve Send the repair appointment details to the building manager',
        }),
      ).toBeDisabled()
      await state.selectOption('stale')
      await expect(
        page
          .getByRole('region', { name: 'Surface chrome reference' })
          .getByText(
            'This relative-time view expired. Values below are preserved but are not current.',
          ),
      ).toBeVisible()
      await state.selectOption('updated')
      await expect(
        page
          .getByRole('region', { name: 'Space detail reference' })
          .getByText('Repair confirmed for Friday at 10:00.'),
      ).toBeVisible()
      await state.selectOption('error')
      await expect(
        page
          .getByRole('region', { name: 'Chat reference' })
          .getByRole('button', { name: 'Retry', exact: true }),
      ).toBeVisible()
      await state.selectOption('offline')
      await expect(
        page
          .getByRole('log', { name: 'Conversation' })
          .getByText('Waiting for Gateway', { exact: true }),
      ).toBeVisible()
      await state.selectOption('queued')
      await expect(
        page.getByRole('log', { name: 'Conversation' }).getByText('Queued', { exact: true }),
      ).toBeVisible()
      await state.selectOption('updated')
      await state.selectOption('reduced-motion')
      expect(
        await page.evaluate(
          () =>
            document.getAnimations().filter((animation) => animation.playState === 'running')
              .length,
        ),
      ).toBe(0)
      await assertFits()
      await page.evaluate(() => {
        document.documentElement.dataset['referenceMotionCount'] = '0'
        for (const event of ['animationstart', 'transitionrun']) {
          document.addEventListener(event, () => {
            const root = document.documentElement
            root.dataset['referenceMotionCount'] = String(
              Number(root.dataset['referenceMotionCount']) + 1,
            )
          })
        }
      })

      const location = page.getByRole('combobox', { name: 'Location', exact: true })
      await location.click()
      await location.press('ArrowDown')
      const popup = page.locator('[data-slot="combobox-content"]')
      await expect(popup).toBeVisible()
      await expect(popup).toHaveCSS('color-scheme', 'dark')
      await expect(popup).toHaveCSS('animation-name', 'none')
      await location.press('Escape')
      await expect(popup).toHaveCount(0)

      const trigger = page.getByRole('button', { name: 'Open reference overlay' })
      await trigger.focus()
      await page.keyboard.press('Enter')
      const dialog = page.getByRole('dialog', { name: 'Reference overlay' })
      await expect(dialog).toBeVisible()
      await expect(dialog).toHaveCSS('animation-name', 'none')
      await expect(page.locator('[data-slot="sheet-overlay"]')).toHaveCSS('animation-name', 'none')
      await expect(dialog.getByRole('textbox', { name: 'Display name' })).toBeFocused()
      await assertFits()
      if (width === 320) {
        const target = await dialog
          .getByRole('button', { name: 'Close reference overlay' })
          .boundingBox()
        expect(target?.height).toBeGreaterThanOrEqual(44)
        expect(target?.width).toBeGreaterThanOrEqual(44)
      }
      await page.keyboard.press('Escape')
      await expect(dialog).toHaveCount(0)
      await expect(trigger).toBeFocused()
      expect(
        await page.evaluate(() => document.documentElement.dataset['referenceMotionCount']),
      ).toBe('0')

      await state.selectOption('long')
      await page.reload()
      await expect(state).toHaveValue('long')
      await expect(
        page.getByRole('region', { name: 'Home reference' }).getByText('10m ago', { exact: true }),
      ).toBeVisible()
      await assertFits()
      expect(unexpectedRequests).toEqual([])
      await page.screenshot({
        path: info.outputPath(`product-reference-${width}.png`),
        fullPage: true,
        animations: 'disabled',
      })
    })
  })
}
