import { SurfaceSchema, type AuthDevice } from '@veduta/protocol'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { Store } from './store.ts'
import { ensureSystemSpace, SYSTEM_SPACE_ID } from './system-space.ts'
import {
  CONNECTED_DEVICES_SURFACE_ID,
  type ConnectedDevicesSource,
  ConnectedDevicesSurfaceManager,
} from './connected-devices-surface.ts'

const updatedAt = '2026-08-26T10:00:00.000Z'

describe('ConnectedDevicesSurfaceManager', () => {
  it('materializes one persisted daemon-owned Connected devices Surface at boot', () => {
    const now = () => new Date(updatedAt)
    const harness = createConnectedDevicesManagerHarness({ now })
    const { manager, rootDir, store } = harness

    manager.start()

    expect(SurfaceSchema.parse(store.getSurface(CONNECTED_DEVICES_SURFACE_ID))).toMatchObject({
      id: CONNECTED_DEVICES_SURFACE_ID,
      spaceId: SYSTEM_SPACE_ID,
      state: {
        devices: [{ device: 'Silvio iPhone', linked: '2026-08-20' }],
        status: 'Current',
        lastSuccessfulAt: updatedAt,
      },
    })
    expect(store.isSurfaceDaemonOwned(CONNECTED_DEVICES_SURFACE_ID)).toBe(true)
    expect(JSON.stringify(store.getSurface(CONNECTED_DEVICES_SURFACE_ID))).not.toContain(
      'credential-phone',
    )
    expect(store.eventLog(SYSTEM_SPACE_ID)).toContainEqual(
      expect.objectContaining({
        type: 'surface.create',
        origin: 'trusted:system',
        payload: { surfaceId: CONNECTED_DEVICES_SURFACE_ID },
      }),
    )
    expect(
      store
        .listSurfaces(SYSTEM_SPACE_ID)
        .filter((surface) => surface.id === CONNECTED_DEVICES_SURFACE_ID),
    ).toHaveLength(1)
    harness.close()

    const reopened = new Store({ rootDir, now })
    ensureSystemSpace(reopened.spacesEngine)
    expect(
      reopened
        .listSurfaces(SYSTEM_SPACE_ID)
        .filter((surface) => surface.id === CONNECTED_DEVICES_SURFACE_ID),
    ).toHaveLength(1)
    reopened.close()
  })

  it('refreshes persisted state through the normal Event and live-update lifecycle', () => {
    const now = () => new Date(updatedAt)
    const source = new MutableConnectedDevicesSource([device()])
    const harness = createConnectedDevicesManagerHarness({ now, source })
    const { manager, store } = harness
    manager.start()
    store.setPinned(CONNECTED_DEVICES_SURFACE_ID, true, {
      origin: 'trusted:user',
      updatedBy: 'user',
    })
    const beforeEvents = store.eventLog(SYSTEM_SPACE_ID)
    const liveEvents: ReturnType<Store['surfaceEventsAfter']> = []
    const unsubscribe = store.onSurfaceEvent((event) => liveEvents.push(event))

    source.set([device(), device({ id: 'dev-2', name: 'MacBook', credentialId: 'credential-mac' })])
    source.notify()

    expect(SurfaceSchema.parse(store.getSurface(CONNECTED_DEVICES_SURFACE_ID))).toMatchObject({
      pinned: true,
      state: {
        devices: [
          { device: 'Silvio iPhone', linked: '2026-08-20' },
          { device: 'MacBook', linked: '2026-08-20' },
        ],
      },
    })
    expect(store.eventLog(SYSTEM_SPACE_ID).slice(beforeEvents.length)).toEqual([
      expect.objectContaining({
        type: 'surface.patch_state',
        origin: 'trusted:system',
        payload: { surfaceId: CONNECTED_DEVICES_SURFACE_ID, operations: 1 },
      }),
    ])
    expect(liveEvents).toEqual([
      expect.objectContaining({
        kind: 'patch',
        event: expect.objectContaining({ spaceId: SYSTEM_SPACE_ID }),
      }),
    ])

    unsubscribe()
    harness.close()
  })

  it('persists an equivalent successful refresh time for a later failure after restart', () => {
    let clock = new Date(updatedAt)
    const now = () => clock
    const rootDir = mkdtempSync(join(tmpdir(), 'veduta-connected-devices-restart-'))
    const first = createConnectedDevicesManagerHarness({ rootDir, now })
    first.manager.start()
    first.close()

    clock = new Date('2026-08-26T11:00:00.000Z')
    const second = createConnectedDevicesManagerHarness({ rootDir, now })
    second.manager.start()
    expect(second.store.getSurface(CONNECTED_DEVICES_SURFACE_ID)?.state).toMatchObject({
      status: 'Current',
      lastSuccessfulAt: '2026-08-26T11:00:00.000Z',
    })
    second.close()

    clock = new Date('2026-08-26T12:00:00.000Z')
    const third = createConnectedDevicesManagerHarness({
      rootDir,
      now,
      source: new MutableConnectedDevicesSource(new Error('temporary device source failure')),
    })
    third.manager.start()
    expect(third.store.getSurface(CONNECTED_DEVICES_SURFACE_ID)?.state).toMatchObject({
      status: 'Stale — device source unavailable; showing last valid inventory',
      lastSuccessfulAt: '2026-08-26T11:00:00.000Z',
    })
    third.close()
  })

  it('keeps the last valid inventory visible through a source failure and repairs in place', () => {
    let clock = new Date(updatedAt)
    const now = () => clock
    const source = new MutableConnectedDevicesSource([device()])
    const harness = createConnectedDevicesManagerHarness({ now, source })
    const { manager, store } = harness
    manager.start()
    const beforeEvents = store.eventLog(SYSTEM_SPACE_ID).length

    clock = new Date('2026-08-26T10:05:00.000Z')
    source.set(new Error('credential material must never be rendered'))
    expect(() => source.notify()).not.toThrow()

    const stale = SurfaceSchema.parse(store.getSurface(CONNECTED_DEVICES_SURFACE_ID))
    expect(stale).toMatchObject({
      id: CONNECTED_DEVICES_SURFACE_ID,
      state: {
        devices: [{ device: 'Silvio iPhone', linked: '2026-08-20' }],
        status: 'Stale — device source unavailable; showing last valid inventory',
        lastSuccessfulAt: updatedAt,
      },
    })
    expect(JSON.stringify(stale)).not.toContain('credential material')

    clock = new Date('2026-08-26T10:10:00.000Z')
    source.set([device({ name: 'Pocket phone' })])
    source.notify()

    expect(SurfaceSchema.parse(store.getSurface(CONNECTED_DEVICES_SURFACE_ID))).toMatchObject({
      id: CONNECTED_DEVICES_SURFACE_ID,
      state: {
        devices: [{ device: 'Pocket phone', linked: '2026-08-20' }],
        status: 'Current',
        lastSuccessfulAt: '2026-08-26T10:10:00.000Z',
      },
    })
    expect(store.eventLog(SYSTEM_SPACE_ID).slice(beforeEvents)).toEqual([
      expect.objectContaining({ type: 'surface.patch_state' }),
      expect.objectContaining({ type: 'surface.patch_state' }),
    ])
    expect(
      store
        .listSurfaces(SYSTEM_SPACE_ID)
        .filter((surface) => surface.id === CONNECTED_DEVICES_SURFACE_ID),
    ).toHaveLength(1)

    harness.close()
  })

  it('materializes an unavailable first-boot Surface and retries without a request', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date(updatedAt))
      const now = () => new Date()
      const source = new MutableConnectedDevicesSource(new Error('temporary device source failure'))
      const harness = createConnectedDevicesManagerHarness({ now, source })
      const { manager, store } = harness

      manager.start()

      expect(
        SurfaceSchema.parse(store.getSurface(CONNECTED_DEVICES_SURFACE_ID)).state,
      ).toMatchObject({
        devices: [],
        status: 'Stale — device source unavailable; showing last valid inventory',
        lastSuccessfulAt: 'No successful refresh yet',
      })

      source.set([device()])
      await vi.advanceTimersByTimeAsync(60_000)

      expect(
        SurfaceSchema.parse(store.getSurface(CONNECTED_DEVICES_SURFACE_ID)).state,
      ).toMatchObject({
        devices: [{ device: 'Silvio iPhone', linked: '2026-08-20' }],
        status: 'Current',
        lastSuccessfulAt: '2026-08-26T10:01:00.000Z',
      })
      expect(
        store
          .listSurfaces(SYSTEM_SPACE_ID)
          .filter((surface) => surface.id === CONNECTED_DEVICES_SURFACE_ID),
      ).toHaveLength(1)

      harness.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('refuses to adopt a daemon-owned identity collision outside the System Space', () => {
    expectConnectedDevicesIdentityCollisionRejected({
      spaceId: 'spc-health',
      daemonOwned: true,
    })
  })

  it('refuses to adopt a non-daemon-owned identity collision in the System Space', () => {
    expectConnectedDevicesIdentityCollisionRejected({
      spaceId: SYSTEM_SPACE_ID,
      daemonOwned: false,
    })
  })
})

class MutableConnectedDevicesSource implements ConnectedDevicesSource {
  private listener = () => {}

  constructor(private current: AuthDevice[] | Error) {}

  connectedDevices(): AuthDevice[] {
    if (this.current instanceof Error) throw this.current
    return this.current
  }

  onConnectedDevicesChange(listener: () => void): () => void {
    this.listener = listener
    return () => {
      this.listener = () => {}
    }
  }

  set(current: AuthDevice[] | Error): void {
    this.current = current
  }

  notify(): void {
    this.listener()
  }
}

function createConnectedDevicesManagerHarness(
  options: {
    rootDir?: string
    now?: () => Date
    source?: ConnectedDevicesSource
  } = {},
): {
  rootDir: string
  store: Store
  manager: ConnectedDevicesSurfaceManager
  close(): void
} {
  const now = options.now ?? (() => new Date(updatedAt))
  const rootDir =
    options.rootDir ?? mkdtempSync(join(tmpdir(), 'veduta-connected-devices-surface-'))
  const store = new Store({ rootDir, now })
  ensureSystemSpace(store.spacesEngine)
  const manager = new ConnectedDevicesSurfaceManager({
    store,
    source: options.source ?? new MutableConnectedDevicesSource([device()]),
    now,
  })
  return {
    rootDir,
    store,
    manager,
    close() {
      manager.dispose()
      store.close()
    },
  }
}

function device(overrides: Partial<AuthDevice> = {}): AuthDevice {
  return {
    id: 'dev-1',
    name: 'Silvio iPhone',
    credentialId: 'credential-phone',
    createdAt: '2026-08-20T09:00:00.000Z',
    lastSeenAt: '2026-08-26T09:55:00.000Z',
    ...overrides,
  }
}

function expectConnectedDevicesIdentityCollisionRejected(options: {
  spaceId: string
  daemonOwned: boolean
}): void {
  const now = () => new Date(updatedAt)
  let subscriptionActive = false
  const harness = createConnectedDevicesManagerHarness({
    now,
    source: {
      connectedDevices: () => [device()],
      onConnectedDevicesChange: () => {
        subscriptionActive = true
        return () => {
          subscriptionActive = false
        }
      },
    },
  })
  const { manager, store } = harness
  const impostor = SurfaceSchema.parse({
    id: CONNECTED_DEVICES_SURFACE_ID,
    spaceId: options.spaceId,
    title: 'Connected devices impostor',
    tree: { id: 'root', type: 'Box' },
    state: {},
    freshness: { updatedAt, updatedBy: 'system' },
  })
  if (options.daemonOwned) {
    store.createSurface(impostor, 'job', { daemonOwned: true })
  } else {
    store.createSurface(impostor, 'job')
  }
  const beforeStart = store.getSurface(CONNECTED_DEVICES_SURFACE_ID)

  try {
    expect(() => manager.start()).toThrow(/refusing to adopt Surface "srf-connected-devices"/)
    expect(subscriptionActive).toBe(false)
    expect(store.getSurface(CONNECTED_DEVICES_SURFACE_ID)).toEqual(beforeStart)
  } finally {
    harness.close()
  }
}
