import { fastInvocation } from './surface-action-test-fixtures.ts'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SurfaceSchema, type AtomNode } from '@veduta/protocol'
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
    expect(select).toHaveProperty(
      'props.options',
      ['0', '1', '3', '5', '10'].map((value) => ({ label: value, value })),
    )

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
    expect(select).toHaveProperty(
      'props.options',
      ['0', '1', '3', '5', '10', '7'].map((value) => ({ label: value, value })),
    )
  })

  it('budget fast action persists the override, calls onConfigChanged, and refreshes the Select', () => {
    const { store, errands, manager, onConfigChanged } = setup()
    manager.start()

    store.invokeSurfaceAction(
      NOTIFICATION_SETTINGS_SURFACE_ID,
      fastInvocation(
        store,
        NOTIFICATION_SETTINGS_SURFACE_ID,
        `notif-budget-${errands.id}`,
        'change',
        { value: '5' },
      ),
    )

    const config = loadNotificationsConfig(rootDir)
    expect(config.spaceBudgets[errands.id]).toBe(5)
    expect(onConfigChanged).toHaveBeenCalledTimes(1)
    expect(onConfigChanged).toHaveBeenCalledWith(config)

    const surface = store.getSurface(NOTIFICATION_SETTINGS_SURFACE_ID)!
    expect(surface.state[`notif-budget:${errands.id}`]).toBe('5')
    const select = findNode(surface.tree, `notif-budget-${errands.id}`)
    expect(select).toHaveProperty(
      'props.options',
      ['0', '1', '3', '5', '10'].map((value) => ({ label: value, value })),
    )
  })

  it('rejects a non-offered Select value before any durable change', () => {
    const { store, errands, manager, onConfigChanged } = setup()
    manager.start()
    const cursor = store.latestSurfaceCursor()
    expect(() =>
      store.invokeSurfaceAction(
        NOTIFICATION_SETTINGS_SURFACE_ID,
        fastInvocation(
          store,
          NOTIFICATION_SETTINGS_SURFACE_ID,
          `notif-budget-${errands.id}`,
          'change',
          { value: '2' },
        ),
      ),
    ).toThrow('owning interaction')
    expect(store.latestSurfaceCursor()).toBe(cursor)
    expect(onConfigChanged).not.toHaveBeenCalled()
    const config = loadNotificationsConfig(rootDir)
    expect(config.spaceBudgets[errands.id]).toBeUndefined()
    const surface = store.getSurface(NOTIFICATION_SETTINGS_SURFACE_ID)!
    expect(surface.state[`notif-budget:${errands.id}`]).toBe('3')
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
    const { store, errands, source, manager } = setup()
    manager.dispose()
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

    first.dispose()
    const second = new NotificationSettingsSurfaceManager({
      store,
      source,
      rootDir,
      now: () => new Date('2026-07-20T13:00:00.000Z'),
    })
    const cursor = store.latestSurfaceCursor()
    second.start()
    const updates = store.surfaceEventsAfter(cursor)
    expect(updates).toHaveLength(1)
    expect(updates[0]?.kind).toBe('patch')

    const surface = store.getSurface(NOTIFICATION_SETTINGS_SURFACE_ID)!
    expect(surface.state[`notif-budget:${errands.id}`]).toBe('9')
    const select = findNode(surface.tree, `notif-budget-${errands.id}`)
    expect(select).toHaveProperty(
      'props.options',
      ['0', '1', '3', '5', '10', '9'].map((value) => ({ label: value, value })),
    )
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

  it('restricts atomic projection refresh to daemon ownership and preserves Pin and tree versions', () => {
    const { store, errands, manager } = setup()
    manager.start()
    const ordinary = store.createSurface(
      SurfaceSchema.parse({
        id: 'srf-ordinary',
        spaceId: errands.id,
        title: 'Ordinary',
        tree: { id: 'copy', type: 'Text', props: { text: 'User content' } },
        state: {},
        freshness: { updatedAt: '2026-10-01T08:00:00.000Z', updatedBy: 'agent' },
      }),
      'agent',
    )
    expect(() =>
      store.patchDaemonSurface(
        ordinary.id,
        [{ target: 'state', op: 'add', path: '/hidden', value: true }],
        { expectedTreeVersion: 1 },
      ),
    ).toThrow(/daemon-owned/)
    expect(store.getSurface(ordinary.id)?.state).toEqual({})

    store.setPinned(NOTIFICATION_SETTINGS_SURFACE_ID, true, {
      origin: 'trusted:user',
      updatedBy: 'user',
    })
    const version = store.getSurfaceVersion(NOTIFICATION_SETTINGS_SURFACE_ID)!
    const operations = [
      {
        target: 'state' as const,
        op: 'replace' as const,
        path: `/notif-budget:${errands.id}`,
        value: '5',
      },
    ]
    expect(() =>
      store.patchDaemonSurface(NOTIFICATION_SETTINGS_SURFACE_ID, operations, {
        expectedTreeVersion: version.treeVersion + 1,
      }),
    ).toThrow(/tree version/i)
    store.patchDaemonSurface(NOTIFICATION_SETTINGS_SURFACE_ID, operations, {
      expectedTreeVersion: version.treeVersion,
    })
    expect(store.getSurface(NOTIFICATION_SETTINGS_SURFACE_ID)?.pinned).toBe(true)
    expect(store.getSurfaceVersion(NOTIFICATION_SETTINGS_SURFACE_ID)).toMatchObject({
      version: version.version + 1,
      treeVersion: version.treeVersion,
    })
  })
})

function resolvedTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone
}
