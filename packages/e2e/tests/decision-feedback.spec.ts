import { openChat } from './chat-journey.ts'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { ChatTimeline } from '../../daemon/src/chat-timeline.ts'
import { pendingDecisionFeedback, type PendingDecision } from '../../protocol/src/index.ts'
import { expect, test } from './surface-contracts-fixture.ts'
import { ActionWire } from './fast-actions-journey.ts'

test.use({ viewport: { width: 320, height: 380 }, isMobile: true, hasTouch: true })

test('completed decision feedback wraps, expires and stays in Chat after reload', async ({
  page,
  surfaceStack,
}) => {
  const now = new Date()
  const decision: PendingDecision = {
    id: 'tree-proposal:999',
    kind: 'tree-proposal',
    scope: { type: 'space', spaceId: 'spc-health' },
    summary: `Change the “Bug da correggere a casa” Surface tree. ${'A complete readable outcome. '.repeat(12)}`,
    allowedResolutions: ['accept', 'reject'],
    state: 'terminal',
    outcome: 'accepted',
    createdAt: now.toISOString(),
    resolvedAt: now.toISOString(),
    resolvedBy: 'trusted:user',
  }
  recordDecision(surfaceStack.baseDir, decision)
  await page.clock.install({ time: now })
  await page.reload()
  const notice = page.locator('.pending-decision-feedback')
  await expect(notice).toContainText(pendingDecisionFeedback(decision))
  const geometry = await notice.evaluate((element) => ({
    scrollHeight: element.scrollHeight,
    clientHeight: element.clientHeight,
    scrollWidth: element.scrollWidth,
    clientWidth: element.clientWidth,
  }))
  expect(geometry.scrollHeight).toBeLessThanOrEqual(geometry.clientHeight + 1)
  expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth + 1)
  await page.clock.fastForward(9_000)
  await expect(notice).toHaveCount(0)
  await page.reload()
  await expect(notice).toHaveCount(0)
  await openChat(page)
  await page.clock.runFor(600)
  await expect(
    page.getByRole('log', { name: 'Conversation' }).getByText(pendingDecisionFeedback(decision), {
      exact: true,
    }),
  ).toBeVisible()
})

test('failure dismissal survives reload and reconnect, without hiding a new failure', async ({
  page,
  surfaceStack,
}) => {
  const now = new Date()
  const failed: PendingDecision = {
    id: 'tree-proposal:998',
    kind: 'tree-proposal',
    scope: { type: 'space', spaceId: 'spc-health' },
    summary: 'Change the Surface tree',
    allowedResolutions: ['accept', 'reject'],
    state: 'terminal',
    outcome: 'failed',
    createdAt: now.toISOString(),
    resolvedAt: now.toISOString(),
    resolvedBy: 'trusted:user',
  }
  recordDecision(surfaceStack.baseDir, failed)
  const wire = new ActionWire(page, [])
  await wire.install()
  await page.clock.install({ time: now })
  await page.reload()
  const notice = page.locator('.pending-decision-feedback')
  await expect(notice).toContainText(pendingDecisionFeedback(failed))
  await page.clock.fastForward(60_000)
  await expect(notice).toBeVisible()
  await notice.getByRole('button', { name: 'Dismiss decision feedback' }).click()
  await expect(notice).toHaveCount(0)
  await page.reload()
  await expect(page.locator('.app-shell')).toHaveAttribute('data-gateway-online', 'true')
  await expect(notice).toHaveCount(0)
  await wire.disconnect()
  await expect(page.locator('.app-shell')).toHaveAttribute('data-gateway-online', 'false')
  wire.disconnected = false
  await page.clock.runFor(3_000)
  await expect(page.locator('.app-shell')).toHaveAttribute('data-gateway-online', 'true')
  await expect(notice).toHaveCount(0)
  await openChat(page)
  await page.clock.runFor(600)
  await expect(
    page.getByRole('log', { name: 'Conversation' }).getByText(pendingDecisionFeedback(failed), {
      exact: true,
    }),
  ).toBeVisible()
  const next = { ...failed, id: 'tree-proposal:997', summary: 'Change the second Surface tree' }
  recordDecision(surfaceStack.baseDir, next)
  await page.reload()
  await expect(notice).toContainText(pendingDecisionFeedback(next))
})

test('long shell errors are readable and dismissible, and a later error still appears', async ({
  page,
  surfaceStack,
}) => {
  expect(surfaceStack.origin).toBeTruthy()
  const failure = `Pin is temporarily unavailable. ${'Keep this explanation readable. '.repeat(10)}`
  await page.route('**/api/surfaces/*/pin', (route) =>
    route.fulfill({ status: 503, json: { error: failure } }),
  )
  const main = page.getByRole('main')
  const pin = main.getByRole('button', { name: /^Pin / }).last()
  await pin.scrollIntoViewIfNeeded()
  await expect.poll(() => main.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
  await pin.focus()
  await pin.click()
  const error = page.locator('.shell-notice.error')
  await expect(error).toContainText(failure)
  await expect(pin).toBeFocused()
  const close = error.getByRole('button', { name: 'Dismiss error' })
  const closeBox = await close.boundingBox()
  const mainBox = await main.boundingBox()
  expect(closeBox!.y).toBeGreaterThanOrEqual(mainBox!.y)
  expect(closeBox!.y + closeBox!.height).toBeLessThanOrEqual(mainBox!.y + mainBox!.height)
  const geometry = await error.evaluate((element) => ({
    height: element.clientHeight,
    scrollHeight: element.scrollHeight,
    width: element.clientWidth,
    scrollWidth: element.scrollWidth,
  }))
  expect(geometry.scrollHeight).toBeLessThanOrEqual(geometry.height + 1)
  expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.width + 1)
  await close.click()
  await expect(error).toHaveCount(0)
  await pin.click()
  await expect(error).toContainText(failure)
})

function recordDecision(baseDir: string, decision: PendingDecision) {
  const timeline = new ChatTimeline(join(baseDir, 'data'))
  try {
    const turn = timeline.accept({
      submissionId: randomUUID(),
      scope: decision.scope,
      text: 'Review the proposed change.',
    })
    timeline.begin(turn.turnId)
    timeline.addDecision(turn.turnId, decision)
    timeline.completeWithDecisions(turn.turnId)
  } finally {
    timeline.close()
  }
}
