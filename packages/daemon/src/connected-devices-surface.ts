import { SurfaceSchema, type AuthDevice, type SurfaceSnapshot } from '@veduta/protocol'
import { SYSTEM_SPACE_ID, appendSystemSurface } from './system-space.ts'

export function appendConnectedDevicesSurface(
  snapshot: SurfaceSnapshot,
  devices: AuthDevice[],
  updatedAt = new Date().toISOString(),
): SurfaceSnapshot {
  const surface = SurfaceSchema.parse({
    id: 'srf-connected-devices',
    spaceId: SYSTEM_SPACE_ID,
    title: 'Connected devices',
    tree: {
      id: 'root',
      type: 'Box',
      children: [
        { id: 'title', type: 'Title', props: { text: 'Connected devices' } },
        ...devices.map((device) => ({
          id: `device-${device.id}`,
          type: 'Text' as const,
          props: { text: `${device.name} linked ${shortDate(device.createdAt)}` },
        })),
      ],
    },
    state: {},
    freshness: { updatedAt, updatedBy: 'system' },
  })
  return appendSystemSurface(snapshot, surface)
}

function shortDate(iso: string): string {
  return iso.slice(0, 10)
}
