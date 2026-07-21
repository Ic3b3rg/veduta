import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AtomNode } from '@veduta/protocol'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  NOTIFICATION_SETTINGS_SURFACE_ID,
  notificationSettingsSurface,
  NotificationSettingsSurfaceManager,
  type NotificationStats,
  type NotificationStatsSource,
} from './notification-settings-surface.ts'
import { loadNotificationsConfig, saveNotificationsConfig } from './notifications-config.ts'
import { Store } from './store.ts'
import { ensureSystemSpace, SYSTEM_SPACE_ID } from './system-space.ts'

/** Deterministic id `SpacesEngine.createSpace` assigns to `{ slug: 'errands' }` — known upfront so `setup()`'s stats argument never has to reference its own return value. */
const ERRANDS_SPACE_ID = 'spc-errands'

function findNode(tree: AtomNode, id: string): AtomNode | undefined {
  if (tree.id === id) return tree
  for (const child of tree.children ?? []) {
    const found = findNode(child, id)
    if (found) return found
  }
  return undefined
}

function emptyStats(): NotificationStats {
  return { queuedCount: 0, perSpace: [] }
}

/** Minimal fake standing in for `NotificationCenter` (structural `NotificationStatsSource`). */
class FakeStatsSource implements NotificationStatsSource {
  current: NotificationStats

  constructor(initial: NotificationStats) {
    this.current = initial
  }

  stats(): NotificationStats {
    return this.current
  }
}

describe('NotificationSettingsSurfaceManager', () => {
  let rootDir: string

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'veduta-notification-settings-surface-'))
  })

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true })
  })

  function setup(stats: NotificationStats = emptyStats()) {
    const store = new Store({ rootDir })
    ensureSystemSpace(store.spacesEngine)
    const errands = store.spacesEngine.createSpace({ name: 'Errands', slug: 'errands' })
    const source = new FakeStatsSource(stats)
    const onConfigChanged = vi.fn()
    const manager = new NotificationSettingsSurfaceManager({
      store,
      source,
      rootDir,
      onConfigChanged,
      now: () => new Date('2026-07-20T12:00:00.000Z'),
    })
    return { store, errands, source, onConfigChanged, manager }
  }

  it('builds a protocol-valid Surface stamped "system" (mirrors heartbeatSurface)', () => {
    const surface = notificationSettingsSurface(
      [],
      {
        defaultDailyPushBudget: 3,
        spaceBudgets: {},
        quietHours: { start: '22:00', end: '08:00' },
        digestThreshold: 3,
      },
      emptyStats(),
      '2026-07-20T12:00:00.000Z',
    )
    expect(surface.id).toBe(NOTIFICATION_SETTINGS_SURFACE_ID)
    expect(surface.spaceId).toBe(SYSTEM_SPACE_ID)
    expect(surface.freshness).toEqual({
      updatedAt: '2026-07-20T12:00:00.000Z',
      updatedBy: 'system',
    })
  })

  it('start() creates a daemon-owned Surface in the System Space', () => {
    const { store, manager } = setup()

    manager.start()

    const surface = store.getSurface(NOTIFICATION_SETTINGS_SURFACE_ID)
    expect(surface).toBeDefined()
    expect(surface?.spaceId).toBe(SYSTEM_SPACE_ID)
    expect(surface?.title).toBe('Notifications')
    expect(store.isSurfaceDaemonOwned(NOTIFICATION_SETTINGS_SURFACE_ID)).toBe(true)

    // Structural-defense contract (ADR-0007): the Agent cannot write this Surface.
    expect(() =>
      store.patchState(
        NOTIFICATION_SETTINGS_SURFACE_ID,
        [{ target: 'state', op: 'replace', path: `/notif-budget:${ERRANDS_SPACE_ID}`, value: '5' }],
        { updatedBy: 'agent' },
      ),
    ).toThrow(/daemon-owned/)
  })

  it('renders quiet hours, the queued Stat, and one Row per user Space (skipping System)', () => {
    const { store, errands, manager } = setup({
      queuedCount: 2,
      perSpace: [{ spaceId: ERRANDS_SPACE_ID, sentToday: 1, degradedToday: 0 }],
    })

    manager.start()
    const surface = store.getSurface(NOTIFICATION_SETTINGS_SURFACE_ID)!

    expect(findNode(surface.tree, 'subtitle')?.props).toMatchObject({
      text: `Quiet hours 22:00–08:00 (${resolvedTimezone()})`,
    })
    expect(findNode(surface.tree, 'stat-queued')?.props).toMatchObject({
      label: 'Queued',
      value: '2',
    })

    const row = findNode(surface.tree, `notif-row-${errands.id}`)
    expect(row?.type).toBe('Row')
    expect(findNode(surface.tree, `notif-label-${errands.id}`)?.props).toMatchObject({
      text: 'Errands',
    })
    const select = findNode(surface.tree, `notif-budget-${errands.id}`)
    expect(select?.type).toBe('Select')
    expect(select?.binding).toBe(`notif-budget:${errands.id}`)
    expect(surface.state[`notif-budget:${errands.id}`]).toBe('3') // defaultDailyPushBudget
    expect(select?.props?.['options']).toEqual(['0', '1', '3', '5', '10'])

    // No row for the System Space itself.
    expect(findNode(surface.tree, `notif-row-${SYSTEM_SPACE_ID}`)).toBeUndefined()

    // Acceptance C: the degraded Stat is distinct and findable.
    const degraded = findNode(surface.tree, `notif-degraded-${errands.id}`)
    expect(degraded?.type).toBe('Stat')
    expect(degraded?.props).toMatchObject({ label: 'Degraded today', value: '0' })
    const sent = findNode(surface.tree, `notif-sent-${errands.id}`)
    expect(sent?.props).toMatchObject({ label: 'Sent today', value: '1' })
  })

  it('reports "Quiet hours off" when the config has no quiet window', () => {
    const { store, manager } = setup()
    saveNotificationsConfig(rootDir, {
      defaultDailyPushBudget: 3,
      spaceBudgets: {},
      quietHours: null,
      digestThreshold: 3,
    })

    manager.start()
    const surface = store.getSurface(NOTIFICATION_SETTINGS_SURFACE_ID)!
    expect(findNode(surface.tree, 'subtitle')?.props).toMatchObject({ text: 'Quiet hours off' })
  })

  it('shows the current per-Space override as the Select value, and as an extra option when non-standard', () => {
    const { store, errands, manager } = setup()
    saveNotificationsConfig(rootDir, {
      defaultDailyPushBudget: 3,
      spaceBudgets: { [errands.id]: 7 },
      quietHours: { start: '22:00', end: '08:00' },
      digestThreshold: 3,
    })

    manager.start()
    const surface = store.getSurface(NOTIFICATION_SETTINGS_SURFACE_ID)!
    expect(surface.state[`notif-budget:${errands.id}`]).toBe('7')
    const select = findNode(surface.tree, `notif-budget-${errands.id}`)
    expect(select?.props?.['options']).toEqual(['0', '1', '3', '5', '10', '7'])
  })

  it('budget fast action persists the override, calls onConfigChanged, and refreshes the Select', () => {
    const { store, errands, manager, onConfigChanged } = setup()
    manager.start()

    store.invokeSurfaceAction(NOTIFICATION_SETTINGS_SURFACE_ID, {
      nodeId: `notif-budget-${errands.id}`,
      name: 'change',
      payload: { value: '5' },
    })

    const config = loadNotificationsConfig(rootDir)
    expect(config.spaceBudgets[errands.id]).toBe(5)
    expect(onConfigChanged).toHaveBeenCalledTimes(1)
    expect(onConfigChanged).toHaveBeenCalledWith(config)

    const surface = store.getSurface(NOTIFICATION_SETTINGS_SURFACE_ID)!
    expect(surface.state[`notif-budget:${errands.id}`]).toBe('5')
    const select = findNode(surface.tree, `notif-budget-${errands.id}`)
    expect(select?.props?.['options']).toEqual(['0', '1', '3', '5', '10'])
  })

  it('ignores an invalid (non-offered) Select value with a console.warn, leaving config untouched', () => {
    const { store, errands, manager, onConfigChanged } = setup()
    manager.start()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    store.invokeSurfaceAction(NOTIFICATION_SETTINGS_SURFACE_ID, {
      nodeId: `notif-budget-${errands.id}`,
      name: 'change',
      payload: { value: '2' },
    })

    expect(warn).toHaveBeenCalled()
    expect(onConfigChanged).not.toHaveBeenCalled()
    const config = loadNotificationsConfig(rootDir)
    expect(config.spaceBudgets[errands.id]).toBeUndefined()
    const surface = store.getSurface(NOTIFICATION_SETTINGS_SURFACE_ID)!
    expect(surface.state[`notif-budget:${errands.id}`]).toBe('3')
    warn.mockRestore()
  })

  it('refresh() re-reads stats and updates the Stat values', () => {
    const { store, errands, source, manager } = setup({
      queuedCount: 0,
      perSpace: [{ spaceId: ERRANDS_SPACE_ID, sentToday: 0, degradedToday: 0 }],
    })
    manager.start()

    source.current = {
      queuedCount: 4,
      perSpace: [{ spaceId: errands.id, sentToday: 2, degradedToday: 1 }],
    }
    manager.refresh()

    const surface = store.getSurface(NOTIFICATION_SETTINGS_SURFACE_ID)!
    expect(findNode(surface.tree, 'stat-queued')?.props).toMatchObject({ value: '4' })
    expect(findNode(surface.tree, `notif-sent-${errands.id}`)?.props).toMatchObject({ value: '2' })
    expect(findNode(surface.tree, `notif-degraded-${errands.id}`)?.props).toMatchObject({
      value: '1',
    })
  })

  it('refresh() is suitable to pass directly as an onStats callback without losing `this`', () => {
    const { store, errands, source, manager } = setup()
    manager.start()

    const onStats: () => void = manager.refresh
    source.current = {
      queuedCount: 1,
      perSpace: [{ spaceId: errands.id, sentToday: 1, degradedToday: 0 }],
    }
    onStats()

    const surface = store.getSurface(NOTIFICATION_SETTINGS_SURFACE_ID)!
    expect(findNode(surface.tree, 'stat-queued')?.props).toMatchObject({ value: '1' })
  })

  it('refresh() after a new Space appears adds its row and state key without throwing (regression: SurfaceSchema rejects a binding added before its state key exists)', () => {
    const { store, source, manager } = setup()
    manager.start()

    const groceries = store.spacesEngine.createSpace({ name: 'Groceries', slug: 'groceries' })
    source.current = {
      queuedCount: 0,
      perSpace: [{ spaceId: groceries.id, sentToday: 2, degradedToday: 0 }],
    }

    expect(() => manager.refresh()).not.toThrow()

    const surface = store.getSurface(NOTIFICATION_SETTINGS_SURFACE_ID)!
    expect(findNode(surface.tree, `notif-row-${groceries.id}`)).toBeDefined()
    const select = findNode(surface.tree, `notif-budget-${groceries.id}`)
    expect(select?.type).toBe('Select')
    expect(select?.binding).toBe(`notif-budget:${groceries.id}`)
    expect(surface.state[`notif-budget:${groceries.id}`]).toBe('3')
    expect(findNode(surface.tree, `notif-sent-${groceries.id}`)?.props).toMatchObject({
      value: '2',
    })
  })

  it('start() on an existing Surface refreshes it, so a restart picks up on-disk config changes (not just first-boot creation)', () => {
    const { store, errands, source } = setup()
    const first = new NotificationSettingsSurfaceManager({
      store,
      source,
      rootDir,
      now: () => new Date('2026-07-20T12:00:00.000Z'),
    })
    first.start()

    saveNotificationsConfig(rootDir, {
      defaultDailyPushBudget: 9,
      spaceBudgets: {},
      quietHours: { start: '22:00', end: '08:00' },
      digestThreshold: 3,
    })

    const second = new NotificationSettingsSurfaceManager({
      store,
      source,
      rootDir,
      now: () => new Date('2026-07-20T13:00:00.000Z'),
    })
    second.start()

    const surface = store.getSurface(NOTIFICATION_SETTINGS_SURFACE_ID)!
    expect(surface.state[`notif-budget:${errands.id}`]).toBe('9')
    const select = findNode(surface.tree, `notif-budget-${errands.id}`)
    expect(select?.props?.['options']).toEqual(['0', '1', '3', '5', '10', '9'])
  })

  it('refresh() after a Space is archived removes its row and its now-stale state key', () => {
    const { store, errands, manager } = setup()
    manager.start()

    store.archiveSpace(errands.id)
    manager.refresh()

    const surface = store.getSurface(NOTIFICATION_SETTINGS_SURFACE_ID)!
    expect(findNode(surface.tree, `notif-row-${errands.id}`)).toBeUndefined()
    expect(Object.prototype.hasOwnProperty.call(surface.state, `notif-budget:${errands.id}`)).toBe(
      false,
    )
  })
})

function resolvedTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone
}
