import {
  SYSTEM_SPACE_ID,
  SpaceSchema,
  type Space,
  type Surface,
  type SurfaceSnapshot,
} from '@veduta/protocol'
import type { SpacesEngine } from './spaces-engine.ts'

export { SYSTEM_SPACE_ID } from '@veduta/protocol'
const SYSTEM_SPACE_SLUG = 'system'
const SYSTEM_SPACE_NAME = 'System'

/**
 * Materializes the System Space as a real, persisted Space (issue #14):
 * the trust admin Surfaces (allowlist, audit) need a durable home a
 * user can navigate to, so it can no longer stay purely synthetic like
 * the remaining Connected devices request projection. This is a deliberate,
 * documented deviation from "every Space is user-confirmed" (ADR-0002's
 * proposal→confirm flow) — the System Space is daemon-created at boot,
 * not proposed, because it is not a life area the user chose but
 * infrastructure the daemon itself owns.
 */
export function ensureSystemSpace(spacesEngine: SpacesEngine): Space {
  return spacesEngine.ensureSystemSpace({ name: SYSTEM_SPACE_NAME, slug: SYSTEM_SPACE_SLUG })
}

/**
 * Compatibility helper retained until issue #117 removes the obsolete
 * synthetic System Space path. No snapshot route calls it after issue #115.
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
  return {
    ...snapshot,
    spaces: [
      ...snapshot.spaces,
      { ...systemSpace, surfaces: [surface], attention: 0, attentionRevision: 0 },
    ],
  }
}
