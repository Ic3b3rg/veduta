import { z } from 'zod'

/**
 * The chat contract on the daemon↔client boundary. Every message
 * crossing the WebSocket is one of these — neither side defines its
 * own local chat shape.
 */
export const ChatMessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  text: z.string(),
})

export type ChatMessage = z.infer<typeof ChatMessageSchema>

/** What a client sends over the chat WebSocket. */
export const ChatClientMessageSchema = z.object({
  text: z.string().min(1),
})

export type ChatClientMessage = z.infer<typeof ChatClientMessageSchema>
