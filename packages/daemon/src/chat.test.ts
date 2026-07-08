import type { ChatMessage } from '@veduta/protocol'
import { describe, expect, it } from 'vitest'
import { mealPatchFromChat, handleChatText, reminderFromChat } from './chat.ts'
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

describe('reminderFromChat', () => {
  // The parser works on daemon-local wall-clock time, like the Meals labels.
  const localAt = (base: Date, hours: number, minutes = 0) => {
    const at = new Date(base.getTime())
    at.setHours(hours, minutes, 0, 0)
    return at
  }

  it('arms today when the deadline is still ahead', () => {
    const at = localAt(new Date('2026-07-08T12:00:00.000Z'), 13)
    const reminder = reminderFromChat('Remind me to log my weight by 9pm', at)
    expect(reminder).toMatchObject({ action: 'log my weight', conditionNeedle: 'weight' })
    expect(reminder?.fireAtIso).toBe(localAt(at, 21).toISOString())
  })

  it('rolls over to tomorrow when the time already passed, and parses minutes and am', () => {
    const at = localAt(new Date('2026-07-08T12:00:00.000Z'), 13)
    const reminder = reminderFromChat('remind me to take my pills by 8:30am!', at)
    const tomorrow = localAt(at, 8, 30)
    tomorrow.setDate(tomorrow.getDate() + 1)
    expect(reminder).toMatchObject({ action: 'take my pills', conditionNeedle: 'pills' })
    expect(reminder?.fireAtIso).toBe(tomorrow.toISOString())
  })

  it('ignores chat turns that are not reminders and out-of-range times', () => {
    expect(reminderFromChat('what is next?', new Date())).toBeUndefined()
    expect(reminderFromChat('remind me to stretch by 25', new Date())).toBeUndefined()
  })
})
