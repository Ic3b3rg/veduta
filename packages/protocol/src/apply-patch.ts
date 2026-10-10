import type { Patch, PatchOperation } from './patch.ts'
import { parseSurface, type Surface } from './surface.ts'
import type { SurfacePatchEvent } from './gateway.ts'
import { JsonValueSchema, type JsonValue } from './json.ts'

import { applyPatchOperations } from './patch-application.ts'

/** Apply a protocol Patch to a Surface and validate the resulting Surface. */
export function applySurfacePatch(surface: Surface, patch: Patch): Surface {
  return applyPatchOperations(surface, patch, parseSurface)
}

export interface SurfacePatchInspectionStep {
  operation: PatchOperation
  before?: JsonValue
  after?: JsonValue
}

/** Read-only inspection uses the application algorithm and validates the complete ordered batch. */
export function inspectSurfacePatch(
  surface: Surface,
  patch: Patch,
): { surface: Surface; steps: SurfacePatchInspectionStep[] } {
  const steps: SurfacePatchInspectionStep[] = []
  const proposed = applyPatchOperations(surface, patch, parseSurface, (before, after) => {
    const operation = patch.operations[steps.length]
    if (!operation) throw new Error('missing operation in Surface patch inspection')
    steps.push({
      operation,
      ...(before === undefined ? {} : { before: JsonValueSchema.parse(before) }),
      ...(after === undefined ? {} : { after: JsonValueSchema.parse(after) }),
    })
  })
  return { surface: proposed, steps }
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
