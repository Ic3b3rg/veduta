import { z } from 'zod'
import { PendingDecisionSchema } from './pending-decision.ts'

/** A completed global-chat result the PWA can link without changing route automatically. */
export const ChatResultTargetSchema = z
  .object({
    spaceId: z.string().min(1),
    spaceSlug: z.string().min(1),
    spaceName: z.string().min(1),
    surfaceId: z.string().min(1).optional(),
    surfaceTitle: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((target, ctx) => {
    if ((target.surfaceId === undefined) !== (target.surfaceTitle === undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: target.surfaceId === undefined ? ['surfaceId'] : ['surfaceTitle'],
        message: 'surfaceId and surfaceTitle must be provided together',
      })
    }
  })

export type ChatResultTarget = z.infer<typeof ChatResultTargetSchema>

/**
 * The chat contract on the daemon↔client boundary. Every message
 * crossing the WebSocket is one of these — neither side defines its
 * own local chat shape.
 */
export const ChatMessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  text: z.string(),
  targets: z.array(ChatResultTargetSchema).max(20).optional(),
  pendingDecisions: z.array(PendingDecisionSchema).max(10).optional(),
})

export type ChatMessage = z.infer<typeof ChatMessageSchema>

/** What a client sends over the chat WebSocket. */
export const ChatClientMessageSchema = z.object({
  text: z.string().min(1),
  spaceId: z.string().min(1).optional(),
})

export type ChatClientMessage = z.infer<typeof ChatClientMessageSchema>
