import { SurfaceSchema, type AuthDevice, type JsonValue, type Surface } from '@veduta/protocol'
import type { Store } from './store.ts'
import { SYSTEM_SPACE_ID } from './system-space.ts'
import { statePatchOperations } from './system-surface-state.ts'

const CURRENT_STATUS = 'Current'
const SOURCE_RETRY_MS = 60_000
const STALE_STATUS = 'Stale — device source unavailable; showing last valid inventory'
export const CONNECTED_DEVICES_SURFACE_ID = 'srf-connected-devices'

export function connectedDevicesSurface(devices: AuthDevice[], lastSuccessfulAt: string): Surface {
  return SurfaceSchema.parse({
    id: CONNECTED_DEVICES_SURFACE_ID,
    spaceId: SYSTEM_SPACE_ID,
    title: 'Connected devices',
    tree: {
      id: 'root',
      type: 'Box',
      children: [
        { id: 'title', type: 'Title', props: { text: 'Connected devices' } },
        {
          id: 'subtitle',
          type: 'Caption',
          props: { text: 'Passkeys registered with this Veduta installation.' },
        },
        {
          id: 'device-health',
          type: 'Row',
          children: [
            { id: 'stat-status', type: 'Stat', binding: 'status', props: { label: 'Status' } },
            {
              id: 'stat-last-success',
              type: 'Stat',
              binding: 'lastSuccessfulAt',
              props: { label: 'Last successful refresh' },
            },
          ],
        },
        {
          id: 'devices',
          type: 'Table',
          binding: 'devices',
          props: { columns: ['device', 'linked'] },
        },
      ],
    },
    state: {
      devices: devices.map((device) => ({
        device: device.name,
        linked: device.createdAt.slice(0, 10),
      })),
      status: CURRENT_STATUS,
      lastSuccessfulAt,
    },
    freshness: { updatedAt: lastSuccessfulAt, updatedBy: 'system' },
  })
}

export interface ConnectedDevicesSource {
  connectedDevices(): AuthDevice[]
  onConnectedDevicesChange(listener: () => void): () => void
}

export interface ConnectedDevicesSurfaceManagerOptions {
  store: Store
  source: ConnectedDevicesSource
  now?: () => Date
}

export class ConnectedDevicesSurfaceManager {
  private readonly store: Store
  private readonly source: ConnectedDevicesSource
  private readonly now: () => Date
  private disposeChange: (() => void) | undefined
  private refreshTimer: ReturnType<typeof setTimeout> | undefined

  constructor(options: ConnectedDevicesSurfaceManagerOptions) {
    this.store = options.store
    this.source = options.source
    this.now = options.now ?? (() => new Date())
  }

  start(): void {
    if (this.disposeChange) return
    this.disposeChange = this.source.onConnectedDevicesChange(this.refresh)
    try {
      this.refresh()
    } catch (error) {
      this.dispose()
      throw error
    }
  }

  refresh = (): void => {
    const sourceAvailable = this.refreshSurface()
    if (sourceAvailable) {
      this.clearScheduledRefresh()
    } else {
      this.scheduleRefresh(SOURCE_RETRY_MS)
    }
  }

  dispose(): void {
    this.disposeChange?.()
    this.disposeChange = undefined
    this.clearScheduledRefresh()
  }

  private refreshSurface(): boolean {
    const refreshedAt = this.now().toISOString()
    let devices: AuthDevice[]
    try {
      devices = this.source.connectedDevices()
    } catch {
      this.markStale(refreshedAt)
      return false
    }
    const next = connectedDevicesSurface(devices, refreshedAt)
    const existing = this.store.getSurface(CONNECTED_DEVICES_SURFACE_ID)
    if (!existing) {
      this.store.createSurface(next, 'job', { daemonOwned: true })
      return true
    }
    this.requireCanonicalSurface(existing)
    const operations = statePatchOperations(existing.state, next.state)
    if (operations.length > 0) {
      this.store.patchState(CONNECTED_DEVICES_SURFACE_ID, operations, { updatedBy: 'job' })
    }
    return true
  }

  private markStale(failedAt: string): void {
    const existing = this.store.getSurface(CONNECTED_DEVICES_SURFACE_ID)
    if (!existing) {
      this.store.createSurface(unavailableConnectedDevicesSurface(failedAt), 'job', {
        daemonOwned: true,
      })
      return
    }
    this.requireCanonicalSurface(existing)
    const staleState: Record<string, JsonValue> = {
      ...existing.state,
      status: STALE_STATUS,
    }
    const operations = statePatchOperations(existing.state, staleState)
    if (operations.length === 0) return
    this.store.patchState(CONNECTED_DEVICES_SURFACE_ID, operations, { updatedBy: 'job' })
  }

  private requireCanonicalSurface(surface: Surface): void {
    if (
      surface.spaceId === SYSTEM_SPACE_ID &&
      this.store.isSurfaceDaemonOwned(CONNECTED_DEVICES_SURFACE_ID)
    ) {
      return
    }
    throw new Error(
      `connected devices surface: refusing to adopt Surface "${CONNECTED_DEVICES_SURFACE_ID}"; ` +
        'expected a daemon-owned Surface in the canonical System Space',
    )
  }

  private scheduleRefresh(delayMs: number): void {
    this.clearScheduledRefresh()
    this.refreshTimer = setTimeout(this.refresh, delayMs)
    this.refreshTimer.unref?.()
  }

  private clearScheduledRefresh(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer)
    this.refreshTimer = undefined
  }
}

function unavailableConnectedDevicesSurface(failedAt: string): Surface {
  const surface = connectedDevicesSurface([], failedAt)
  return SurfaceSchema.parse({
    ...surface,
    state: {
      ...surface.state,
      status: STALE_STATUS,
      lastSuccessfulAt: 'No successful refresh yet',
    },
  })
}
