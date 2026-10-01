import { z } from 'zod'
import { ChatMessageSchema, type ChatMessage } from './chat.ts'

/** Stable client retry identity; optional legacy invocations retain their existing contract. */
export const AgentActionIdempotencyKeySchema = z.string().min(1).max(128)

export const AgentActionTurnStatusSchema = z.enum(['queued', 'running', 'completed', 'failed'])

const AgentActionTurnIdentitySchema = z.object({
  id: z.string().min(1),
  spaceId: z.string().min(1),
  surfaceId: z.string().min(1),
  atomId: z.string().min(1),
  actionName: z.string().min(1),
  idempotencyKey: AgentActionIdempotencyKeySchema.optional(),
})

const AgentActionCompletionMessageSchema = ChatMessageSchema.refine(
  (message): message is ChatMessage & { role: 'assistant' } => message.role === 'assistant',
  { path: ['role'], message: 'Agent Action completion requires an assistant message' },
)

/** Public status of a turn in the existing Agent loop, without its private execution snapshot. */
export const AgentActionTurnSchema = z.discriminatedUnion('status', [
  AgentActionTurnIdentitySchema.extend({ status: z.literal('queued') }).strict(),
  AgentActionTurnIdentitySchema.extend({ status: z.literal('running') }).strict(),
  AgentActionTurnIdentitySchema.extend({
    status: z.literal('completed'),
    message: AgentActionCompletionMessageSchema,
    /** The client must observe this canonical Surface cut before acknowledging completion. */
    surfaceCursor: z.number().int().nonnegative(),
  }).strict(),
  AgentActionTurnIdentitySchema.extend({
    status: z.literal('failed'),
    error: z.string().min(1),
  }).strict(),
])

/** An HTTP queue acknowledgment remains queued until a terminal outcome is observed. */
export const AgentActionResultSchema = z.object({ turn: AgentActionTurnSchema }).strict()

export type AgentActionTurnStatus = z.infer<typeof AgentActionTurnStatusSchema>
export type AgentActionTurn = z.infer<typeof AgentActionTurnSchema>
export type AgentActionResult = z.infer<typeof AgentActionResultSchema>
