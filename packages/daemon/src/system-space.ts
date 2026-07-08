import { SpaceSchema, type Surface, type SurfaceSnapshot } from '@veduta/protocol'

export const SYSTEM_SPACE_ID = 'spc-system'

/**
 * The synthetic System Space: computed at read time for daemon-owned
 * Surfaces (usage, connected devices), never persisted by SpacesEngine.
 */
export function appendSystemSurface(snapshot: SurfaceSnapshot, surface: Surface): SurfaceSnapshot {
  if (snapshot.spaces.some((space) => space.id === SYSTEM_SPACE_ID)) {
    return {
      ...snapshot,
      spaces: snapshot.spaces.map((space) =>
        space.id === SYSTEM_SPACE_ID ? { ...space, surfaces: [...space.surfaces, surface] } : space,
      ),
    }
  }
  const systemSpace = SpaceSchema.parse({
    id: SYSTEM_SPACE_ID,
    slug: 'system',
    name: 'System',
    archived: false,
  })
  return { ...snapshot, spaces: [...snapshot.spaces, { ...systemSpace, surfaces: [surface] }] }
}
