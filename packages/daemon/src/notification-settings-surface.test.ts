import { fastInvocation } from './surface-action-test-fixtures.ts'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { inputSetPlan, SurfaceSchema } from '@veduta/protocol'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  NOTIFICATION_SETTINGS_SURFACE_ID,
  notificationSettingsSurface,
  NotificationSettingsSurfaceManager,
} from './notification-settings-surface.ts'
import { NotificationsConfigSchema, saveNotificationsConfig } from './notifications-config.ts'
import { Store } from './store.ts'
import { ensureSystemSpace, SYSTEM_SPACE_ID } from './system-space.ts'

let rootDir: string
beforeEach(() => {
  rootDir = mkdtempSync(join(tmpdir(), 'veduta-notification-settings-'))
})
afterEach(() => {
  rmSync(rootDir, { recursive: true, force: true })
})

function setup() {
  const store = new Store({ rootDir })
  ensureSystemSpace(store.spacesEngine)
  let queuedCount = 0
  const manager = new NotificationSettingsSurfaceManager({
    store,
    rootDir,
    source: { stats: () => ({ queuedCount }) },
    now: () => new Date('2026-10-14T12:00:00Z'),
  })
  return {
    store,
    manager,
    setQueued: (value: number) => {
      queuedCount = value
    },
  }
}

describe('Notification settings', () => {
  it('renders a protocol-valid System Surface with quiet hours and queue state only', () => {
    const surface = notificationSettingsSurface(
      NotificationsConfigSchema.parse({ timezone: 'Europe/Rome' }),
      { queuedCount: 4 },
      '2026-10-14T12:00:00Z',
    )
    expect(SurfaceSchema.parse(surface)).toMatchObject({
      id: NOTIFICATION_SETTINGS_SURFACE_ID,
      spaceId: SYSTEM_SPACE_ID,
      state: {},
      freshness: { updatedBy: 'system' },
    })
    expect(surface.tree.children).toMatchObject([
      { type: 'Title' },
      { type: 'Caption', props: { text: 'Quiet hours 22:00–08:00 (Europe/Rome)' } },
      { type: 'Stat', props: { label: 'Queued', value: '4' } },
    ])
    expect(JSON.stringify(surface)).not.toMatch(/budget|degraded|Select/i)
  })

  it('creates daemon-owned state that the Agent cannot rewrite', () => {
    const { store, manager } = setup()
    manager.start()
    expect(store.isSurfaceDaemonOwned(NOTIFICATION_SETTINGS_SURFACE_ID)).toBe(true)
    expect(() =>
      store.patchState(
        NOTIFICATION_SETTINGS_SURFACE_ID,
        [{ target: 'state', op: 'add', path: '/hidden', value: true }],
        { updatedBy: 'agent' },
      ),
    ).toThrow(/daemon-owned/)
  })

  it('refreshes queued status and reads quiet-hours configuration on restart', () => {
    const { store, manager, setQueued } = setup()
    manager.start()
    setQueued(5)
    manager.refresh()
    expect(store.getSurface(NOTIFICATION_SETTINGS_SURFACE_ID)?.tree.children?.[2]?.props).toEqual({
      label: 'Queued',
      value: '5',
    })
    saveNotificationsConfig(rootDir, NotificationsConfigSchema.parse({ quietHours: null }))
    const restarted = new NotificationSettingsSurfaceManager({
      store,
      rootDir,
      source: { stats: () => ({ queuedCount: 0 }) },
    })
    restarted.start()
    expect(store.getSurface(NOTIFICATION_SETTINGS_SURFACE_ID)?.tree.children?.[1]?.props).toEqual({
      text: 'Quiet hours off',
    })
  })

  it('replaces legacy limit controls and bindings atomically while preserving Pin', () => {
    const { store, manager } = setup()
    const stateKey = 'notif-budget:spc-health'
    store.createSurface(
      SurfaceSchema.parse({
        id: NOTIFICATION_SETTINGS_SURFACE_ID,
        spaceId: SYSTEM_SPACE_ID,
        title: 'Notifications',
        tree: {
          id: 'root',
          type: 'Box',
          children: [
            {
              id: 'legacy-budget',
              type: 'Select',
              binding: stateKey,
              props: { label: 'Daily push budget', options: [{ label: '3', value: '3' }] },
              actions: [
                {
                  name: 'change',
                  path: 'fast',
                  plan: inputSetPlan(stateKey, { type: 'string', enum: ['3'] }),
                },
              ],
            },
          ],
        },
        state: { [stateKey]: '3' },
        freshness: { updatedAt: '2026-10-13T12:00:00Z', updatedBy: 'system' },
      }),
      'job',
      { daemonOwned: true },
    )
    const staleInvocation = fastInvocation(
      store,
      NOTIFICATION_SETTINGS_SURFACE_ID,
      'legacy-budget',
      'change',
      { value: '3' },
    )
    store.setPinned(NOTIFICATION_SETTINGS_SURFACE_ID, true, {
      origin: 'trusted:user',
      updatedBy: 'user',
    })
    const cursor = store.latestSurfaceCursor()
    manager.start()
    expect(store.surfaceEventsAfter(cursor)).toHaveLength(1)
    const surface = store.getSurface(NOTIFICATION_SETTINGS_SURFACE_ID)!
    expect(surface.state).toEqual({})
    expect(surface.pinned).toBe(true)
    expect(JSON.stringify(surface.tree)).not.toMatch(/budget|Select/i)
    expect(() =>
      store.invokeSurfaceAction(NOTIFICATION_SETTINGS_SURFACE_ID, staleInvocation),
    ).toThrow()
  })

  it('retires old fast Action receipts instead of replaying saved notification limits', () => {
    const { store } = setup()
    const db = new DatabaseSync(join(rootDir, 'surfaces.sqlite'))
    db.prepare('insert or ignore into fast_action_consumers (name) values (?)').run(
      'notification-settings',
    )
    db.prepare('insert into fast_action_consumers (name) values (?)').run('unrelated-recovery')
    const surface = store.createSurface(
      SurfaceSchema.parse({
        id: 'srf-recovery-fixture',
        spaceId: 'spc-health',
        title: 'Fixture',
        tree: {
          id: 'toggle',
          type: 'Checkbox',
          binding: 'enabled',
          props: { label: 'Enabled' },
          actions: [
            { name: 'toggle', path: 'fast', plan: inputSetPlan('enabled', { type: 'boolean' }) },
          ],
        },
        state: { enabled: false },
        freshness: { updatedAt: '2026-10-14T12:00:00Z', updatedBy: 'agent' },
      }),
      'agent',
    )
    const invocation = fastInvocation(store, surface.id, 'toggle', 'toggle', { value: true })
    store.invokeSurfaceAction(surface.id, invocation)
    const originalIntent = db
      .prepare('select * from fast_action_intents where intent_id = ?')
      .get(invocation.intentId)
    const unrelatedReceipt = db
      .prepare('select * from fast_action_receipts where consumer = ?')
      .get('unrelated-recovery')
    expect(
      db
        .prepare('select received from fast_action_receipts where consumer = ?')
        .get('notification-settings'),
    ).toMatchObject({ received: 0 })

    const restarted = new Store({ rootDir })
    expect(
      db
        .prepare('select name from fast_action_consumers where name = ?')
        .get('notification-settings'),
    ).toBeUndefined()
    expect(
      db
        .prepare('select * from fast_action_receipts where consumer = ?')
        .get('notification-settings'),
    ).toBeUndefined()
    expect(
      db.prepare('select * from fast_action_receipts where consumer = ?').get('unrelated-recovery'),
    ).toEqual(unrelatedReceipt)
    expect(
      db.prepare('select * from fast_action_intents where intent_id = ?').get(invocation.intentId),
    ).toEqual(originalIntent)
    expect(restarted.getSurface(surface.id)?.state).toEqual({ enabled: true })
    db.close()
  })
})
