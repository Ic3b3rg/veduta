import { z } from 'zod'
import { ChatMessageSchema } from './chat.ts'

export const ChatScopeSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('global') }),
  z.object({ type: z.literal('space'), spaceId: z.string().min(1) }),
])

export const ChatTurnStateSchema = z.enum([
  'accepted',
  'running',
  'waiting_connection',
  'completed',
  'failed',
  'interrupted',
])

export const ChatTimelineEntrySchema = z.object({
  id: z.string().min(1),
  turnId: z.string().min(1),
  scope: ChatScopeSchema,
  cursor: z.string().min(1),
  position: z.number().int().positive(),
  revision: z.number().int().positive(),
  kind: z.enum(['user', 'assistant', 'error', 'decision', 'connection']),
  message: ChatMessageSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  turnState: ChatTurnStateSchema.optional(),
  retryOf: z.string().min(1).optional(),
  connectionAttemptId: z.string().uuid().optional(),
})

export const ChatTimelinePageSchema = z.object({
  entries: z.array(ChatTimelineEntrySchema),
  nextBefore: z.string().min(1).optional(),
})

export const ChatAcceptanceSchema = z.object({
  submissionId: z.string().min(1),
  turnId: z.string().min(1),
  entryId: z.string().min(1),
  scope: ChatScopeSchema,
  state: ChatTurnStateSchema,
  retryOf: z.string().min(1).optional(),
})

export type ChatScope = z.infer<typeof ChatScopeSchema>
export type ChatTurnState = z.infer<typeof ChatTurnStateSchema>
export type ChatTimelineEntry = z.infer<typeof ChatTimelineEntrySchema>
export type ChatTimelinePage = z.infer<typeof ChatTimelinePageSchema>
export type ChatAcceptance = z.infer<typeof ChatAcceptanceSchema>
