// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest'
import {
  CHAT_HISTORY_KEY,
  CHAT_HISTORY_LIMIT,
  CHAT_QUEUE_KEY,
  FAST_ACTION_QUEUE_KEY,
  persistChatHistory,
  readChatHistory,
  readQueuedChat,
  readQueuedFastActions,
} from './pwa-storage.ts'

beforeEach(() => {
  localStorage.clear()
  history.replaceState(null, '', '/')
})

describe('persisted PWA state', () => {
  it('bounds and validates chat history', () => {
    const entries = Array.from({ length: CHAT_HISTORY_LIMIT + 2 }, (_, index) => ({
      role: 'user' as const,
      text: `message ${index}`,
    }))
    persistChatHistory(entries)
    expect(readChatHistory()).toEqual(entries.slice(-CHAT_HISTORY_LIMIT))

    localStorage.setItem(CHAT_HISTORY_KEY, '[{"role":"unknown"}]')
    expect(readChatHistory()).toEqual([])
  })

  it('drops malformed queued records without discarding valid siblings', () => {
    localStorage.setItem(
      CHAT_QUEUE_KEY,
      JSON.stringify([
        { id: 'chat-1', text: 'hello', at: '2026-08-11T00:00:00.000Z' },
        { id: 'chat-2', at: '2026-08-11T00:00:00.000Z' },
      ]),
    )
    localStorage.setItem(
      FAST_ACTION_QUEUE_KEY,
      JSON.stringify([
        {
          id: 'action-1',
          surfaceId: 'srf-1',
          nodeId: 'node-1',
          actionName: 'toggle',
          value: true,
          idempotencyKey: 'key-1',
          at: '2026-08-11T00:00:00.000Z',
        },
        { id: 'action-2' },
      ]),
    )

    expect(readQueuedChat()).toHaveLength(1)
    expect(readQueuedFastActions()).toHaveLength(1)
  })

  it('fails closed on corrupt JSON', () => {
    localStorage.setItem(CHAT_QUEUE_KEY, '{')
    localStorage.setItem(FAST_ACTION_QUEUE_KEY, '{')
    expect(readQueuedChat()).toEqual([])
    expect(readQueuedFastActions()).toEqual([])
  })
})
