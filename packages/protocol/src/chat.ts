import { z } from 'zod'
import {
  parsePendingDecisionId,
  pendingDecisionChatFeedback,
  PendingDecisionSchema,
} from './pending-decision.ts'

export const MAX_CHAT_PENDING_DECISION_REFERENCES = 10

const PendingDecisionReferenceIdSchema = z
  .string()
  .min(1)
  .max(300)
  .refine((id) => parsePendingDecisionId(id) !== undefined, 'invalid Pending decision id')

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
export const ChatMessageSchema = z
  .object({
    role: z.enum(['user', 'assistant']),
    text: z.string(),
    targets: z.array(ChatResultTargetSchema).max(20).optional(),
    pendingDecisions: z
      .array(PendingDecisionSchema)
      .max(MAX_CHAT_PENDING_DECISION_REFERENCES)
      .optional(),
    pendingDecisionIds: z
      .array(PendingDecisionReferenceIdSchema)
      .max(MAX_CHAT_PENDING_DECISION_REFERENCES)
      .optional(),
    decisionFeedbackId: z.string().min(1).max(300).optional(),
  })
  .superRefine((message, context) => {
    const referencedIds = message.pendingDecisionIds ?? []
    if (new Set(referencedIds).size !== referencedIds.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['pendingDecisionIds'],
        message: 'Pending decision references must be unique',
      })
    }
    const decisions = message.pendingDecisions ?? []
    const projectedIds = new Set(decisions.map((decision) => decision.id))
    if (projectedIds.size !== decisions.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['pendingDecisions'],
        message: 'projected Pending decisions must have unique ids',
      })
    }
    if (referencedIds.some((id) => projectedIds.has(id))) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['pendingDecisionIds'],
        message: 'an id cannot be both projected and unprojected',
      })
    }
    if (projectedIds.size + referencedIds.length > MAX_CHAT_PENDING_DECISION_REFERENCES) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['pendingDecisionIds'],
        message: `a chat message may reference at most ${MAX_CHAT_PENDING_DECISION_REFERENCES} Pending decisions`,
      })
    }
    if (referencedIds.length > 0) {
      if (message.role !== 'assistant') {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['pendingDecisionIds'],
          message: 'Pending decision references require daemon-authored assistant text',
        })
      }
      const canFormat = !decisions.some(
        (decision) => decision.state === 'terminal' && decision.outcome === undefined,
      )
      const expected = canFormat ? pendingDecisionChatFeedback(decisions, true) : undefined
      if (expected !== undefined && message.text !== expected) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['text'],
          message: 'unprojected Pending decision text must be daemon-derived',
        })
      }
    }
    if (message.decisionFeedbackId === undefined) return
    const decision = message.pendingDecisions?.[0]
    if (message.role !== 'assistant') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['decisionFeedbackId'],
        message: 'Pending-decision feedback must be daemon-authored assistant text',
      })
    }
    if (
      message.pendingDecisions?.length !== 1 ||
      referencedIds.length > 0 ||
      decision?.id !== message.decisionFeedbackId ||
      decision.state === 'pending'
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['decisionFeedbackId'],
        message: 'feedback must carry the exact resolving or terminal Pending decision',
      })
      return
    }
    if (
      decision !== undefined &&
      (decision.state === 'resolving' || decision.outcome !== undefined) &&
      message.text !== pendingDecisionChatFeedback([decision], false)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['text'],
        message: 'feedback text must be derived from the Pending decision state',
      })
    }
  })

export type ChatMessage = z.infer<typeof ChatMessageSchema>

/** What a client sends over the chat WebSocket. */
export const ChatClientMessageSchema = z.object({
  text: z.string().min(1),
  spaceId: z.string().min(1).optional(),
})

export type ChatClientMessage = z.infer<typeof ChatClientMessageSchema>
