import { AgentActionQueueFullResponseSchema } from '../../protocol/src/index.ts'
import { AgentActionWire } from './agent-action-journey.ts'
import {
  AGENT_ACTION_SURFACE_ID,
  AGENT_ACTION_SURFACE_TITLE,
  createAgentActionSurface,
} from './agent-action-surface.ts'
import { fillAgentQueue, releaseAgentQueue } from './agent-queue-data.ts'
import { latest, readEvents, readSurface, surfaceCard } from './fast-actions-journey.ts'
import { expect, test } from './surface-contracts-fixture.ts'

test('a full Space shows a recoverable refusal and retries once after capacity is released', async ({
  page,
  surfaceStack,
}) => {
  createAgentActionSurface(surfaceStack.baseDir)
  const turns = fillAgentQueue(surfaceStack.baseDir)
  const wire = new AgentActionWire(page)
  await wire.install()
  await page.reload()
  const card = surfaceCard(page, AGENT_ACTION_SURFACE_TITLE)
  const button = card.getByRole('button', { name: 'Complete demo', exact: true })
  await expect(button).toBeVisible()
  const before = await readSurface(page, surfaceStack.origin, AGENT_ACTION_SURFACE_ID)
  const events = await readEvents(page, surfaceStack.origin)
  const refused = page.waitForResponse((response) =>
    response.url().endsWith(`/${AGENT_ACTION_SURFACE_ID}/actions`),
  )
  wire.interceptNext(async (route) => {
    const response = await route.fetch()
    await route.fulfill({ response })
  })
  await button.click()
  const response = await refused
  expect(response.status()).toBe(429)
  const error = AgentActionQueueFullResponseSchema.parse(await response.json())
  await expect(card.getByRole('alert')).toHaveText(error.error)
  await expect(button).toBeEnabled()
  await expect(button).toHaveAttribute('aria-invalid', 'true')
  await expect(button).toHaveAttribute(
    'aria-describedby',
    (await card.getByRole('alert').getAttribute('id'))!,
  )
  const original = latest(wire.requests).invocation
  expect(await readSurface(page, surfaceStack.origin, AGENT_ACTION_SURFACE_ID)).toEqual(before)
  expect(await readEvents(page, surfaceStack.origin)).toEqual(events)
  releaseAgentQueue(surfaceStack.baseDir, turns)
  await button.press('Enter')
  const completed = await wire.outcomeFor(original.idempotencyKey)
  expect(completed.status).toBe('completed')
  expect(latest(wire.requests).invocation.idempotencyKey).toBe(original.idempotencyKey)
  await expect(card.getByRole('cell', { name: 'Completed', exact: true })).toHaveCount(1)
  await expect(card.getByRole('alert')).toHaveCount(0)
  await page.reload()
  await expect(card.getByRole('cell', { name: 'Completed', exact: true })).toHaveCount(1)
  await expect(card.getByRole('alert')).toHaveCount(0)
  const after = (await readEvents(page, surfaceStack.origin)).filter(
    (event) => event.type === 'agent_path',
  )
  expect(after).toHaveLength(turns.length + 1)
})
