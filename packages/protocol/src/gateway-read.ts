import { z } from 'zod'
import {
  PinSurfaceResultSchema,
  SpaceWithSurfacesSchema,
  SurfaceSnapshotSchema,
  SurfacePatchEventObjectSchema,
  refineSurfacePatchEvent,
  surfaceCreatedEventSchema,
  gatewayServerMessageSchema,
} from './gateway.ts'
import {
  CommittedFastActionOutcomeObjectSchema,
  refineCommittedFastActionOutcome,
  NoopFastActionOutcomeSchema,
  RecoveryPendingFastActionOutcomeSchema,
} from './action-outcome.ts'
import { RenderableSurfaceSchema } from './surface-read.ts'
import { RenderablePatchSchema } from './patch-read.ts'

export const RenderableSpaceWithSurfacesSchema = SpaceWithSurfacesSchema.extend({
  surfaces: z.array(RenderableSurfaceSchema),
})
export const RenderableSurfaceSnapshotSchema = SurfaceSnapshotSchema.extend({
  spaces: z.array(RenderableSpaceWithSurfacesSchema),
})
export const RenderableCommittedFastActionOutcomeSchema =
  CommittedFastActionOutcomeObjectSchema.extend({
    surface: RenderableSurfaceSchema,
    patch: RenderablePatchSchema,
  }).superRefine(refineCommittedFastActionOutcome)
export const RenderableFastActionOutcomeSchema = z.union([
  RenderableCommittedFastActionOutcomeSchema,
  NoopFastActionOutcomeSchema,
  RecoveryPendingFastActionOutcomeSchema,
])
export const RenderableFastSurfaceActionResultSchema = RenderableFastActionOutcomeSchema
export const RenderablePinSurfaceResultSchema = PinSurfaceResultSchema.extend({
  surface: RenderableSurfaceSchema,
})
export const RenderableSurfaceCreatedEventSchema =
  surfaceCreatedEventSchema(RenderableSurfaceSchema)
export const RenderableSurfacePatchEventSchema = SurfacePatchEventObjectSchema.extend({
  patch: RenderablePatchSchema,
}).superRefine(refineSurfacePatchEvent)
export type RenderableSurfacePatchEvent = z.infer<typeof RenderableSurfacePatchEventSchema>
export const RenderableGatewayServerMessageSchema = gatewayServerMessageSchema(
  RenderableSurfaceCreatedEventSchema,
  RenderableSurfacePatchEventSchema,
)

export type RenderableSurfaceSnapshot = z.infer<typeof RenderableSurfaceSnapshotSchema>
export type RenderableFastSurfaceActionResult = z.infer<
  typeof RenderableFastSurfaceActionResultSchema
>
export type RenderableFastActionOutcome = z.infer<typeof RenderableFastActionOutcomeSchema>
export type RenderableCommittedFastActionOutcome = z.infer<
  typeof RenderableCommittedFastActionOutcomeSchema
>
export type RenderablePinSurfaceResult = z.infer<typeof RenderablePinSurfaceResultSchema>
export type RenderableSurfaceCreatedEvent = z.infer<typeof RenderableSurfaceCreatedEventSchema>
export type RenderableGatewayServerMessage = z.infer<typeof RenderableGatewayServerMessageSchema>
