import { join } from 'node:path'
import type { Locator, Page } from '@playwright/test'
import {
  PendingDecisionResolveResultSchema,
  applySurfacePatch,
  surfacePath,
} from '../../protocol/src/index.ts'
import { Store } from '../../daemon/src/store.ts'
import { closeChat, openChat } from './chat-journey.ts'
import { ActionWire, surfaceCard } from './fast-actions-journey.ts'
import { expect, test } from './surface-contracts-fixture.ts'
import { createTreeProposalReview } from './tree-proposal-review-fixture.ts'

for (const width of [320, 1440]) {
  test.describe(`Tree proposal review at ${width}px`, () => {
    test.use({
      viewport: { width, height: 900 },
      isMobile: width === 320,
      hasTouch: width === 320,
      contextOptions: { reducedMotion: 'reduce' },
    })

    test('reviews exact complete changes without executing them, recovers pending work, and resolves once', async ({
      page,
      surfaceStack,
    }, testInfo) => {
      test.setTimeout(5 * 60_000)
      const rootDir = join(surfaceStack.baseDir, 'data')
      const errors: string[] = []
      page.on('pageerror', (error) => errors.push(error.message))
      const imageRequests: string[] = []
      await page.route('**/review-image-must-not-load-before-acceptance.png', async (route) => {
        imageRequests.push(route.request().url())
        await route.fulfill({
          contentType: 'image/png',
          body: Buffer.from(
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j7ZkAAAAASUVORK5CYII=',
            'base64',
          ),
        })
      })
      const wire = new ActionWire(page, [])
      await wire.install()
      const review = createTreeProposalReview(rootDir)
      const before = readTarget(rootDir, review.targetId)
      const expected = applySurfacePatch(before.surface, {
        surfaceId: review.targetId,
        operations: review.operations,
      })
      const card = surfaceCard(page, review.title)
      const reviewName = `Review ${review.summary}`
      const reviewUrl = `${surfaceStack.origin}${surfacePath('health', review.cardId)}`

      await test.step('Home, Space and Chat Review identify the same exact Decision Surface', async () => {
        await page.reload()
        await expect(page.locator('.app-shell')).toHaveAttribute('data-gateway-online', 'true')
        await page
          .locator('.space-pending-decisions')
          .getByRole('link', { name: reviewName, exact: true })
          .click()
        await expect(page).toHaveURL(reviewUrl)
        await expect(
          card.getByRole('button', { name: `Focus ${review.title}`, exact: true }),
        ).toHaveAttribute('aria-pressed', 'true')

        await page.goto(surfaceStack.origin)
        await page.getByRole('button', { name: '1 decision awaits review', exact: true }).click()
        await page
          .getByRole('region', { name: 'Pending decisions', exact: true })
          .getByRole('link', { name: reviewName, exact: true })
          .click()
        await expect(page).toHaveURL(reviewUrl)
        await expect(card).toBeVisible()

        await openChat(page)
        const chatReview = page
          .locator('.chat-pending-decision')
          .getByRole('link', { name: reviewName, exact: true })
        await expect(chatReview).toHaveCount(1)
        await chatReview.click()
        await expect(page).toHaveURL(reviewUrl)
        if (width === 320) await expect(page.getByRole('dialog', { name: /^Chat / })).toHaveCount(0)
        await expect(
          card.getByRole('button', { name: `Focus ${review.title}`, exact: true }),
        ).toHaveAttribute('aria-pressed', 'true')
      })

      await test.step('keyboard disclosure exposes removed content and the full long before/after comparison', async () => {
        await expect(card).toContainText('Accept applies these changes once')
        await expect(card).toContainText('Reject keeps the Surface unchanged')
        const removal = await expandChange(page, card, /^1\. Remove/)
        await expect(removal.content).toContainText('Express fee: €25')
        await expect(removal.content).toContainText('Removed: this content will no longer appear.')
        await removal.trigger.press('Space')
        await expect(removal.trigger).toHaveAttribute('aria-expanded', 'false')

        const replacement = await expandChange(page, card, /^2\. Replace/)
        const previousText = replacement.content.getByText(review.oldText, { exact: true })
        const proposedText = replacement.content.getByText(review.newText, { exact: true })
        expect(review.oldText.length).toBeGreaterThan(5_000)
        expect(review.newText.length).toBeGreaterThan(5_000)
        await expect(previousText).toHaveText(review.oldText)
        await expect(proposedText).toHaveText(review.newText)
        await replacement.content
          .getByRole('heading', { name: 'After', exact: true })
          .scrollIntoViewIfNeeded()
        await expectFits(page, card)
        await page.screenshot({
          path: testInfo.outputPath(`tree-review-long-content-${width}.png`),
          animations: 'disabled',
        })
        await replacement.trigger.click()
      })

      await test.step('actions, bindings, moves, collections and image declarations remain inert', async () => {
        const action = await expandChange(page, card, /^3\. Change actions/)
        await expect(action.content).toContainText('"value": false')
        await expect(action.content).toContainText('"value": true')
        await expect(
          card.getByRole('button', { name: 'Confirm delivery', exact: true }),
        ).toHaveCount(0)
        await action.trigger.click()

        const binding = await expandChange(page, card, /^4\. Change data binding/)
        for (const value of ['oldDestination', 'newDestination', 'Rome', 'Milan'])
          await expect(binding.content).toContainText(value)
        await binding.trigger.click()

        const move = await expandChange(page, card, /^5\. Move/)
        await expect(move.content).toContainText('Call after delivery')
        await expect(move.content).toContainText('item 4 (/children/3)')
        await expect(move.content).toContainText('item 1 (/children/0)')
        await move.trigger.click()

        const table = await expandChange(page, card, /^6\. Add/)
        await expect(table.content).toContainText('Delivery stop 100')
        await expectFits(page, card)
        await table.trigger.click()

        const image = await expandChange(page, card, /^7\. Add/)
        await expect(image.content).toContainText(
          '/review-image-must-not-load-before-acceptance.png',
        )
        await expect(card.getByRole('img')).toHaveCount(0)
        await image.trigger.click()

        const result = await expandChange(page, card, /^Result after acceptance/)
        await expect(result.content).toContainText(review.newText)
        await expect(result.content).toContainText('Delivery stop 100')
        await expect(result.content).not.toContainText('Express fee: €25')
        await expect(card.getByRole('img')).toHaveCount(0)
        await expectFits(page, card)
        await result.trigger.click()
        expect(imageRequests).toEqual([])
        expect(wire.requests).toEqual([])
        expect(readTarget(rootDir, review.targetId)).toEqual(before)
      })

      await test.step('refresh and reconnect retain the same pending review and reachable decision controls', async () => {
        await page.reload()
        await expect(page.locator('.app-shell')).toHaveAttribute('data-gateway-online', 'true')
        await expect(page).toHaveURL(reviewUrl)
        await expect(card).toHaveCount(1)
        const replacement = await expandChange(page, card, /^2\. Replace/)
        await expect(replacement.content.getByText(review.oldText, { exact: true })).toHaveText(
          review.oldText,
        )
        await expect(replacement.content.getByText(review.newText, { exact: true })).toHaveText(
          review.newText,
        )
        await replacement.trigger.click()
        await wire.disconnect()
        await expect(page.locator('.app-shell')).toHaveAttribute('data-gateway-online', 'false')
        wire.disconnected = false
        await expect(page.locator('.app-shell')).toHaveAttribute('data-gateway-online', 'true')
        await expect(card).toHaveCount(1)
        expect(readTarget(rootDir, review.targetId)).toEqual(before)
        const accept = card.getByRole('button', { name: 'Accept', exact: true })
        await accept.scrollIntoViewIfNeeded()
        await expect(accept).toBeEnabled()
        await expectFits(page, card)
        const bounds = await accept.boundingBox()
        const contentBounds = await page.getByRole('main', { name: 'Health Space' }).boundingBox()
        expect(bounds!.y).toBeGreaterThanOrEqual(contentBounds!.y)
        expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(
          contentBounds!.y + contentBounds!.height,
        )
        await page.screenshot({
          path: testInfo.outputPath(`tree-review-controls-${width}.png`),
          animations: 'disabled',
        })
      })

      await test.step('accepting the exact decision applies its reviewed operations once, including a repeated authenticated request', async () => {
        const request = page.waitForRequest(
          (request) =>
            request.method() === 'POST' &&
            decodeURIComponent(request.url()).endsWith(
              `/api/pending-decisions/${review.decisionId}/resolve`,
            ),
        )
        await page
          .locator('.space-pending-decisions')
          .getByRole('button', { name: `Accept ${review.summary}`, exact: true })
          .click()
        const submitted = await request
        await expect(card).toHaveCount(0)
        const replay = await page.request.fetch(submitted)
        expect(replay.ok()).toBe(true)
        expect(PendingDecisionResolveResultSchema.parse(await replay.json())).toMatchObject({
          replayed: true,
          decision: {
            id: review.decisionId,
            state: 'terminal',
            outcome: 'accepted',
            resolvedBy: 'trusted:user',
          },
        })
        const after = readTarget(rootDir, review.targetId)
        expect(after.surface.tree).toMatchObject({ ...expected.tree })
        expect(after.surface.state).toEqual(before.surface.state)
        expect(after.treeVersion).toBe(review.expectedTreeVersion + 1)
        expect(resolutionEvents(rootDir, review.proposalId)).toEqual([
          'surface.tree_proposal_accepted',
        ])
        await page.reload()
        await openChat(page)
        await expect(
          page.locator('.chat-pending-decision-outcome').filter({ hasText: 'Accepted' }),
        ).toHaveCount(1)
        await closeChat(page)
        expect(resolutionEvents(rootDir, review.proposalId)).toEqual([
          'surface.tree_proposal_accepted',
        ])
      })

      await test.step('rejecting the Decision Surface leaves its target unchanged through refresh', async () => {
        const rejected = createTreeProposalReview(rootDir, 'srf-delivery-review-rejected')
        const rejectedBefore = readTarget(rootDir, rejected.targetId)
        await page.goto(`${surfaceStack.origin}${surfacePath('health', rejected.cardId)}`)
        const rejectedCard = surfaceCard(page, rejected.title)
        await expect(rejectedCard).toBeVisible()
        await rejectedCard.getByRole('button', { name: 'Reject', exact: true }).click()
        await expect(rejectedCard).toHaveCount(0)
        expect(readTarget(rootDir, rejected.targetId)).toEqual(rejectedBefore)
        expect(resolutionEvents(rootDir, rejected.proposalId)).toEqual([
          'surface.tree_proposal_rejected',
        ])
        await page.reload()
        await openChat(page)
        await expect(
          page.locator('.chat-pending-decision-outcome').filter({ hasText: 'Rejected' }),
        ).toHaveCount(1)
        expect(readTarget(rootDir, rejected.targetId)).toEqual(rejectedBefore)
      })
      expect(errors).toEqual([])
    })
  })
}

async function expandChange(page: Page, card: Locator, name: RegExp) {
  const trigger = card.getByRole('button', { name })
  await trigger.focus()
  await trigger.press('Enter')
  await expect(trigger).toHaveAttribute('aria-expanded', 'true')
  const controlledId = await trigger.getAttribute('aria-controls')
  expect(controlledId).toBeTruthy()
  const content = page.locator(`[id="${controlledId}"]`)
  await expect(content).toBeVisible()
  return { trigger, content }
}

async function expectFits(page: Page, card: Locator) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    ),
  ).toBeLessThanOrEqual(1)
  expect(
    await card.evaluate((element) => element.scrollWidth - element.clientWidth),
  ).toBeLessThanOrEqual(1)
  const overflowingText = await card
    .locator('p')
    .evaluateAll(
      (elements) =>
        elements.filter((element) => element.scrollWidth > element.clientWidth + 1).length,
    )
  expect(overflowingText).toBe(0)
}

function readTarget(rootDir: string, surfaceId: string) {
  const store = new Store({ rootDir })
  try {
    const surface = store.getSurface(surfaceId)
    const version = store.getSurfaceVersion(surfaceId)
    if (!surface || !version) throw new Error(`Missing target ${surfaceId}`)
    return { surface, treeVersion: version.treeVersion }
  } finally {
    store.close()
  }
}

function resolutionEvents(rootDir: string, proposalId: number): string[] {
  const store = new Store({ rootDir })
  try {
    return store
      .eventLog('spc-health')
      .filter(
        (event) =>
          event.payload?.['proposalId'] === proposalId &&
          ['surface.tree_proposal_accepted', 'surface.tree_proposal_rejected'].includes(event.type),
      )
      .map((event) => event.type)
  } finally {
    store.close()
  }
}
