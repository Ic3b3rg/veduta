import type { Page } from '@playwright/test'
import {
  ActionIntentIdSchema,
  FastActionOutcomeSchema,
  isControlDate,
  type JsonObject,
} from '../../protocol/src/index.ts'
import { expect, test } from './surface-contracts-fixture.ts'
import {
  ActionWire,
  authenticatedHeaders,
  committedOutcome,
  expectCommittedEvent,
  latest,
  pairActionObserver,
  readEvents,
  readSurface,
  records,
  signal,
  surfaceCard,
} from './fast-actions-journey.ts'
import {
  CONTROL_SURFACE_ID,
  CONTROL_SURFACE_TITLE,
  createControlSurface,
} from './control-surfaces.ts'

test('all five control families remain accessible and canonical across two sessions, retry, reload, and reconnect', async ({
  browser,
  page,
  surfaceStack,
}) => {
  test.setTimeout(5 * 60_000)
  createControlSurface(surfaceStack.baseDir)
  const origin = surfaceStack.origin
  const observer = await pairActionObserver(browser, page, origin)
  const primaryWire = new ActionWire(page, [CONTROL_SURFACE_ID])
  const observerWire = new ActionWire(observer.page, [CONTROL_SURFACE_ID])
  const clients = [page, observer.page]
  const card = (client: Page) => surfaceCard(client, CONTROL_SURFACE_TITLE)
  const intents = new Set<string>()
  let releasePending = () => {}

  const confirm = async (wire: ActionWire, nodeId: string, inputs: JsonObject) => {
    const request = latest(wire.requests.filter((request) => request.invocation.nodeId === nodeId))
    expect(ActionIntentIdSchema.safeParse(request.invocation.intentId).success).toBe(true)
    expect(request.invocation.inputs).toEqual(inputs)
    intents.add(request.invocation.intentId)
    const outcome = committedOutcome(await wire.outcomeFor(request.invocation.intentId))
    await expectCommittedEvent(page, origin, outcome)
    for (const client of clients) await expect(card(client).getByRole('alert')).toHaveCount(0)
    return request.invocation
  }

  try {
    await primaryWire.install()
    await observerWire.install()
    await page.reload()
    await observer.page.goto(`${origin}/app/space/health`)
    for (const client of clients) {
      await expect(client.locator('.app-shell')).toHaveAttribute('data-gateway-online', 'true')
      await expect(card(client)).toBeVisible()
    }

    await test.step('disabled semantics and visible labels exist for each family', async () => {
      for (const client of clients) {
        const controls = card(client)
        await expect(
          controls.getByRole('button', { name: 'Disabled Record entry', exact: true }),
        ).toBeDisabled()
        await expect(
          controls.getByRole('checkbox', { name: 'Disabled Enabled', exact: true }),
        ).toBeDisabled()
        await expect(
          controls.getByRole('combobox', { name: 'Disabled Priority', exact: true }),
        ).toBeDisabled()
        await expect(
          controls
            .getByRole('radiogroup', { name: 'Disabled Cadence', exact: true })
            .getByRole('radio'),
        ).toHaveCount(2)
        for (const radio of await controls
          .getByRole('radiogroup', { name: 'Disabled Cadence', exact: true })
          .getByRole('radio')
          .all())
          await expect(radio).toBeDisabled()
        await expect(controls.getByLabel('Disabled Date', { exact: true })).toBeDisabled()
        await expect(
          controls.getByRole('checkbox', { name: 'Enabled', exact: true }),
        ).not.toBeChecked()
        await expect(controls.getByRole('combobox', { name: 'Priority', exact: true })).toHaveValue(
          'low',
        )
        await expect(
          controls
            .getByRole('radiogroup', { name: 'Cadence', exact: true })
            .getByRole('radio', { name: 'Daily', exact: true }),
        ).toBeChecked()
        await expect(controls.getByLabel('Date', { exact: true })).toHaveValue('2026-10-01')
      }
    })

    await test.step('Button failure is linked and recoverable; pointer retry keeps its UUID and keyboard gets a fresh one', async () => {
      const button = card(page).getByRole('button', { name: 'Record entry', exact: true })
      primaryWire.interceptNext(async (route) => {
        await route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'Gateway unavailable. Try again.' }),
        })
      })
      await button.click()
      const failure = card(page).getByRole('alert')
      await expect(failure).toHaveText('Gateway unavailable. Try again.')
      await expect(button).toHaveAttribute('aria-invalid', 'true')
      await expect(button).toHaveAttribute('aria-describedby', (await failure.getAttribute('id'))!)
      await expect(button).toBeEnabled()
      await expect(card(page).getByRole('status')).toHaveCount(0)
      const failed = latest(primaryWire.requests).invocation
      expect(records(await readSurface(page, origin, CONTROL_SURFACE_ID), 'records')).toHaveLength(
        0,
      )
      expect(
        (await readEvents(page, origin)).filter(
          (event) => event.payload?.['intentId'] === failed.intentId,
        ),
      ).toHaveLength(0)

      await button.click()
      for (const client of clients)
        await expect(
          card(client).getByRole('table').getByText('Recorded', { exact: true }),
        ).toHaveCount(1)
      const retried = await confirm(primaryWire, 'record-control', {})
      expect(retried.intentId).toBe(failed.intentId)
      expect(
        primaryWire.requests.filter((request) => request.invocation.intentId === failed.intentId),
      ).toHaveLength(2)
      await card(observer.page)
        .getByRole('button', { name: 'Record entry', exact: true })
        .press('Enter')
      for (const client of clients)
        await expect(
          card(client).getByRole('table').getByText('Recorded', { exact: true }),
        ).toHaveCount(2)
      const fresh = await confirm(observerWire, 'record-control', {})
      expect(fresh.intentId).not.toBe(failed.intentId)
      const stored = records(await readSurface(page, origin, CONTROL_SURFACE_ID), 'records')
      expect(new Set(stored.map((record) => record['id'])).size).toBe(2)
    })

    await test.step('Checkbox pointer and Space keyboard gestures send booleans', async () => {
      await card(page).getByRole('checkbox', { name: 'Enabled', exact: true }).click()
      for (const client of clients)
        await expect(
          card(client).getByRole('checkbox', { name: 'Enabled', exact: true }),
        ).toBeChecked()
      await confirm(primaryWire, 'enabled-control', { value: true })
      await card(observer.page)
        .getByRole('checkbox', { name: 'Enabled', exact: true })
        .press('Space')
      for (const client of clients)
        await expect(
          card(client).getByRole('checkbox', { name: 'Enabled', exact: true }),
        ).not.toBeChecked()
      await confirm(observerWire, 'enabled-control', { value: false })
    })

    await test.step('Select pointer change displays only confirmed state and its keyboard selection converges', async () => {
      const select = card(page).getByRole('combobox', { name: 'Priority', exact: true })
      const committed = signal<void>()
      const release = signal<void>()
      releasePending = () => release.resolve()
      primaryWire.holdPatches = true
      primaryWire.interceptNext(async (route) => {
        const response = await route.fetch()
        expect(response.ok()).toBe(true)
        primaryWire.outcomes.push(FastActionOutcomeSchema.parse(await response.json()))
        committed.resolve()
        await release.promise
        await route.fulfill({ response })
      })
      await select.selectOption('high')
      await committed.promise
      await expect(select).toHaveValue('low')
      await expect(select).toBeDisabled()
      await expect(select).toHaveAttribute('aria-busy', 'true')
      await expect(card(page).getByRole('status')).toHaveText('Working…')
      await expect(
        card(observer.page).getByRole('combobox', { name: 'Priority', exact: true }),
      ).toHaveValue('high')
      release.resolve()
      await expect(select).toHaveValue('high')
      primaryWire.releasePatches()
      await confirm(primaryWire, 'priority-control', { value: 'high' })
      await card(observer.page).getByRole('combobox', { name: 'Priority', exact: true }).press('l')

      for (const client of clients)
        await expect(
          card(client).getByRole('combobox', { name: 'Priority', exact: true }),
        ).toHaveValue('low')
      await confirm(observerWire, 'priority-control', { value: 'low' })
    })

    await test.step('RadioGroup pointer and arrow-key navigation use offered identities', async () => {
      const group = (client: Page) =>
        card(client).getByRole('radiogroup', { name: 'Cadence', exact: true })
      await group(page).getByRole('radio', { name: 'Weekly', exact: true }).click()
      for (const client of clients)
        await expect(
          group(client).getByRole('radio', { name: 'Weekly', exact: true }),
        ).toBeChecked()
      await confirm(primaryWire, 'cadence-control', { value: 'weekly' })
      await group(observer.page)
        .getByRole('radio', { name: 'Weekly', exact: true })
        .press('ArrowLeft', { delay: 50 })
      for (const client of clients)
        await expect(group(client).getByRole('radio', { name: 'Daily', exact: true })).toBeChecked()
      await confirm(observerWire, 'cadence-control', { value: 'daily' })
    })

    await test.step('DatePicker normalizes calendar input and supports native keyboard editing and explicit empty dates', async () => {
      const date = card(page).getByLabel('Date', { exact: true })
      await date.click()
      await date.fill('2026-10-02')
      for (const client of clients)
        await expect(card(client).getByLabel('Date', { exact: true })).toHaveValue('2026-10-02')
      await confirm(primaryWire, 'date-control', { value: '2026-10-02' })
      const prior = observerWire.requests.length
      await card(observer.page).getByLabel('Date', { exact: true }).press('ArrowUp', { delay: 50 })
      await expect.poll(() => observerWire.requests.length).toBe(prior + 1)
      const keyboardDate = latest(observerWire.requests).invocation.inputs['value']
      expect(isControlDate(keyboardDate)).toBe(true)
      if (typeof keyboardDate !== 'string')
        throw new Error('DatePicker must submit a calendar string')
      expect(keyboardDate).not.toBe('2026-10-02')
      for (const client of clients)
        await expect(card(client).getByLabel('Date', { exact: true })).toHaveValue(keyboardDate)
      await confirm(observerWire, 'date-control', { value: keyboardDate })

      await card(page).getByLabel('Optional date', { exact: true }).fill('2024-02-29')
      for (const client of clients)
        await expect(card(client).getByLabel('Optional date', { exact: true })).toHaveValue(
          '2024-02-29',
        )
      await confirm(primaryWire, 'optional-date-control', { value: '2024-02-29' })
      await card(observer.page).getByLabel('Optional date', { exact: true }).fill('')
      for (const client of clients)
        await expect(card(client).getByLabel('Optional date', { exact: true })).toHaveValue('')
      await confirm(observerWire, 'optional-date-control', { value: '' })
    })

    await test.step('reload preserves every canonical control value and an idempotent replay adds no Event', async () => {
      const canonical = await readSurface(page, origin, CONTROL_SURFACE_ID)
      for (const client of clients) {
        await client.reload()
        await expect(client.locator('.app-shell')).toHaveAttribute('data-gateway-online', 'true')
        await expect(
          card(client).getByRole('table').getByText('Recorded', { exact: true }),
        ).toHaveCount(2)
        await expect(
          card(client).getByRole('checkbox', { name: 'Enabled', exact: true }),
        ).not.toBeChecked()
        await expect(
          card(client).getByRole('combobox', { name: 'Priority', exact: true }),
        ).toHaveValue('low')
        await expect(
          card(client)
            .getByRole('radiogroup', { name: 'Cadence', exact: true })
            .getByRole('radio', { name: 'Daily', exact: true }),
        ).toBeChecked()
        await expect(card(client).getByLabel('Date', { exact: true })).toHaveValue(
          String(canonical.state['date']),
        )
        await expect(card(client).getByLabel('Optional date', { exact: true })).toHaveValue('')
        expect((await readSurface(client, origin, CONTROL_SURFACE_ID)).state).toEqual(
          canonical.state,
        )
      }
      const first = primaryWire.requests.find(
        (request) => request.invocation.nodeId === 'record-control',
      )!
      const replayResponse = await page.request.post(
        `${origin}/api/surfaces/${CONTROL_SURFACE_ID}/actions`,
        { headers: await authenticatedHeaders(page), data: first.invocation },
      )
      expect(replayResponse.ok()).toBe(true)
      const replay = committedOutcome(FastActionOutcomeSchema.parse(await replayResponse.json()))
      expect(replay.duplicate).toBe(true)
      await expectCommittedEvent(page, origin, replay)
      expect((await readSurface(page, origin, CONTROL_SURFACE_ID)).state).toEqual(canonical.state)
    })

    await test.step('a missed checkbox mutation reconciles after reconnect without reloading', async () => {
      await observerWire.disconnect()
      await expect(observer.page.locator('.app-shell')).toHaveAttribute(
        'data-gateway-online',
        'false',
      )
      await card(page).getByRole('checkbox', { name: 'Enabled', exact: true }).press('Space')
      await expect(card(page).getByRole('checkbox', { name: 'Enabled', exact: true })).toBeChecked()
      await expect(
        card(observer.page).getByRole('checkbox', { name: 'Enabled', exact: true }),
      ).not.toBeChecked()
      await confirm(primaryWire, 'enabled-control', { value: true })
      observerWire.disconnected = false
      await expect(observer.page.locator('.app-shell')).toHaveAttribute(
        'data-gateway-online',
        'true',
      )
      await expect(
        card(observer.page).getByRole('checkbox', { name: 'Enabled', exact: true }),
      ).toBeChecked()
    })

    const events = (await readEvents(page, origin)).filter(
      (event) => event.type === 'fast_path' && event.payload?.['surfaceId'] === CONTROL_SURFACE_ID,
    )
    expect(intents.size).toBe(13)
    expect(events).toHaveLength(13)
    expect(new Set(events.map((event) => event.payload?.['intentId']))).toEqual(intents)
    expect(new Set(events.map((event) => event.payload?.['surfaceCommitId'])).size).toBe(13)
    expect((await readSurface(observer.page, origin, CONTROL_SURFACE_ID)).state).toEqual(
      (await readSurface(page, origin, CONTROL_SURFACE_ID)).state,
    )
  } finally {
    releasePending()
    primaryWire.releasePatches()
    await observer.context.close()
  }
})
