import { z } from 'zod'
import { AuthSessionTokenSchema } from './auth.ts'
import { ChatClientMessageSchema, ChatMessageSchema } from './chat.ts'
import { ActionInvocationSchema, PatchSchema } from './patch.ts'
import { SpaceSchema } from './space.ts'
import { FreshnessSchema, SurfaceSchema } from './surface.ts'

export const GatewayCursorSchema = z.number().int().nonnegative()

export const SpaceWithSurfacesSchema = SpaceSchema.extend({
  surfaces: z.array(SurfaceSchema),
  attention: z.number().int().min(0).default(0),
  attentionRevision: z.number().int().min(0).default(0),
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
  surfaceId: z.string().min(1),
  expiresAt: z.string().datetime(),
})

export const SurfaceCreatedEventSchema = z.object({
  cursor: GatewayCursorSchema,
  at: z.string().datetime(),
  spaceId: z.string().min(1),
  surface: SurfaceSchema,
})

export const SurfaceArchivedEventSchema = z.object({
  cursor: GatewayCursorSchema,
  at: z.string().datetime(),
  spaceId: z.string().min(1),
  surfaceId: z.string().min(1),
})

/**
 * Identifies the PWA client and logical chat turn that initiated a live
 * operation. This is delivery metadata, not durable Surface state: replayed
 * events intentionally omit it so reconnects cannot repeat local feedback.
 */
export const ChatTurnCorrelationSchema = z.object({
  clientId: z.string().min(1),
  turnId: z.string().min(1),
})

export const SurfacePinnedEventSchema = z.object({
  cursor: GatewayCursorSchema,
  at: z.string().datetime(),
  spaceId: z.string().min(1),
  surfaceId: z.string().min(1),
  pinned: z.boolean(),
  // The bumped freshness `setPinned` persists: without
  // it, a client applying this event in place had no way to move its own
  // `updatedAt`/`updatedBy` off whatever it last observed, and rendered a pin
  // as current while the rest of the Surface still looked stale. Mirrors
  // `SurfacePatchEventSchema`'s own `freshness` field.
  freshness: FreshnessSchema,
})

// Turn-lifecycle frames for the streamed Agent chat turn (issue #37): a turn
// opens with `chat.turn-start`, streams its answer as zero or more
// `chat.turn-delta` fragments, then closes with exactly one of
// `chat.turn-end` (the complete final message) or `chat.turn-error`.
// `chat.message` remains for system notices, which are never streamed. Every
// frame carries `spaceId` so a client can scope a delta to its Space without
// keeping start-frame side state.
export const ChatTurnStartMessageSchema = z.object({
  type: z.literal('chat.turn-start'),
  turnId: z.string().min(1),
  spaceId: z.string().optional(),
})

export const ChatTurnDeltaMessageSchema = z.object({
  type: z.literal('chat.turn-delta'),
  turnId: z.string().min(1),
  spaceId: z.string().optional(),
  text: z.string(),
})

export const ChatTurnEndMessageSchema = z.object({
  type: z.literal('chat.turn-end'),
  turnId: z.string().min(1),
  spaceId: z.string().optional(),
  message: ChatMessageSchema,
})

export const ChatTurnErrorMessageSchema = z.object({
  type: z.literal('chat.turn-error'),
  turnId: z.string().min(1),
  spaceId: z.string().optional(),
  error: z.string(),
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
    type: z.literal('surface.created'),
    event: SurfaceCreatedEventSchema,
    initiatingTurn: ChatTurnCorrelationSchema.optional(),
  }),
  z.object({
    type: z.literal('surface.archived'),
    event: SurfaceArchivedEventSchema,
  }),
  z.object({
    type: z.literal('surface.pinned'),
    event: SurfacePinnedEventSchema,
  }),
  z.object({
    type: z.literal('chat.message'),
    message: ChatMessageSchema,
  }),
  ChatTurnStartMessageSchema,
  ChatTurnDeltaMessageSchema,
  ChatTurnEndMessageSchema,
  ChatTurnErrorMessageSchema,
  z.object({
    type: z.literal('approval.card'),
    card: ApprovalCardSchema,
  }),
  z.object({
    type: z.literal('presence.update'),
    presence: z.array(PresenceEntrySchema),
  }),
  z.object({
    type: z.literal('space.attention'),
    spaceId: z.string().min(1),
    count: z.number().int().min(0),
    revision: z.number().int().min(0),
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
export type SurfaceCreatedEvent = z.infer<typeof SurfaceCreatedEventSchema>
export type SurfaceArchivedEvent = z.infer<typeof SurfaceArchivedEventSchema>
export type SurfacePinnedEvent = z.infer<typeof SurfacePinnedEventSchema>
export type ChatTurnCorrelation = z.infer<typeof ChatTurnCorrelationSchema>
export type ChatTurnStartMessage = z.infer<typeof ChatTurnStartMessageSchema>
export type ChatTurnDeltaMessage = z.infer<typeof ChatTurnDeltaMessageSchema>
export type ChatTurnEndMessage = z.infer<typeof ChatTurnEndMessageSchema>
export type ChatTurnErrorMessage = z.infer<typeof ChatTurnErrorMessageSchema>
export type PresenceStatus = z.infer<typeof PresenceStatusSchema>
export type PresenceEntry = z.infer<typeof PresenceEntrySchema>
export type ApprovalCard = z.infer<typeof ApprovalCardSchema>
export type GatewayClientMessage = z.infer<typeof GatewayClientMessageSchema>
export type GatewayServerMessage = z.infer<typeof GatewayServerMessageSchema>
