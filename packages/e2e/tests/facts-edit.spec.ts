import {
  FACTS_CORRECTION_REQUEST,
  FACTS_REMEMBER_REQUEST,
  SPACE_PURPOSE_REQUEST,
} from '../../daemon/src/mock-facts-fixture.ts'
import { pairActionObserver, readEvents, surfaceCard } from './fast-actions-journey.ts'
import { AgentActionWire } from './agent-action-journey.ts'
import { expect, test } from './surface-contracts-fixture.ts'

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })

test('Edit facts clarifies, corrects through Chat and keeps the projection after reconnect and reload', async ({
  page,
  browser,
  surfaceStack,
}) => {
  test.setTimeout(5 * 60_000)
  const wire = new AgentActionWire(page)
  await wire.install()
  await page.reload()
  const observer = await pairActionObserver(browser, page, surfaceStack.origin)
  try {
    await observer.page.goto(`${surfaceStack.origin}/app/space/health`)
    const observedFacts = surfaceCard(observer.page, 'What I know about you here')
    const facts = surfaceCard(page, 'What I know about you here')
    const composer = page.getByRole('textbox', { name: 'Message Veduta in Health' })
    const conversation = page.getByRole('log', { name: 'Conversation' })
    const send = async (text: string) => {
      await composer.fill(text)
      await page.getByRole('button', { name: 'Send message' }).tap()
      await expect(composer).toHaveValue('')
    }
    await send(FACTS_REMEMBER_REQUEST)
    await expect(facts.getByText(/^- I dislike celery \(noted:/)).toBeVisible()
    await expect(observedFacts.getByText(/^- I dislike celery \(noted:/)).toBeVisible()
    const writesBefore = (await readEvents(page, surfaceStack.origin)).filter(
      (event) => event.type === 'fact.write',
    )
    await facts.getByRole('button', { name: 'Edit facts', exact: true }).tap()
    await expect(
      conversation.getByText('Which fact would you like to correct, and what should it say?', {
        exact: true,
      }),
    ).toBeVisible()
    await expect(facts.getByRole('alert')).toHaveCount(0)
    expect(
      (await readEvents(page, surfaceStack.origin)).filter((event) => event.type === 'fact.write'),
    ).toEqual(writesBefore)
    await send(FACTS_CORRECTION_REQUEST)
    await expect(facts.getByText(/^- I like celery now \(noted:/)).toBeVisible()
    await expect(observedFacts.getByText(/^- I like celery now \(noted:/)).toBeVisible()
    await expect(facts.getByText(/^- I dislike celery \(noted:/)).toHaveCount(0)
    await expect(
      conversation.getByText('Remembered in “Health”: I like celery now', { exact: true }),
    ).toBeVisible()
    expect(
      (await readEvents(page, surfaceStack.origin)).filter((event) => event.type === 'fact.write'),
    ).toHaveLength(writesBefore.length + 1)

    await wire.disconnect()
    await expect(page.locator('.app-shell')).toHaveAttribute('data-gateway-online', 'false')
    wire.disconnected = false
    await expect(page.locator('.app-shell')).toHaveAttribute('data-gateway-online', 'true')
    await expect(facts.getByText(/^- I like celery now \(noted:/)).toBeVisible()
    await page.reload()
    await expect(page.locator('.app-shell')).toHaveAttribute('data-gateway-online', 'true')
    await expect(facts.getByText(/^- I like celery now \(noted:/)).toBeVisible()
    await expect(
      conversation.getByText('Remembered in “Health”: I like celery now', { exact: true }),
    ).toBeVisible()
    await send(FACTS_CORRECTION_REQUEST)
    await expect(conversation.getByText(/^A FACTS change was not saved:/)).toBeVisible()
    await expect(facts.getByText(/^- I like celery now \(noted:/)).toBeVisible()
    expect(
      (await readEvents(page, surfaceStack.origin)).filter((event) => event.type === 'fact.write'),
    ).toHaveLength(writesBefore.length + 1)
    await page.reload()
    await expect(conversation.getByText(/^A FACTS change was not saved:/)).toBeVisible()
  } finally {
    await observer.context.close()
  }
})

test('remembering the Space purpose confirms memory on both devices without authoring content', async ({
  page,
  browser,
  surfaceStack,
}) => {
  const observer = await pairActionObserver(browser, page, surfaceStack.origin)
  try {
    await observer.page.goto(`${surfaceStack.origin}/app/space/health`)
    const before = await readEvents(page, surfaceStack.origin)
    const composer = page.getByRole('textbox', { name: 'Message Veduta in Health' })
    await composer.fill(SPACE_PURPOSE_REQUEST)
    await page.getByRole('button', { name: 'Send message' }).tap()
    const confirmation = `Remembered in “Health”: ${SPACE_PURPOSE_REQUEST}`
    await expect(
      page.getByRole('log', { name: 'Conversation' }).getByText(confirmation, { exact: true }),
    ).toBeVisible()
    for (const device of [page, observer.page]) {
      const facts = surfaceCard(device, 'What I know about you here')
      await expect(
        facts.getByText(`- ${SPACE_PURPOSE_REQUEST} (noted:`, { exact: false }),
      ).toBeVisible()
      await device.reload()
      await expect(
        facts.getByText(`- ${SPACE_PURPOSE_REQUEST} (noted:`, { exact: false }),
      ).toBeVisible()
      await expect(
        device.getByRole('log', { name: 'Conversation' }).getByText(confirmation, { exact: true }),
      ).toBeVisible()
    }
    const after = await readEvents(page, surfaceStack.origin)
    const surfaceEvents = (events: typeof before) =>
      events.filter((event) => event.type.startsWith('surface.'))
    expect(surfaceEvents(after)).toEqual(surfaceEvents(before))
    expect(after.filter((event) => event.type === 'fact.write')).toHaveLength(
      before.filter((event) => event.type === 'fact.write').length + 1,
    )
  } finally {
    await observer.context.close()
  }
})
