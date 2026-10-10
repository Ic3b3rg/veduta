import type { Page } from '@playwright/test'
import { openChat, closeChat } from './chat-journey.ts'
import {
  FACTS_CORRECTION_REQUEST,
  FACTS_REMEMBER_REQUEST,
  SPACE_PURPOSE_REQUEST,
} from '../../daemon/src/mock-facts-fixture.ts'
import { pairActionObserver, readEvents } from './fast-actions-journey.ts'
import { AgentActionWire } from './agent-action-journey.ts'
import { expect, test } from './surface-contracts-fixture.ts'

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })

async function openMemory(page: Page, origin: string) {
  await page.goto(`${origin}/app/connections?section=spaces&space=spc-health`)
  await expect(page.getByRole('region', { name: 'Facts', exact: true })).toBeVisible()
}

async function sendFact(page: Page, origin: string, text: string) {
  await page.goto(`${origin}/app/space/health`)
  await openChat(page)
  const composer = page.getByRole('textbox', { name: 'Message Veduta in Health' })
  await composer.fill(text)
  await page.getByRole('button', { name: 'Send message' }).tap()
  await expect(composer).toHaveValue('')
}

test('Chat corrections update Settings on both devices and survive reconnect and reload', async ({
  page,
  browser,
  surfaceStack,
}) => {
  test.setTimeout(5 * 60_000)
  const wire = new AgentActionWire(page)
  await wire.install()
  await page.reload()
  const observer = await pairActionObserver(browser, page, surfaceStack.origin)
  const conversation = page.getByRole('log', { name: 'Conversation' })
  try {
    await openMemory(observer.page, surfaceStack.origin)
    const observedFacts = observer.page.getByRole('region', { name: 'Facts', exact: true })
    await sendFact(page, surfaceStack.origin, FACTS_REMEMBER_REQUEST)
    await expect(
      conversation.getByText('Remembered in “Health”: I dislike celery', { exact: true }),
    ).toBeVisible()
    await expect(observedFacts.getByText('I dislike celery', { exact: true })).toBeVisible()
    const writesBefore = (await readEvents(page, surfaceStack.origin)).filter(
      (event) => event.type === 'fact.write',
    )

    await sendFact(page, surfaceStack.origin, FACTS_CORRECTION_REQUEST)
    await expect(
      conversation.getByText('Remembered in “Health”: I like celery now', { exact: true }),
    ).toBeVisible()
    await expect(observedFacts.getByText('I like celery now', { exact: true })).toBeVisible()
    await expect(
      observedFacts.locator('.space-fact-row').getByText('I dislike celery', { exact: true }),
    ).toHaveCount(0)
    expect(
      (await readEvents(page, surfaceStack.origin)).filter((event) => event.type === 'fact.write'),
    ).toHaveLength(writesBefore.length + 1)

    await wire.disconnect()
    await expect(page.locator('.app-shell')).toHaveAttribute('data-gateway-online', 'false')
    wire.disconnected = false
    await expect(page.locator('.app-shell')).toHaveAttribute('data-gateway-online', 'true')
    await closeChat(page)
    await expect(
      page.getByRole('button', { name: 'Focus What I know about you here', exact: true }),
    ).toHaveCount(0)
    // Bookmarks and outcome links to daemon-owned management Surfaces follow their new home.
    await page.goto(`${surfaceStack.origin}/app/space/health/surface/srf-health-facts`)
    await expect(page).toHaveURL(
      `${surfaceStack.origin}/app/connections?section=spaces&space=spc-health`,
    )
    const facts = page.getByRole('region', { name: 'Facts', exact: true })
    await expect(facts.getByText('I like celery now', { exact: true })).toBeVisible()
    await page.reload()
    await expect(facts.getByText('I like celery now', { exact: true })).toBeVisible()
    await sendFact(page, surfaceStack.origin, FACTS_CORRECTION_REQUEST)
    await expect(conversation.getByText(/^A FACTS change was not saved:/)).toBeVisible()
    expect(
      (await readEvents(page, surfaceStack.origin)).filter((event) => event.type === 'fact.write'),
    ).toHaveLength(writesBefore.length + 1)
    await page.reload()
    await openChat(page)
    await expect(conversation.getByText(/^A FACTS change was not saved:/)).toBeVisible()
    await openMemory(page, surfaceStack.origin)
    await expect(facts.getByText('I like celery now', { exact: true })).toBeVisible()
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
    await openMemory(observer.page, surfaceStack.origin)
    const before = await readEvents(page, surfaceStack.origin)
    await sendFact(page, surfaceStack.origin, SPACE_PURPOSE_REQUEST)
    const confirmation = `Remembered in “Health”: ${SPACE_PURPOSE_REQUEST}`
    await expect(
      page.getByRole('log', { name: 'Conversation' }).getByText(confirmation, { exact: true }),
    ).toBeVisible()
    await expect(
      observer.page
        .getByRole('region', { name: 'Facts', exact: true })
        .getByText(SPACE_PURPOSE_REQUEST, { exact: true }),
    ).toBeVisible()
    for (const device of [page, observer.page]) {
      await openMemory(device, surfaceStack.origin)
      const facts = device.getByRole('region', { name: 'Facts', exact: true })
      await expect(facts.getByText(SPACE_PURPOSE_REQUEST, { exact: true })).toBeVisible()
      await device.reload()
      await expect(facts.getByText(SPACE_PURPOSE_REQUEST, { exact: true })).toBeVisible()
      await device.goto(`${surfaceStack.origin}/app/space/health`)
      await openChat(device)
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
