import {
  SpaceSchema,
  SurfaceSchema,
  type AuthDevice,
  type SpaceWithSurfaces,
  type SurfaceSnapshot,
} from '@veduta/protocol'

export function appendConnectedDevicesSurface(
  snapshot: SurfaceSnapshot,
  devices: AuthDevice[],
  updatedAt = new Date().toISOString(),
): SurfaceSnapshot {
  const systemSpace = SpaceSchema.parse({
    id: 'spc-system',
    slug: 'system',
    name: 'System',
    archived: false,
  })
  const surface = SurfaceSchema.parse({
    id: 'srf-connected-devices',
    spaceId: systemSpace.id,
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
  const spaceWithSurfaces: SpaceWithSurfaces = {
    ...systemSpace,
    surfaces: [surface],
  }
  return {
    ...snapshot,
    spaces: [...snapshot.spaces, spaceWithSurfaces],
  }
}

function shortDate(iso: string): string {
  return iso.slice(0, 10)
}
