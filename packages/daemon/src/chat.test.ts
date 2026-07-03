import type { ChatMessage } from '@veduta/protocol'
import { describe, expect, it } from 'vitest'
import { handleChatText } from './chat.ts'
import { mockReply } from './mock-provider.ts'

describe('handleChatText', () => {
  it('answers text and appends both turns to history', () => {
    const history: ChatMessage[] = []
    const reply = handleChatText('I ate a pizza', history)
    expect(reply.role).toBe('assistant')
    expect(reply.text).toContain('pizza')
    expect(history).toHaveLength(2)
  })
})

describe('mock provider', () => {
  it('is deterministic for the same input', () => {
    const history: ChatMessage[] = [{ role: 'user', text: 'I ate a pizza' }]
    expect(mockReply(history)).toBe(mockReply(history))
    expect(mockReply(history)).toContain('pizza')
  })
})
