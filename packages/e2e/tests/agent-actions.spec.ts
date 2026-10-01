import type { Page } from '@playwright/test'
import { ActionIntentIdSchema, AgentActionResultSchema } from '../../protocol/src/index.ts'
import { AgentActionWire } from './agent-action-journey.ts'
import {
  AGENT_ACTION_SURFACE_ID,
  AGENT_ACTION_SURFACE_TITLE,
  createAgentActionSurface,
} from './agent-action-surface.ts'
import {
  authenticatedHeaders,
  latest,
  pairActionObserver,
  readEvents,
  readSurface,
  records,
  signal,
  surfaceCard,
} from './fast-actions-journey.ts'
import { expect, test } from './surface-contracts-fixture.ts'
import { startLocalVpsStack, type LocalVpsStack } from './stack.ts'

test('Agent controls execute through the shared loop and converge across authenticated sessions', async ({
  browser,
  page,
  surfaceStack,
}) => {
  test.setTimeout(5 * 60_000)
  createAgentActionSurface(surfaceStack.baseDir)
  const origin = surfaceStack.origin
  const observer = await pairActionObserver(browser, page, origin)
  const primaryWire = new AgentActionWire(page)
  const observerWire = new AgentActionWire(observer.page)
  const clients = [page, observer.page]
  const card = (client: Page) => surfaceCard(client, AGENT_ACTION_SURFACE_TITLE)
  const complete = (client: Page) =>
    card(client).getByRole('button', { name: 'Complete demo', exact: true })
  const expectRecords = async (count: number) => {
    for (const client of clients)
      await expect(card(client).getByRole('cell', { name: 'Completed', exact: true })).toHaveCount(
        count,
      )
  }
  let releasePending = () => {}
  let restarted: LocalVpsStack | undefined
  try {
    await primaryWire.install()
    await observerWire.install()
    await page.reload()
    await observer.page.goto(`${origin}/app/space/health`)
    for (const client of clients) {
      await expect(client.locator('.app-shell')).toHaveAttribute('data-gateway-online', 'true')
      await expect(card(client).getByText('Waiting', { exact: true })).toBeVisible()
    }
    await test.step('a rejected Agent write keeps canonical data unchanged and cannot publish its attempted success', async () => {
      const before = await readSurface(page, origin, AGENT_ACTION_SURFACE_ID)
      const button = card(page).getByRole('button', { name: 'Try rejected demo', exact: true })
      await button.click()
      const invocation = latest(primaryWire.requests).invocation
      expect(ActionIntentIdSchema.safeParse(invocation.idempotencyKey).success).toBe(true)
      const turn = await primaryWire.outcomeFor(invocation.idempotencyKey)
      expect(turn.status).toBe('failed')
      if (turn.status !== 'failed') throw new Error('Invalid authoring must fail the Agent turn')
      const alert = card(page).getByRole('alert')
      await expect(alert).toHaveText(turn.error)
      await expect(button).toBeEnabled()
      await expect(button).toHaveAttribute('aria-invalid', 'true')
      await expect(button).toHaveAttribute('aria-describedby', (await alert.getAttribute('id'))!)
      expect(await readSurface(page, origin, AGENT_ACTION_SURFACE_ID)).toEqual(before)
      await expectRecords(0)
      for (const client of clients) {
        await expect(card(client).getByText('Waiting', { exact: true })).toBeVisible()
        await expect(
          client
            .locator('.chat-entry.assistant')
            .filter({ hasText: 'The Agent action is complete.' }),
        ).toHaveCount(0)
      }
      expect(
        (await readEvents(page, origin)).filter(
          (event) =>
            event.type === 'surface.patch_state' &&
            event.payload?.['surfaceId'] === AGENT_ACTION_SURFACE_ID,
        ),
      ).toHaveLength(0)
      await page.reload()
      await expect(card(page).getByText('Waiting', { exact: true })).toBeVisible()
      await expect(page.locator('.app-shell')).toHaveAttribute('data-gateway-online', 'true')
    })

    await test.step('the control stays pending until canonical terminal completion and a later lost HTTP response is inert', async () => {
      const captured = signal<void>()
      const release = signal<void>()
      releasePending = () => release.resolve()
      primaryWire.holdUpdates = true
      primaryWire.interceptNext(async (route) => {
        const { turn } = await primaryWire.captureHttp(route)
        expect(turn.status).toBe('completed')
        captured.resolve()
        await release.promise
        await route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'The completed response was lost.' }),
        })
      })
      await complete(page).click()
      await captured.promise
      await expect(complete(page)).toBeDisabled()
      await expect(complete(page)).toHaveAttribute('aria-busy', 'true')
      await expect(card(page).getByRole('status')).toHaveText('Working…')
      await expect(card(page).getByText('Waiting', { exact: true })).toBeVisible()
      await expect(card(page).getByRole('cell', { name: 'Completed', exact: true })).toHaveCount(0)
      await expect(
        card(observer.page).getByRole('cell', { name: 'Completed', exact: true }),
      ).toHaveCount(1)
      const invocation = latest(primaryWire.requests).invocation
      expect(ActionIntentIdSchema.safeParse(invocation.idempotencyKey).success).toBe(true)
      expect((await primaryWire.outcomeFor(invocation.idempotencyKey)).status).toBe('completed')
      primaryWire.releaseUpdates()
      await expectRecords(1)
      await expect(complete(page)).toBeEnabled()
      const lost = page.waitForResponse(
        (response) =>
          response.url().endsWith(`/api/surfaces/${AGENT_ACTION_SURFACE_ID}/actions`) &&
          response.status() === 503,
      )
      release.resolve()
      await (await lost).finished()
      await expect(card(page).getByRole('alert')).toHaveCount(0)
      await expect(complete(page)).toBeEnabled()
      await expect(card(page).getByRole('status')).toHaveCount(0)
    })

    await test.step('a lost terminal response exposes a linked error and keyboard retry reuses the exact UUID and effect', async () => {
      primaryWire.holdUpdates = true
      primaryWire.interceptNext(async (route) => {
        const { turn } = await primaryWire.captureHttp(route)
        expect(turn.status).toBe('completed')
        await route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'Agent response lost. Try again.' }),
        })
      })
      await complete(page).click()
      const alert = card(page).getByRole('alert')
      await expect(alert).toHaveText('Agent response lost. Try again.')
      await expect(complete(page)).toBeEnabled()
      await expect(complete(page)).toHaveAttribute(
        'aria-describedby',
        (await alert.getAttribute('id'))!,
      )
      await expect(card(page).getByRole('cell', { name: 'Completed', exact: true })).toHaveCount(1)
      await expect(
        card(observer.page).getByRole('cell', { name: 'Completed', exact: true }),
      ).toHaveCount(2)
      const original = latest(primaryWire.requests).invocation
      const first = await primaryWire.outcomeFor(original.idempotencyKey)
      await complete(page).press('Enter')
      await expectRecords(2)
      await expect(card(page).getByRole('alert')).toHaveCount(0)
      await expect(complete(page)).toBeEnabled()
      const retried = latest(primaryWire.requests).invocation
      expect(retried).toEqual(original)
      const responses = primaryWire.outcomes.filter(
        (turn) => turn.idempotencyKey === original.idempotencyKey,
      )
      expect(responses).toHaveLength(2)
      expect(responses[1]).toEqual(first)
      primaryWire.releaseUpdates()
    })

    await test.step('a distinct authenticated keyboard gesture gets a new identity and both clients see one additional record', async () => {
      await expect(complete(observer.page)).toBeEnabled()
      await complete(observer.page).press('Space')
      await expectRecords(3)
      await expect(complete(observer.page)).toBeEnabled()
      const invocation = latest(observerWire.requests).invocation
      expect(ActionIntentIdSchema.safeParse(invocation.idempotencyKey).success).toBe(true)
      expect(
        primaryWire.requests.every(
          (request) => request.invocation.idempotencyKey !== invocation.idempotencyKey,
        ),
      ).toBe(true)
      expect(invocation.payload).toEqual({ request: 'Complete the Agent action demo' })
      expect((await observerWire.outcomeFor(invocation.idempotencyKey)).status).toBe('completed')
    })

    await test.step('reload, same-root Gateway restart, and authenticated replay preserve canonical identities without another turn', async () => {
      const expected = [
        { id: 'agent-demo-1', label: 'Completed' },
        { id: 'agent-demo-2', label: 'Completed' },
        { id: 'agent-demo-3', label: 'Completed' },
      ]
      expect(records(await readSurface(page, origin, AGENT_ACTION_SURFACE_ID), 'records')).toEqual(
        expected,
      )
      for (const client of clients) await client.reload()
      await expectRecords(3)
      await surfaceStack.stop()
      restarted = await startLocalVpsStack({
        port: surfaceStack.port,
        baseDir: surfaceStack.baseDir,
        legacyHome: surfaceStack.legacyHome,
      })
      await restarted.waitForReadyLine()
      for (const client of clients) await client.reload()
      await expectRecords(3)
      for (const client of clients) {
        await expect(complete(client)).toBeEnabled()
        await expect(card(client).getByRole('alert')).toHaveCount(0)
        await expect(card(client).locator('[data-veduta-atom-id="demo-result"]')).toContainText(
          'Completed',
        )
      }
      const invocation = latest(primaryWire.requests).invocation
      const original = await primaryWire.outcomeFor(invocation.idempotencyKey)
      const response = await observer.page.request.post(
        `${origin}/api/surfaces/${AGENT_ACTION_SURFACE_ID}/actions`,
        {
          headers: await authenticatedHeaders(observer.page),
          data: invocation,
        },
      )
      expect(response.status()).toBe(200)
      expect(AgentActionResultSchema.parse(await response.json()).turn).toEqual(original)
      const events = (await readEvents(page, origin)).filter(
        (event) => event.payload?.['surfaceId'] === AGENT_ACTION_SURFACE_ID,
      )
      expect(events.filter((event) => event.type === 'agent_path')).toHaveLength(4)
      expect(events.filter((event) => event.type === 'surface.patch_state')).toHaveLength(3)
      const turns = new Map(
        [...primaryWire.outcomes, ...observerWire.outcomes].map((turn) => [
          turn.idempotencyKey,
          turn,
        ]),
      )
      expect(turns.size).toBe(4)
      for (const [idempotencyKey, turn] of turns) {
        expect(ActionIntentIdSchema.safeParse(idempotencyKey).success).toBe(true)
        const requests = events.filter(
          (event) =>
            event.type === 'agent_path' && event.payload?.['idempotencyKey'] === idempotencyKey,
        )
        expect(requests).toHaveLength(1)
        expect(requests[0]?.payload?.['agentTurnId']).toBe(turn.id)
      }
      expect(
        records(await readSurface(observer.page, origin, AGENT_ACTION_SURFACE_ID), 'records'),
      ).toEqual(expected)
      await expectRecords(3)
    })
  } finally {
    releasePending()
    primaryWire.releaseUpdates()
    observerWire.releaseUpdates()
    await restarted?.stop()
    await observer.context.close()
  }
})
