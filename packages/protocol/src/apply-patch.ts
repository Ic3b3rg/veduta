import type { Patch } from './patch.ts'
import { parseSurface, type Surface } from './surface.ts'
import type { SurfacePatchEvent } from './gateway.ts'

import { applyPatchOperations } from './patch-application.ts'

/** Apply a protocol Patch to a Surface and validate the resulting Surface. */
export function applySurfacePatch(surface: Surface, patch: Patch): Surface {
  return applyPatchOperations(surface, patch, parseSurface)
}

/** Apply a replayable Gateway patch event, including Surface freshness metadata. */
export function applySurfacePatchEvent(surface: Surface, event: SurfacePatchEvent): Surface {
  const patched = applySurfacePatch(surface, event.patch)
  return parseSurface({
    ...patched,
    freshness: event.freshness,
    ...(event.validity === undefined ? {} : { validity: event.validity }),
  })
}
