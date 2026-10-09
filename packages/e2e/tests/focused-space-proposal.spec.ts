import { PendingDecisionListSchema } from '../../protocol/src/index.ts'
import { authenticatedHeaders, readSurfaceSnapshot } from './fast-actions-journey.ts'
import { expect, test } from './surface-contracts-fixture.ts'

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })

test('focused Chat proposes, rejects and accepts a new Space without leaving the current Space', async ({
  page,
  surfaceStack,
}) => {
  test.setTimeout(5 * 60_000)
  const origin = surfaceStack.origin
  const composer = page.getByRole('textbox', { name: 'Message Veduta in Health' })
  const chat = page.getByRole('log', { name: 'Conversation' })
  const before = await readSurfaceSnapshot(page, origin)
  const beforeIds = before.spaces.map((space) => space.id)
  const route = page.url()
  const requestProposal = async () => {
    await composer.fill('crea uno Space Lavoro')
    await page.getByRole('button', { name: 'Send message' }).tap()
    await expect(chat.getByRole('button', { name: 'Accept Create Space “Lavoro”' })).toBeVisible()
    const snapshot = await readSurfaceSnapshot(page, origin)
    expect(snapshot.spaces.map((space) => space.id)).toEqual(beforeIds)
    expect(page.url()).toBe(route)
  }

  await requestProposal()
  await chat.getByRole('button', { name: 'Reject Create Space “Lavoro”' }).tap()
  await expect(chat.getByText('Rejected: Create Space “Lavoro”.', { exact: true })).toBeVisible()
  expect((await readSurfaceSnapshot(page, origin)).spaces.map((space) => space.id)).toEqual(
    beforeIds,
  )
  expect(page.url()).toBe(route)

  await requestProposal()
  await page.reload()
  await expect(chat.getByRole('button', { name: 'Accept Create Space “Lavoro”' })).toBeVisible()
  await expect(composer).toBeVisible()
  const decisionsResponse = await page.request.get(`${origin}/api/pending-decisions`, {
    headers: await authenticatedHeaders(page),
  })
  const decisions = PendingDecisionListSchema.parse(await decisionsResponse.json()).decisions
  const proposal = decisions.find(
    (decision) => decision.kind === 'space-proposal' && decision.state === 'pending',
  )
  if (!proposal) throw new Error('The focused proposal was not persisted')
  await chat.getByRole('button', { name: 'Accept Create Space “Lavoro”' }).tap()
  await expect(
    page.getByRole('complementary', { name: 'Spaces' }).getByRole('button', { name: /Lavoro/ }),
  ).toHaveCount(1)
  await expect(chat.getByText('Accepted: Create Space “Lavoro”.', { exact: true })).toBeVisible()
  const accepted = await readSurfaceSnapshot(page, origin)
  const created = accepted.spaces.filter((space) => space.name === 'Lavoro')
  expect(created).toHaveLength(1)
  expect(accepted.spaces).toHaveLength(before.spaces.length + 1)
  // FACTS and Automation management are Gateway projections; acceptance authors no content.
  expect(created[0]?.surfaces.filter((surface) => surface.freshness.updatedBy === 'agent')).toEqual(
    [],
  )
  expect(page.url()).toBe(route)
  await expect(composer).toBeVisible()

  const replay = await page.request.post(
    `${origin}/api/pending-decisions/${encodeURIComponent(proposal.id)}/resolve`,
    {
      headers: await authenticatedHeaders(page),
      data: { resolution: 'accept' },
    },
  )
  expect(replay.ok()).toBe(true)
  expect((await readSurfaceSnapshot(page, origin)).spaces.map((space) => space.id)).toEqual(
    accepted.spaces.map((space) => space.id),
  )
  await page.reload()
  await expect(composer).toBeVisible()
  await expect(chat.getByRole('button', { name: 'Accept Create Space “Lavoro”' })).toHaveCount(0)
  expect(page.url()).toBe(route)
})
