import type { ChatMessage } from '@veduta/protocol'
import { mockReply } from './mock-provider.ts'

export function handleChatText(text: string, history: ChatMessage[]): ChatMessage {
  history.push({ role: 'user', text })
  const reply: ChatMessage = { role: 'assistant', text: mockReply(history) }
  history.push(reply)
  return reply
}
