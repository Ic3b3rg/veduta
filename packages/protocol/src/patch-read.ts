import { z } from 'zod'
import { RenderableAtomNodeSchema } from './atom-read.ts'
import { PatchSchema, patchOperationSchema } from './patch.ts'
import { applyPatchOperations } from './patch-application.ts'
import { RenderableSurfaceSchema, type RenderableSurface } from './surface-read.ts'
import type { RenderableSurfacePatchEvent } from './gateway-read.ts'

export const RenderablePatchOperationSchema = patchOperationSchema(RenderableAtomNodeSchema)
export const RenderablePatchSchema = PatchSchema.extend({
  operations: z.array(RenderablePatchOperationSchema).min(1),
})
export type RenderablePatchOperation = z.infer<typeof RenderablePatchOperationSchema>
export type RenderablePatch = z.infer<typeof RenderablePatchSchema>

/** Validate a received patch result while preserving unknown Atom metadata for replay. */
export function applyRenderableSurfacePatch(
  surface: RenderableSurface,
  patch: RenderablePatch,
): RenderableSurface {
  return applyPatchOperations(surface, patch, (value) => RenderableSurfaceSchema.parse(value))
}

export function applyRenderableSurfacePatchEvent(
  surface: RenderableSurface,
  event: RenderableSurfacePatchEvent,
): RenderableSurface {
  const patched = applyRenderableSurfacePatch(surface, event.patch)
  return RenderableSurfaceSchema.parse({
    ...patched,
    freshness: event.freshness,
    ...(event.validity === undefined ? {} : { validity: event.validity }),
  })
}
