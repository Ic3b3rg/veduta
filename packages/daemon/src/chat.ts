import { ChatClientMessageSchema, type ChatMessage } from '@veduta/protocol'
import { mockReply } from './mock-provider.ts'

/**
 * Handle one raw chat WebSocket frame. Malformed JSON or schema
 * violations return null — a bad frame must never throw out of the
 * socket handler.
 */
export function handleChatFrame(raw: string, history: ChatMessage[]): ChatMessage | null {
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    return null
  }
  const parsed = ChatClientMessageSchema.safeParse(json)
  if (!parsed.success) return null
  history.push({ role: 'user', text: parsed.data.text })
  const reply: ChatMessage = { role: 'assistant', text: mockReply(history) }
  history.push(reply)
  return reply
}
