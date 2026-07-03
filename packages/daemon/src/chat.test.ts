import type { ChatMessage } from '@veduta/protocol'
import { describe, expect, it } from 'vitest'
import { handleChatFrame } from './chat.ts'
import { mockReply } from './mock-provider.ts'

describe('handleChatFrame', () => {
  it('answers a valid frame and appends both turns to history', () => {
    const history: ChatMessage[] = []
    const reply = handleChatFrame(JSON.stringify({ text: 'I ate a pizza' }), history)
    expect(reply?.role).toBe('assistant')
    expect(reply?.text).toContain('pizza')
    expect(history).toHaveLength(2)
  })

  it('returns null on malformed JSON instead of throwing', () => {
    const history: ChatMessage[] = []
    expect(handleChatFrame('{not json', history)).toBeNull()
    expect(history).toHaveLength(0)
  })

  it('returns null on schema violations (missing or empty text)', () => {
    const history: ChatMessage[] = []
    expect(handleChatFrame(JSON.stringify({ nope: 1 }), history)).toBeNull()
    expect(handleChatFrame(JSON.stringify({ text: '' }), history)).toBeNull()
  })
})

describe('mock provider', () => {
  it('is deterministic for the same input', () => {
    const history: ChatMessage[] = [{ role: 'user', text: 'I ate a pizza' }]
    expect(mockReply(history)).toBe(mockReply(history))
    expect(mockReply(history)).toContain('pizza')
  })
})
