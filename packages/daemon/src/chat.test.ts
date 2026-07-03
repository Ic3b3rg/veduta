import type { ChatMessage } from '@veduta/protocol'
import { describe, expect, it } from 'vitest'
import { mealPatchFromChat, handleChatText } from './chat.ts'
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

describe('mealPatchFromChat', () => {
  it('builds a protocol state patch for a meal logged in chat', () => {
    const at = new Date('2026-07-03T12:15:00.000Z')
    // The Surface shows daemon-local wall-clock time, so the expected label
    // depends on the timezone this test runs in.
    const localTime = at.toTimeString().slice(0, 5)
    const operations = mealPatchFromChat(
      'I ate a pizza',
      {
        meals: [{ time: '11:30', meal: 'oatmeal' }],
        lastMeal: 'oatmeal',
        mealCount: 1,
      },
      at,
    )

    expect(operations).toEqual([
      {
        target: 'state',
        op: 'replace',
        path: '/meals',
        value: [
          { time: localTime, meal: 'a pizza' },
          { time: '11:30', meal: 'oatmeal' },
        ],
      },
      { target: 'state', op: 'replace', path: '/lastMeal', value: 'a pizza' },
      { target: 'state', op: 'replace', path: '/mealCount', value: 2 },
    ])
  })

  it('ignores chat turns that are not meal logs', () => {
    expect(mealPatchFromChat('what is next?', {}, new Date())).toBeUndefined()
  })
})
