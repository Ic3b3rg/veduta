import { ActionIntentIdSchema, FastActionOutcomeSchema } from '../../protocol/src/index.ts'
import { expect, test } from './surface-contracts-fixture.ts'
import {
  ActionWire,
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
  createFastActionSurfaces,
  ITEM_SURFACE_ID,
  MEASUREMENT_SURFACE_ID,
  SEED_ITEM_ID,
} from './fast-action-surfaces.ts'
import { startLocalVpsStack, type LocalVpsStack } from './stack.ts'

test('generic fast Action batches converge across retries, concurrent devices, reconnect, and Gateway restart', async ({
  browser,
  page,
  surfaceStack,
}) => {
  test.setTimeout(5 * 60_000)
  createFastActionSurfaces(surfaceStack.baseDir)
  const observer = await pairActionObserver(browser, page, surfaceStack.origin)
  const primaryWire = new ActionWire(page)
  const observerWire = new ActionWire(observer.page)
  let restarted: LocalVpsStack | undefined
  let releaseStalledHttp = () => {}
  try {
    await primaryWire.install()
    await observerWire.install()
    await page.reload()
    await observer.page.goto(`${surfaceStack.origin}/app/space/health`)
    for (const client of [page, observer.page]) {
      await expect(client.locator('.app-shell')).toHaveAttribute('data-gateway-online', 'true')
      await expect(surfaceCard(client, 'Item collection')).toBeVisible()
      await expect(surfaceCard(client, 'Measurement log')).toBeVisible()
    }

    await test.step('append, set, and clear stay pending until HTTP confirmation, then live delivery converges', async () => {
      const measurement = surfaceCard(page, 'Measurement log')
      const form = measurement.getByRole('form', { name: 'Record measurement' })
      const draft = form.getByRole('spinbutton', { name: 'New measurement' })
      const committed = signal<void>()
      const releaseHttp = signal<void>()
      primaryWire.holdPatches = true
      observerWire.holdPatches = true
      primaryWire.interceptNext(async (route) => {
        const response = await route.fetch()
        const outcome = FastActionOutcomeSchema.parse(await response.json())
        expect(outcome.outcome).toBe('committed')
        primaryWire.outcomes.push(outcome)
        committed.resolve()
        await releaseHttp.promise
        await route.fulfill({ response })
      })
      await draft.fill('42.5')
      await form.getByRole('button', { name: 'Record measurement' }).click()
      await committed.promise
      await expect(form).toHaveAttribute('aria-busy', 'true')
      await expect(draft).toBeDisabled()
      await expect(draft).toHaveValue('42.5')
      for (const client of [page, observer.page]) {
        const surface = surfaceCard(client, 'Measurement log')
        await expect(surface.getByRole('table', { name: 'Measurements' })).toContainText(
          'No records yet',
        )
        await expect(
          surface
            .locator('[data-veduta-atom-id="current-measurement"]')
            .getByText('0', { exact: true }),
        ).toBeVisible()
      }
      const canonical = await readSurface(page, surfaceStack.origin, MEASUREMENT_SURFACE_ID)
      expect(canonical.state).toEqual({
        currentValue: 42.5,
        draftValue: '',
        records: [{ id: expect.any(String), value: 42.5, recordedAt: expect.any(String) }],
      })
      const outcome = committedOutcome(
        await primaryWire.outcomeFor(latest(primaryWire.requests).invocation.intentId),
      )
      expect(outcome.patch.operations.map((operation) => operation.path)).toEqual([
        '/records',
        '/currentValue',
        '/draftValue',
      ])
      const record = latest(records(canonical, 'records'))
      expect(record['id']).toMatch(/\S+/)
      expect(new Date(String(record['recordedAt'])).toISOString()).toBe(record['recordedAt'])
      await expect(
        surfaceCard(observer.page, 'Measurement log').getByRole('spinbutton', {
          name: 'New measurement',
        }),
      ).toHaveValue('7.5')
      releaseHttp.resolve()
      await expect(draft).toHaveValue('')
      await expect(form).not.toHaveAttribute('aria-busy', 'true')
      await expect(measurement.getByRole('cell', { name: '42.5', exact: true })).toBeVisible()
      await expect(
        measurement
          .locator('[data-veduta-atom-id="current-measurement"]')
          .getByText('42.5', { exact: true }),
      ).toBeVisible()
      primaryWire.releasePatches()
      observerWire.releasePatches()
      await expect(
        surfaceCard(observer.page, 'Measurement log').getByRole('cell', {
          name: '42.5',
          exact: true,
        }),
      ).toBeVisible()
      await expectCommittedEvent(page, surfaceStack.origin, outcome)
    })

    await test.step('retryable failure preserves the local draft and retries the same UUID exactly once', async () => {
      const form = surfaceCard(page, 'Item collection').getByRole('form', { name: 'Add item' })
      const draft = form.getByRole('textbox', { name: 'Item label' })
      const before = await readSurface(page, surfaceStack.origin, ITEM_SURFACE_ID)
      const beforeEvents = await readEvents(page, surfaceStack.origin)
      primaryWire.interceptNext(async (route) => {
        await route.fulfill({ status: 503, json: { error: 'Temporary Action transport failure' } })
      })
      await draft.fill('Retained item')
      await form.getByRole('button', { name: 'Add item' }).click()
      await expect(form.getByRole('alert')).toContainText('Temporary Action transport failure')
      await expect(draft).toHaveValue('Retained item')
      await expect(draft).toBeEnabled()
      await expect(form.getByRole('button', { name: 'Add item' })).toBeEnabled()
      const failed = latest(primaryWire.requests).invocation
      ActionIntentIdSchema.parse(failed.intentId)
      expect(await readSurface(page, surfaceStack.origin, ITEM_SURFACE_ID)).toEqual(before)
      expect(await readEvents(page, surfaceStack.origin)).toEqual(beforeEvents)
      for (const client of [page, observer.page]) {
        await expect(
          surfaceCard(client, 'Item collection').getByRole('cell', {
            name: 'Retained item',
            exact: true,
          }),
        ).toHaveCount(0)
      }
      await form.getByRole('button', { name: 'Add item' }).click()
      await expect(draft).toHaveValue('')
      await expect(form.getByRole('alert')).toBeHidden()
      const retried = latest(primaryWire.requests).invocation
      expect(retried).toEqual(failed)
      const outcome = committedOutcome(await primaryWire.outcomeFor(failed.intentId))
      expect(outcome.intentId).toBe(failed.intentId)
      for (const client of [page, observer.page]) {
        await expect(
          surfaceCard(client, 'Item collection').getByRole('cell', {
            name: 'Retained item',
            exact: true,
          }),
        ).toHaveCount(1)
      }
      await expectCommittedEvent(page, surfaceStack.origin, outcome)
    })

    await test.step('a live committed outcome wins a lost HTTP response without false failure or duplicate append', async () => {
      const form = surfaceCard(page, 'Item collection').getByRole('form', { name: 'Add item' })
      const draft = form.getByRole('textbox', { name: 'Item label' })
      const committed = signal<void>()
      const loseHttp = signal<void>()
      const lost = signal<void>()
      primaryWire.interceptNext(async (route) => {
        const response = await route.fetch()
        primaryWire.outcomes.push(FastActionOutcomeSchema.parse(await response.json()))
        committed.resolve()
        await loseHttp.promise
        await route.abort('failed')
        lost.resolve()
      })
      await draft.fill('Live confirmed item')
      await form.getByRole('button', { name: 'Add item' }).click()
      await committed.promise
      await expect(draft).toHaveValue('')
      await expect(form.getByRole('alert')).toBeHidden()
      for (const client of [page, observer.page]) {
        await expect(
          surfaceCard(client, 'Item collection').getByRole('cell', {
            name: 'Live confirmed item',
            exact: true,
          }),
        ).toHaveCount(1)
      }
      loseHttp.resolve()
      await lost.promise
      await expect(form.getByRole('alert')).toBeHidden()
      await expect(form.getByRole('button', { name: 'Add item' })).toBeEnabled()
      await expectCommittedEvent(
        page,
        surfaceStack.origin,
        committedOutcome(latest(primaryWire.outcomes)),
      )
    })

    await test.step('distinct concurrent appends both survive in canonical order', async () => {
      const release = signal<void>()
      const primaryReady = signal<void>()
      const observerReady = signal<void>()
      primaryWire.interceptNext(async (route) => {
        primaryReady.resolve()
        await release.promise
        await primaryWire.deliverHttp(route)
      })
      observerWire.interceptNext(async (route) => {
        observerReady.resolve()
        await release.promise
        await observerWire.deliverHttp(route)
      })
      const primaryForm = surfaceCard(page, 'Item collection').getByRole('form', {
        name: 'Add item',
      })
      const observerForm = surfaceCard(observer.page, 'Item collection').getByRole('form', {
        name: 'Add item',
      })
      await primaryForm.getByRole('textbox', { name: 'Item label' }).fill('Concurrent A')
      await observerForm.getByRole('textbox', { name: 'Item label' }).fill('Concurrent B')
      await Promise.all([
        primaryForm.getByRole('button', { name: 'Add item' }).click(),
        observerForm.getByRole('button', { name: 'Add item' }).click(),
      ])
      await Promise.all([primaryReady.promise, observerReady.promise])
      const primaryIntent = latest(primaryWire.requests).invocation.intentId
      const observerIntent = latest(observerWire.requests).invocation.intentId
      expect(primaryIntent).not.toBe(observerIntent)
      release.resolve()
      await expect(primaryForm.getByRole('textbox', { name: 'Item label' })).toHaveValue('')
      await expect(observerForm.getByRole('textbox', { name: 'Item label' })).toHaveValue('')
      for (const client of [page, observer.page]) {
        const table = surfaceCard(client, 'Item collection').getByRole('table', { name: 'Items' })
        await expect(table.getByRole('cell', { name: 'Concurrent A', exact: true })).toHaveCount(1)
        await expect(table.getByRole('cell', { name: 'Concurrent B', exact: true })).toHaveCount(1)
      }
      const primaryOutcome = committedOutcome(await primaryWire.outcomeFor(primaryIntent))
      const observerOutcome = committedOutcome(await observerWire.outcomeFor(observerIntent))
      expect(primaryOutcome.intentId).toBe(primaryIntent)
      expect(observerOutcome.intentId).toBe(observerIntent)
      const ordered = [primaryOutcome, observerOutcome].sort(
        (left, right) => left.eventCursor - right.eventCursor,
      )
      const surface = await readSurface(page, surfaceStack.origin, ITEM_SURFACE_ID)
      expect(
        records(surface, 'items')
          .slice(-2)
          .map((record) => record['label']),
      ).toEqual(ordered.map((outcome) => latest(records(outcome.surface, 'items'))['label']))
      expect(records(surface, 'items')).toHaveLength(5)
      expect(new Set(records(surface, 'items').map((record) => record['id'])).size).toBe(5)
      expect(
        (await readSurface(observer.page, surfaceStack.origin, ITEM_SURFACE_ID)).state,
      ).toEqual(surface.state)
      await expectCommittedEvent(page, surfaceStack.origin, primaryOutcome)
      await expectCommittedEvent(observer.page, surfaceStack.origin, observerOutcome)
    })

    await test.step('persisted Buttons update and remove only the stable record; repeated removal is a noop', async () => {
      const items = surfaceCard(page, 'Item collection')
      const before = await readSurface(page, surfaceStack.origin, ITEM_SURFACE_ID)
      await items.getByRole('button', { name: 'Update seed item' }).click()
      for (const client of [page, observer.page]) {
        await expect(
          surfaceCard(client, 'Item collection').getByRole('row').filter({ hasText: SEED_ITEM_ID }),
        ).toContainText('completed')
      }
      const updated = await readSurface(page, surfaceStack.origin, ITEM_SURFACE_ID)
      expect(records(updated, 'items')).toEqual(
        records(before, 'items').map((record) =>
          record['id'] === SEED_ITEM_ID ? { ...record, status: 'completed' } : record,
        ),
      )
      await expectCommittedEvent(
        page,
        surfaceStack.origin,
        committedOutcome(
          await primaryWire.outcomeFor(latest(primaryWire.requests).invocation.intentId),
        ),
      )
      await items.getByRole('button', { name: 'Remove seed item' }).click()
      for (const client of [page, observer.page]) {
        await expect(
          surfaceCard(client, 'Item collection').getByRole('cell', {
            name: SEED_ITEM_ID,
            exact: true,
          }),
        ).toHaveCount(0)
      }
      const removed = await readSurface(page, surfaceStack.origin, ITEM_SURFACE_ID)
      expect(records(removed, 'items')).toEqual(
        records(updated, 'items').filter((record) => record['id'] !== SEED_ITEM_ID),
      )
      await expectCommittedEvent(
        page,
        surfaceStack.origin,
        committedOutcome(
          await primaryWire.outcomeFor(latest(primaryWire.requests).invocation.intentId),
        ),
      )
      const beforeNoop = await readEvents(page, surfaceStack.origin)
      const beforeDeliveries = [primaryWire.delivered.length, observerWire.delivered.length]
      const beforeOutcomes = primaryWire.outcomes.length
      await items.getByRole('button', { name: 'Remove seed item' }).click()
      await expect.poll(() => primaryWire.outcomes.length).toBe(beforeOutcomes + 1)
      const noop = latest(primaryWire.outcomes)
      expect(noop).toMatchObject({ outcome: 'noop', reason: 'missing_target', duplicate: false })
      expect(await readSurface(page, surfaceStack.origin, ITEM_SURFACE_ID)).toEqual(removed)
      expect(await readEvents(page, surfaceStack.origin)).toEqual(beforeNoop)
      expect([primaryWire.delivered.length, observerWire.delivered.length]).toEqual(
        beforeDeliveries,
      )
    })

    await test.step('each mutating intent has one delivered Event and one live outcome per client', async () => {
      const outcomes = [...primaryWire.outcomes, ...observerWire.outcomes].filter(
        (outcome) => outcome.outcome === 'committed',
      )
      expect(outcomes).toHaveLength(7)
      for (const outcome of outcomes) {
        await expectCommittedEvent(page, surfaceStack.origin, outcome)
        for (const wire of [primaryWire, observerWire]) {
          await expect
            .poll(
              () =>
                wire.delivered.filter((receipt) => receipt.intentId === outcome.intentId).length,
            )
            .toBe(1)
          expect(
            wire.delivered.find((receipt) => receipt.intentId === outcome.intentId),
          ).toMatchObject({
            surfaceCommitId: outcome.surfaceCommitId,
            eventCursor: outcome.eventCursor,
            actionRevision: outcome.actionRevision,
          })
        }
      }
    })

    await test.step('an observer catches a missed append after reconnect without reloading', async () => {
      const navigation = await observer.page.evaluate(() =>
        performance.getEntriesByType('navigation').map((entry) => entry.toJSON()),
      )
      await observerWire.disconnect()
      await expect(observer.page.locator('.app-shell')).toHaveAttribute(
        'data-gateway-online',
        'false',
      )
      const form = surfaceCard(page, 'Item collection').getByRole('form', { name: 'Add item' })
      await form.getByRole('textbox', { name: 'Item label' }).fill('Reconnected item')
      await form.getByRole('button', { name: 'Add item' }).click()
      await expect(form.getByRole('textbox', { name: 'Item label' })).toHaveValue('')
      await expect(
        surfaceCard(page, 'Item collection').getByRole('cell', {
          name: 'Reconnected item',
          exact: true,
        }),
      ).toHaveCount(1)
      await expect(
        surfaceCard(observer.page, 'Item collection').getByRole('cell', {
          name: 'Reconnected item',
          exact: true,
        }),
      ).toHaveCount(0)
      observerWire.disconnected = false
      await expect(observer.page.locator('.app-shell')).toHaveAttribute(
        'data-gateway-online',
        'true',
        { timeout: 30_000 },
      )
      await expect(
        surfaceCard(observer.page, 'Item collection').getByRole('cell', {
          name: 'Reconnected item',
          exact: true,
        }),
      ).toHaveCount(1)
      expect(
        await observer.page.evaluate(() =>
          performance.getEntriesByType('navigation').map((entry) => entry.toJSON()),
        ),
      ).toEqual(navigation)
      await expectCommittedEvent(
        page,
        surfaceStack.origin,
        committedOutcome(
          await primaryWire.outcomeFor(latest(primaryWire.requests).invocation.intentId),
        ),
      )
    })

    await test.step('a disconnected hung request retries the same intent after same-root restart and clears the failed Form', async () => {
      const measurement = surfaceCard(page, 'Measurement log')
      const form = measurement.getByRole('form', { name: 'Record measurement' })
      const draft = form.getByRole('spinbutton', { name: 'New measurement' })
      const committed = signal<void>()
      const release = signal<void>()
      const lost = signal<void>()
      releaseStalledHttp = () => release.resolve()
      primaryWire.holdPatches = true
      primaryWire.interceptNext(async (route) => {
        const response = await route.fetch()
        primaryWire.outcomes.push(FastActionOutcomeSchema.parse(await response.json()))
        committed.resolve()
        await release.promise
        await route.abort('failed')
        lost.resolve()
      })
      await draft.fill('51.25')
      await form.getByRole('button', { name: 'Record measurement' }).click()
      await committed.promise
      const original = committedOutcome(latest(primaryWire.outcomes))
      const invocation = latest(primaryWire.requests).invocation
      await expect(form).toHaveAttribute('aria-busy', 'true')
      await expect(draft).toHaveValue('51.25')
      await expect(measurement.getByRole('cell', { name: '51.25', exact: true })).toHaveCount(0)
      await expect(
        surfaceCard(observer.page, 'Measurement log').getByRole('cell', {
          name: '51.25',
          exact: true,
        }),
      ).toHaveCount(1)
      await primaryWire.disconnect()
      await expect(page.locator('.app-shell')).toHaveAttribute('data-gateway-online', 'false')
      await expect(form.getByRole('alert')).toContainText(/connection|queued|confirmation/i)
      await expect(draft).toBeEnabled()
      await expect(draft).toHaveValue('51.25')
      await observerWire.disconnect()
      await surfaceStack.stop()
      primaryWire.dropPatches()
      restarted = await startLocalVpsStack({
        port: surfaceStack.port,
        baseDir: surfaceStack.baseDir,
        legacyHome: surfaceStack.legacyHome,
      })
      await restarted.waitForReadyLine()
      primaryWire.interceptNext(async (route, request) => {
        expect(request.invocation).toEqual(invocation)
        await primaryWire.deliverHttp(route)
      })
      primaryWire.disconnected = false
      observerWire.disconnected = false
      for (const client of [page, observer.page]) {
        await expect(client.locator('.app-shell')).toHaveAttribute('data-gateway-online', 'true', {
          timeout: 30_000,
        })
      }
      const duplicate = committedOutcome(await primaryWire.outcomeFor(invocation.intentId, true))
      expect(duplicate).toEqual({ ...original, duplicate: true })
      await expect(draft).toHaveValue('')
      await expect(form.getByRole('alert')).toBeHidden()
      await expect(form.getByRole('button', { name: 'Record measurement' })).toBeEnabled()
      primaryWire.releasePatches()
      release.resolve()
      await lost.promise
      await expect(form.getByRole('alert')).toBeHidden()
      expect((await readSurface(page, surfaceStack.origin, MEASUREMENT_SURFACE_ID)).state).toEqual(
        original.surface.state,
      )
      for (const client of [page, observer.page]) {
        await expect(
          surfaceCard(client, 'Measurement log').getByRole('cell', { name: '51.25', exact: true }),
        ).toHaveCount(1)
      }
      await expectCommittedEvent(page, surfaceStack.origin, duplicate)

      // Once confirmation clears the failed draft, an identical new submission is a new intent.
      await draft.fill('51.25')
      await draft.press('Enter')
      await expect(draft).toHaveValue('')
      const fresh = latest(primaryWire.requests).invocation
      expect(fresh.intentId).not.toBe(invocation.intentId)
      const next = committedOutcome(await primaryWire.outcomeFor(fresh.intentId))
      const previousRecords = records(original.surface, 'records')
      const nextRecords = records(next.surface, 'records')
      expect(nextRecords.slice(0, 2)).toEqual(previousRecords)
      expect(nextRecords).toHaveLength(3)
      expect(new Set(nextRecords.map((record) => record['id'])).size).toBe(3)
      for (const client of [page, observer.page]) {
        await expect(
          surfaceCard(client, 'Measurement log').getByRole('cell', { name: '51.25', exact: true }),
        ).toHaveCount(2)
      }
      await expectCommittedEvent(page, surfaceStack.origin, next)
    })

    await test.step('both compositions survive reload and the offline cache contains only confirmed records', async () => {
      const items = await readSurface(page, surfaceStack.origin, ITEM_SURFACE_ID)
      const measurement = await readSurface(page, surfaceStack.origin, MEASUREMENT_SURFACE_ID)
      for (const client of [page, observer.page]) {
        await client.reload()
        await expect(client.locator('.app-shell')).toHaveAttribute('data-gateway-online', 'true')
        for (const [title, surface, key] of [
          ['Item collection', items, 'items'],
          ['Measurement log', measurement, 'records'],
        ] as const) {
          const card = surfaceCard(client, title)
          await expect(card.getByRole('table').getByRole('row')).toHaveCount(
            records(surface, key).length + 1,
          )
          for (const record of records(surface, key)) {
            await expect(
              card.getByRole('cell', { name: String(record['id']), exact: true }),
            ).toHaveCount(1)
          }
          expect((await readSurface(client, surfaceStack.origin, surface.id)).state).toEqual(
            surface.state,
          )
        }
        await expect(
          surfaceCard(client, 'Measurement log').getByRole('spinbutton', {
            name: 'New measurement',
          }),
        ).toHaveValue('')
      }
      await primaryWire.disconnect()
      await page.route('**/api/spaces', (route) => route.abort('internetdisconnected'))
      await page.reload()
      await expect(page.locator('.app-shell > [role="alert"]')).toContainText(
        /fetch|network|offline/i,
      )
      for (const [title, surface, key] of [
        ['Item collection', items, 'items'],
        ['Measurement log', measurement, 'records'],
      ] as const) {
        await expect(surfaceCard(page, title).getByRole('table').getByRole('row')).toHaveCount(
          records(surface, key).length + 1,
        )
        for (const record of records(surface, key)) {
          await expect(
            surfaceCard(page, title).getByRole('cell', { name: String(record['id']), exact: true }),
          ).toHaveCount(1)
        }
      }
      await expect(
        surfaceCard(page, 'Measurement log')
          .locator('[data-veduta-atom-id="current-measurement"]')
          .getByText('51.25', { exact: true }),
      ).toBeVisible()
      await page.unroute('**/api/spaces')
      primaryWire.disconnected = false
      await page.reload()
      await expect(page.locator('.app-shell')).toHaveAttribute('data-gateway-online', 'true')
      const events = (await readEvents(page, surfaceStack.origin)).filter(
        (event) =>
          event.type === 'fast_path' &&
          [ITEM_SURFACE_ID, MEASUREMENT_SURFACE_ID].includes(String(event.payload?.['surfaceId'])),
      )
      expect(events).toHaveLength(10)
      expect(new Set(events.map((event) => event.payload?.['intentId'])).size).toBe(10)
      expect(await readEvents(observer.page, surfaceStack.origin)).toEqual(
        await readEvents(page, surfaceStack.origin),
      )
    })
  } finally {
    releaseStalledHttp()
    primaryWire.dropPatches()
    observerWire.dropPatches()
    primaryWire.releasePatches()
    observerWire.releasePatches()
    await observer.context.close()
    await restarted?.stop()
  }
})
