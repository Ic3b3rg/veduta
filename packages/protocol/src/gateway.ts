import { z } from 'zod'
import { AuthSessionTokenSchema } from './auth.ts'
import { ChatClientMessageSchema, ChatMessageSchema } from './chat.ts'
import { ActionInvocationSchema, PatchSchema } from './patch.ts'
import { SpaceSchema } from './space.ts'
import { FreshnessSchema, SurfaceSchema } from './surface.ts'

export const GatewayCursorSchema = z.number().int().nonnegative()

export const SpaceWithSurfacesSchema = SpaceSchema.extend({
  surfaces: z.array(SurfaceSchema),
})

export const SurfaceSnapshotSchema = z.object({
  surfaceCursor: GatewayCursorSchema,
  spaces: z.array(SpaceWithSurfacesSchema),
})

export const SurfacePatchEventSchema = z.object({
  cursor: GatewayCursorSchema,
  at: z.string().datetime(),
  spaceId: z.string().min(1),
  patch: PatchSchema,
  freshness: FreshnessSchema,
})

export const PresenceStatusSchema = z.enum(['online', 'away'])

export const PresenceEntrySchema = z.object({
  clientId: z.string().min(1),
  status: PresenceStatusSchema,
  connectedAt: z.string().datetime(),
  lastSeenAt: z.string().datetime(),
})

export const ApprovalCardSchema = z.object({
  id: z.string().min(1),
  level: z.enum(['L1', 'L2']),
  title: z.string().min(1),
  body: z.string().min(1),
  actionLabel: z.string().min(1),
  createdAt: z.string().datetime(),
})

export const GatewayClientMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('hello'),
    clientId: z.string().min(1).optional(),
    surfaceCursor: GatewayCursorSchema.default(0),
    token: AuthSessionTokenSchema.optional(),
  }),
  z
    .object({
      type: z.literal('chat.send'),
    })
    .merge(ChatClientMessageSchema),
  z.object({
    type: z.literal('surface.action'),
    surfaceId: z.string().min(1),
    invocation: ActionInvocationSchema,
  }),
  z.object({
    type: z.literal('presence.update'),
    status: PresenceStatusSchema,
  }),
])

export const GatewayServerMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('hello'),
    clientId: z.string().min(1),
    surfaceCursor: GatewayCursorSchema,
    replayed: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal('surface.patch'),
    event: SurfacePatchEventSchema,
  }),
  z.object({
    type: z.literal('chat.message'),
    message: ChatMessageSchema,
  }),
  z.object({
    type: z.literal('approval.card'),
    card: ApprovalCardSchema,
  }),
  z.object({
    type: z.literal('presence.update'),
    presence: z.array(PresenceEntrySchema),
  }),
  z.object({
    type: z.literal('error'),
    error: z.string().min(1),
  }),
])

export type GatewayCursor = z.infer<typeof GatewayCursorSchema>
export type SpaceWithSurfaces = z.infer<typeof SpaceWithSurfacesSchema>
export type SurfaceSnapshot = z.infer<typeof SurfaceSnapshotSchema>
export type SurfacePatchEvent = z.infer<typeof SurfacePatchEventSchema>
export type PresenceStatus = z.infer<typeof PresenceStatusSchema>
export type PresenceEntry = z.infer<typeof PresenceEntrySchema>
export type ApprovalCard = z.infer<typeof ApprovalCardSchema>
export type GatewayClientMessage = z.infer<typeof GatewayClientMessageSchema>
export type GatewayServerMessage = z.infer<typeof GatewayServerMessageSchema>
