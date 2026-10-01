import type { Page } from '@playwright/test'
import { ActionIntentIdSchema, type JsonObject } from '../../protocol/src/index.ts'
import {
  ACTION_CONTROL_SURFACE_ID,
  ACTION_CONTROL_SURFACE_TITLE,
  createActionControlSurface,
} from './action-control-surface.ts'
import {
  ActionWire,
  committedOutcome,
  expectCommittedEvent,
  latest,
  pairActionObserver,
  readEvents,
  readSurface,
  records,
} from './fast-actions-journey.ts'
import { expect, test } from './surface-contracts-fixture.ts'

test('remaining action owners expose recoverable canonical controls across two sessions and reload', async ({
  browser,
  page,
  surfaceStack,
}) => {
  test.setTimeout(3 * 60_000)
  createActionControlSurface(surfaceStack.baseDir)
  const origin = surfaceStack.origin
  const observer = await pairActionObserver(browser, page, origin)
  const wire = new ActionWire(page, [ACTION_CONTROL_SURFACE_ID])
  const clients = [page, observer.page]
  // The open Combobox makes sibling controls inaccessible while its popup owns focus.
  const card = (client: Page) =>
    client.locator('article.surface-card').filter({
      has: client.getByRole('button', {
        name: `Focus ${ACTION_CONTROL_SURFACE_TITLE}`,
        exact: true,
        includeHidden: true,
      }),
    })
  const intents = new Set<string>()

  const failNext = () =>
    wire.interceptNext(async (route) => {
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Gateway unavailable. Try again.' }),
      })
    })
  const confirm = async (nodeId: string, inputs: JsonObject) => {
    const request = latest(wire.requests.filter((request) => request.invocation.nodeId === nodeId))
    expect(ActionIntentIdSchema.safeParse(request.invocation.intentId).success).toBe(true)
    expect(request.invocation.inputs).toEqual(inputs)
    intents.add(request.invocation.intentId)
    await expectCommittedEvent(
      page,
      origin,
      committedOutcome(await wire.outcomeFor(request.invocation.intentId)),
    )
    for (const client of clients) await expect(card(client).getByRole('alert')).toHaveCount(0)
    return request.invocation
  }

  try {
    await wire.install()
    await page.reload()
    await observer.page.goto(`${origin}/app/space/health`)
    for (const client of clients) {
      await expect(client.locator('.app-shell')).toHaveAttribute('data-gateway-online', 'true')
      await expect(card(client)).toBeVisible()
    }

    await test.step('Switch exposes a linked error and its keyboard retry retains the intent', async () => {
      const control = card(page).getByRole('switch', { name: 'Quiet hours', exact: true })
      failNext()
      await control.click()
      const alert = card(page).getByRole('alert')
      await expect(alert).toHaveText('Gateway unavailable. Try again.')
      await expect(control).toHaveAttribute('aria-describedby', (await alert.getAttribute('id'))!)
      await expect(control).not.toBeChecked()
      await expect(control).toBeEnabled()
      const failed = latest(wire.requests).invocation
      await control.press('Space')
      for (const client of clients)
        await expect(
          card(client).getByRole('switch', { name: 'Quiet hours', exact: true }),
        ).toBeChecked()
      const retried = await confirm('quiet-control', { value: true })
      expect(retried.intentId).toBe(failed.intentId)
    })

    await test.step('Combobox search is local and an offered keyboard retry restores canonical selection', async () => {
      const control = card(page).getByRole('combobox', { name: 'City', exact: true })
      const before = wire.requests.length
      await control.fill('Mil')
      await expect(control).toHaveValue('Mil')
      expect(wire.requests).toHaveLength(before)
      failNext()
      await page.getByRole('option', { name: 'Milan', exact: true }).click()
      await expect(card(page).getByRole('alert')).toHaveText('Gateway unavailable. Try again.')
      await expect(control).toHaveValue('Rome')
      await expect(control).toBeEnabled()
      const failed = latest(wire.requests).invocation
      await control.fill('Mil')
      await page.getByRole('option', { name: 'Milan', exact: true }).waitFor()
      await control.press('ArrowDown')
      await control.press('Enter')
      for (const client of clients)
        await expect(card(client).getByRole('combobox', { name: 'City', exact: true })).toHaveValue(
          'Milan',
        )
      const retried = await confirm('city-control', { value: 'mi' })
      expect(retried.intentId).toBe(failed.intentId)
    })

    await test.step('an unbound ListItem consumes background confirmation and a fresh identical command creates another record', async () => {
      const control = card(page).getByRole('button', { name: /Record entry/ })
      failNext()
      await control.click()
      await expect(card(page).getByRole('alert')).toHaveText('Gateway unavailable. Try again.')
      await expect(control).toBeEnabled()
      const failed = latest(wire.requests).invocation
      expect(
        records(await readSurface(page, origin, ACTION_CONTROL_SURFACE_ID), 'records'),
      ).toEqual([])
      await wire.disconnect()
      await expect(page.locator('.app-shell')).toHaveAttribute('data-gateway-online', 'false')
      wire.disconnected = false
      await expect(page.locator('.app-shell')).toHaveAttribute('data-gateway-online', 'true')
      for (const client of clients)
        await expect(
          card(client).getByRole('table').getByText('Saved', { exact: true }),
        ).toHaveCount(1)
      const recovered = await confirm('entry-control', {})
      expect(recovered.intentId).toBe(failed.intentId)
      await expect(control).toBeEnabled()
      await expect(control).not.toHaveAttribute('aria-invalid', 'true')
      await control.press('Enter')
      for (const client of clients)
        await expect(
          card(client).getByRole('table').getByText('Saved', { exact: true }),
        ).toHaveCount(2)
      const fresh = await confirm('entry-control', {})
      expect(fresh.intentId).not.toBe(failed.intentId)
      const saved = records(await readSurface(page, origin, ACTION_CONTROL_SURFACE_ID), 'records')
      expect(new Set(saved.map((record) => record['id'])).size).toBe(2)
    })

    await test.step('Automation keyboard and pointer toggles display only canonical enabled state', async () => {
      const control = card(page).getByRole('switch', { name: 'Example rule', exact: true })
      await control.press('Space')
      for (const client of clients)
        await expect(
          card(client).getByRole('switch', { name: 'Example rule', exact: true }),
        ).not.toBeChecked()
      await confirm('rule-control', { value: false })
      await expect(control).toBeEnabled()
      await control.click()
      for (const client of clients)
        await expect(
          card(client).getByRole('switch', { name: 'Example rule', exact: true }),
        ).toBeChecked()
      await confirm('rule-control', { value: true })
    })

    await test.step('reload preserves both records and all confirmed values without stale errors', async () => {
      for (const client of clients) {
        await client.reload()
        await expect(client.locator('.app-shell')).toHaveAttribute('data-gateway-online', 'true')
        await expect(
          card(client).getByRole('switch', { name: 'Quiet hours', exact: true }),
        ).toBeChecked()
        await expect(
          card(client).getByRole('switch', { name: 'Example rule', exact: true }),
        ).toBeChecked()
        await expect(card(client).getByRole('combobox', { name: 'City', exact: true })).toHaveValue(
          'Milan',
        )
        await expect(
          card(client).getByRole('table').getByText('Saved', { exact: true }),
        ).toHaveCount(2)
        await expect(card(client).getByRole('alert')).toHaveCount(0)
      }
      expect((await readSurface(observer.page, origin, ACTION_CONTROL_SURFACE_ID)).state).toEqual(
        (await readSurface(page, origin, ACTION_CONTROL_SURFACE_ID)).state,
      )
    })

    const events = (await readEvents(page, origin)).filter(
      (event) =>
        event.type === 'fast_path' && event.payload?.['surfaceId'] === ACTION_CONTROL_SURFACE_ID,
    )
    expect(intents.size).toBe(6)
    expect(events).toHaveLength(6)
    expect(new Set(events.map((event) => event.payload?.['intentId']))).toEqual(intents)
    expect(new Set(events.map((event) => event.payload?.['surfaceCommitId'])).size).toBe(6)
  } finally {
    await observer.context.close()
  }
})
