import { expect, test } from './surface-contracts-fixture.ts'
import { ActionWire } from './fast-actions-journey.ts'
import { referenceModels } from '../../pwa/src/product-reference-data.ts'
import { ChatTimeline } from '../../daemon/src/chat-timeline.ts'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

for (const width of [320, 1440]) {
  test.describe(`Precision Tool Chat at ${width}px`, () => {
    test.use({
      viewport: { width, height: 900 },
      isMobile: width === 320,
      hasTouch: width === 320,
      contextOptions: { reducedMotion: 'reduce' },
    })

    test('keeps content, approvals and the composer in separate reachable regions', async ({
      page,
      surfaceStack,
    }, info) => {
      expect(surfaceStack.origin).toBeTruthy()
      const wire = new ActionWire(page, [])
      await wire.install()
      await page.route('**/api/model-connections', (route) =>
        route.fulfill({ json: referenceModels }),
      )
      await page.reload()
      const shell = page.locator('.app-shell')
      const content = page.getByRole('main', { name: 'Health Space' })
      const chat = page.getByRole('contentinfo', { name: 'Global chat' })
      const composer = page.getByRole('textbox', { name: 'Message Veduta in Health' })
      const send = page.getByRole('button', { name: 'Send message' })
      await expect(shell).toHaveAttribute('data-gateway-online', 'true')
      await composer.fill('send to layout@example.com: Please confirm the appointment.')
      await send.click()
      const reject = content.getByRole('button', {
        name: 'Reject Send message to layout@example.com',
        exact: true,
      })
      await expect(reject).toBeVisible()
      const decisionRoute = page.url()

      const assertRegions = async () => {
        const mainBox = await content.boundingBox()
        const chatBox = await chat.boundingBox()
        const inputBox = await composer.boundingBox()
        expect(mainBox).not.toBeNull()
        expect(chatBox).not.toBeNull()
        expect(inputBox).not.toBeNull()
        expect(mainBox!.height).toBeGreaterThan(44)
        expect(mainBox!.y + mainBox!.height).toBeLessThanOrEqual(chatBox!.y + 1)
        expect(inputBox!.y + inputBox!.height).toBeLessThanOrEqual(page.viewportSize()!.height)
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
          ),
        ).toBeLessThanOrEqual(1)
      }
      await assertRegions()
      await expect(chat).toHaveCSS('backdrop-filter', 'none')
      await expect(chat).toHaveCSS('box-shadow', 'none')
      await reject.scrollIntoViewIfNeeded()
      const rejectBox = await reject.boundingBox()
      const chatBox = await chat.boundingBox()
      expect(rejectBox!.y + rejectBox!.height).toBeLessThanOrEqual(chatBox!.y)
      await reject.focus()
      await expect(reject).toBeFocused()
      if (width === 320) {
        expect(rejectBox!.height).toBeGreaterThanOrEqual(44)
        expect(rejectBox!.width).toBeGreaterThanOrEqual(44)
      }
      await page.reload()
      await expect(shell).toHaveAttribute('data-gateway-online', 'true')
      await expect(reject).toBeVisible()
      await assertRegions()
      await reject.click()
      await expect(content.getByRole('button', { name: /^Reject Send message/ })).toHaveCount(0)
      await expect(page).toHaveURL(decisionRoute)
      await expect(chat.getByText('Rejected', { exact: true })).toBeVisible()
      await expect(chat.getByText('Rejected', { exact: true })).toHaveAttribute(
        'data-tone',
        'muted',
      )
      await page.reload()
      await expect(chat.getByText('Rejected', { exact: true })).toBeVisible()
      await expect(page).toHaveURL(decisionRoute)

      await wire.disconnect()
      await expect(shell).toHaveAttribute('data-gateway-online', 'false')
      await expect(chat.getByText('Offline', { exact: true })).toBeVisible()
      await assertRegions()
      wire.disconnected = false
      await expect(shell).toHaveAttribute('data-gateway-online', 'true')
      await expect(chat.getByText('Offline', { exact: true })).toHaveCount(0)
      await page.setViewportSize({ width, height: 380 })
      await composer.focus()
      await expect(composer).toBeFocused()
      await assertRegions()

      // A previous interrupted turn is durable fixture data; Retry still uses the real Gateway.
      const timeline = new ChatTimeline(join(surfaceStack.baseDir, 'data'))
      try {
        const accepted = timeline.accept({
          submissionId: randomUUID(),
          scope: { type: 'space', spaceId: 'spc-health' },
          text: 'Keep a short appointment note.',
        })
        timeline.begin(accepted.turnId)
        timeline.fail(accepted.turnId, 'The previous attempt was interrupted.', true)
      } finally {
        timeline.close()
      }
      await page.reload()
      await expect(shell).toHaveAttribute('data-gateway-online', 'true')
      const retry = chat.getByRole('button', { name: 'Retry', exact: true })
      await retry.scrollIntoViewIfNeeded()
      const retryBox = await retry.boundingBox()
      const logBox = await chat.getByRole('log', { name: 'Conversation' }).boundingBox()
      expect(retryBox!.y).toBeGreaterThanOrEqual(logBox!.y)
      expect(retryBox!.y + retryBox!.height).toBeLessThanOrEqual(logBox!.y + logBox!.height)
      if (width === 320) expect(retryBox!.height).toBeGreaterThanOrEqual(44)
      await retry.click({ timeout: 15_000 })
      await expect(chat.getByRole('button', { name: 'Retry requested' })).toBeDisabled()
      await assertRegions()
      await composer.fill('A multiline draft remains editable.\n'.repeat(4))
      await assertRegions()
      await composer.fill('')
      await page.setViewportSize({ width, height: 900 })
      await assertRegions()
      await page.screenshot({ path: info.outputPath(`chat-layout-${width}.png`) })
    })
  })
}
