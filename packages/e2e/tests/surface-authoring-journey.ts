import { expect, test, type Page } from '@playwright/test'
import { INVALID_AUTHORING_REQUEST } from '../../daemon/src/mock-invalid-authoring-fixture.ts'
import { STRUCTURED_PLAN_REQUEST } from '../../daemon/src/mock-structured-plan-fixture.ts'
import {
  createFastActionSurfaces,
  ITEM_SURFACE_ID,
  MEASUREMENT_SURFACE_ID,
} from './fast-action-surfaces.ts'
import {
  readEvents,
  readSurface,
  readSurfaceSnapshot,
  surfaceCard,
} from './fast-actions-journey.ts'
import { expectCompleteGymPlan } from './gym-plan-journey.ts'

/** The remaining authoring regressions run in the same clean root as text, weight, and presentation. */
export async function verifySurfaceAuthoring(
  page: Page,
  origin: string,
  baseDir: string,
): Promise<void> {
  await test.step('the exact three-day gym request creates complete canonical content live and after reload (#150)', async () => {
    await page
      .getByRole('textbox', { name: 'Message Veduta in Health' })
      .fill(STRUCTURED_PLAN_REQUEST)
    await page.getByRole('button', { name: 'Send message' }).click()
    await expectCompleteGymPlan(page)
    await expect(page.locator('.chat-entry.assistant').last()).toContainText(
      'Saved Surface “Gym plan — 3 days”',
    )
    await expect(page.locator('.chat-entry.assistant').last()).toContainText(
      'Session 3 — Full body',
    )
    await page.reload()
    await expectCompleteGymPlan(page)
  })

  await test.step('accepted Add and Log Forms change their visible collections, not only drafts (#150)', async () => {
    createFastActionSurfaces(baseDir)
    await page.reload()
    await expect(page.locator('.app-shell')).toHaveAttribute('data-gateway-online', 'true')
    const items = surfaceCard(page, 'Item collection')
    const add = items.getByRole('form', { name: 'Add item' })
    const draft = add.getByRole('textbox', { name: 'Item label' })
    const before = await readSurface(page, origin, ITEM_SURFACE_ID)
    const eventsBefore = (await readEvents(page, origin)).filter(
      (event) => event.payload?.['surfaceId'] === ITEM_SURFACE_ID,
    )
    await draft.fill('Command collection record')
    expect((await readSurface(page, origin, ITEM_SURFACE_ID)).state).toEqual(before.state)
    expect(
      (await readEvents(page, origin)).filter(
        (event) => event.payload?.['surfaceId'] === ITEM_SURFACE_ID,
      ),
    ).toEqual(eventsBefore)
    await draft.press('Enter')
    await expect(
      items.getByRole('cell', { name: 'Command collection record', exact: true }),
    ).toBeVisible()
    await expect(draft).toHaveValue('')
    const added = await readSurface(page, origin, ITEM_SURFACE_ID)
    expect(added.state['items']).toEqual([
      ...(Array.isArray(before.state['items']) ? before.state['items'] : []),
      { id: expect.any(String), label: 'Command collection record', status: 'open' },
    ])
    expect(
      (await readEvents(page, origin)).filter(
        (event) => event.type === 'fast_path' && event.payload?.['surfaceId'] === ITEM_SURFACE_ID,
      ),
    ).toHaveLength(1)

    const measurement = surfaceCard(page, 'Measurement log')
    const log = measurement.getByRole('form', { name: 'Record measurement' })
    await log.getByRole('spinbutton', { name: 'New measurement' }).fill('18.5')
    await log.getByRole('button', { name: 'Record measurement' }).click()
    await expect(measurement.getByRole('cell', { name: '18.5', exact: true })).toBeVisible()
    await expect(
      measurement
        .locator('[data-veduta-atom-id="current-measurement"]')
        .getByText('18.5', { exact: true }),
    ).toBeVisible()
    const recorded = await readSurface(page, origin, MEASUREMENT_SURFACE_ID)
    expect(recorded.state).toEqual({
      currentValue: 18.5,
      draftValue: '',
      records: [{ id: expect.any(String), value: 18.5, recordedAt: expect.any(String) }],
    })
    expect(
      (await readEvents(page, origin)).filter(
        (event) =>
          event.type === 'fast_path' && event.payload?.['surfaceId'] === MEASUREMENT_SURFACE_ID,
      ),
    ).toHaveLength(1)
    await page.reload()
    await expect(
      surfaceCard(page, 'Item collection').getByRole('cell', {
        name: 'Command collection record',
        exact: true,
      }),
    ).toBeVisible()
    await expect(
      surfaceCard(page, 'Measurement log').getByRole('cell', { name: '18.5', exact: true }),
    ).toBeVisible()
    expect((await readSurface(page, origin, ITEM_SURFACE_ID)).state).toEqual(added.state)
    expect((await readSurface(page, origin, MEASUREMENT_SURFACE_ID)).state).toEqual(recorded.state)
  })

  await test.step('an invalid subtree rejects the entire model write and Chat cannot claim success (#150)', async () => {
    const before = await readSurface(page, origin, 'srf-health-weight-tracker')
    const cursorBefore = (await readSurfaceSnapshot(page, origin)).surfaceCursor
    const beforeEvents = (await readEvents(page, origin)).filter((event) =>
      event.type.startsWith('surface.'),
    )
    await page
      .getByRole('textbox', { name: 'Message Veduta in Health' })
      .fill(INVALID_AUTHORING_REQUEST)
    await page.getByRole('button', { name: 'Send message' }).click()
    const reply = page.locator('.chat-entry.assistant').last()
    await expect(reply).toContainText('A Surface change was not saved:')
    await expect(reply).not.toContainText('All requested changes were saved.')
    const tracker = surfaceCard(page, 'Weight tracker')
    await expect(tracker).not.toContainText('Uncommitted valid content')
    await expect(tracker).not.toContainText('Uncommitted invalid content')
    await expect(tracker.getByText('74 kg', { exact: true })).toBeVisible()
    expect(await readSurface(page, origin, before.id)).toEqual(before)
    expect((await readSurfaceSnapshot(page, origin)).surfaceCursor).toBe(cursorBefore)
    expect(
      (await readEvents(page, origin)).filter((event) => event.type.startsWith('surface.')),
    ).toEqual(beforeEvents)
    await page.reload()
    expect(await readSurface(page, origin, before.id)).toEqual(before)
    await expect(surfaceCard(page, 'Weight tracker')).not.toContainText('Uncommitted valid content')
  })
}
