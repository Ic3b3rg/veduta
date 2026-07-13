import { SpaceSchema, type Space, type Surface, type SurfaceSnapshot } from '@veduta/protocol'
import type { SpacesEngine } from './spaces-engine.ts'

export const SYSTEM_SPACE_ID = 'spc-system'
const SYSTEM_SPACE_SLUG = 'system'
const SYSTEM_SPACE_NAME = 'System'

/**
 * Materializes the System Space as a real, persisted Space (issue #14,
 * D8): the trust admin Surfaces (allowlist, audit) need a durable home a
 * user can navigate to, so it can no longer stay purely synthetic like
 * the usage/connected-devices Surfaces below. This is a deliberate,
 * documented deviation from "every Space is user-confirmed" (ADR-0002's
 * proposal→confirm flow) — the System Space is daemon-created at boot,
 * not proposed, because it is not a life area the user chose but
 * infrastructure the daemon itself owns. `appendSystemSurface` keeps
 * working unchanged afterward: once `spc-system` exists in the snapshot,
 * it takes the "merge into existing Space" branch below instead of
 * synthesizing one.
 */
export function ensureSystemSpace(spacesEngine: SpacesEngine): Space {
  const existing = spacesEngine.getSpace(SYSTEM_SPACE_ID)
  if (!existing) {
    return spacesEngine.createSpace({ name: SYSTEM_SPACE_NAME, slug: SYSTEM_SPACE_SLUG })
  }
  if (existing.archived) {
    return spacesEngine.restoreSpace(SYSTEM_SPACE_ID)
  }
  return existing
}

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
