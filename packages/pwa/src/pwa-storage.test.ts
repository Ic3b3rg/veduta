// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest'
import {
  CHAT_QUEUE_KEY,
  FAST_ACTION_QUEUE_KEY,
  persistQueuedFastActions,
  readQueuedChat,
  readQueuedFastActions,
} from './pwa-storage.ts'
import { PwaLiveStateRuntime } from './pwa-live-state-runtime.ts'

beforeEach(() => {
  localStorage.clear()
  history.replaceState(null, '', '/')
})

describe('persisted PWA state', () => {
  it('ignores old browser chat history without deleting it', () => {
    const legacy = '[{"role":"user","text":"old local entry"}]'
    localStorage.setItem('veduta.chatHistory', legacy)
    const runtime = new PwaLiveStateRuntime({ storage: localStorage })
    expect(runtime.getSnapshot().chatEntries).toEqual([])
    expect(localStorage.getItem('veduta.chatHistory')).toBe(legacy)
  })

  it('drops malformed queued records without discarding valid siblings', () => {
    localStorage.setItem(
      CHAT_QUEUE_KEY,
      JSON.stringify([
        { id: 'chat-1', text: 'hello', at: '2026-08-11T00:00:00.000Z' },
        { id: 'chat-2', at: '2026-08-11T00:00:00.000Z' },
      ]),
    )
    const invocation = {
      nodeId: 'node-1',
      name: 'toggle',
      actionRevision: 'acr-toggle',
      intentId: '00000000-0000-4000-8000-000000000001',
      inputs: { value: true },
    }
    const queued = {
      id: invocation.intentId,
      surfaceId: 'srf-1',
      invocation,
      at: '2026-08-11T00:00:00.000Z',
      status: 'queued' as const,
    }
    const recoveryPending = {
      ...queued,
      id: '00000000-0000-4000-8000-000000000002',
      invocation: { ...invocation, intentId: '00000000-0000-4000-8000-000000000002' },
      status: 'recovery_pending' as const,
    }
    localStorage.setItem(
      FAST_ACTION_QUEUE_KEY,
      JSON.stringify([
        queued,
        recoveryPending,
        { ...queued, invocation: { ...invocation, intentId: 'not-a-uuid' } },
        { ...queued, id: recoveryPending.id },
        { ...queued, status: 'committed' },
        { ...queued, invocation: { ...invocation, path: '/private-target' } },
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
    expect(readQueuedFastActions()).toEqual([queued, recoveryPending])

    persistQueuedFastActions([queued, recoveryPending])
    expect(readQueuedFastActions()).toEqual([queued, recoveryPending])
  })

  it('fails closed on corrupt JSON', () => {
    localStorage.setItem(CHAT_QUEUE_KEY, '{')
    localStorage.setItem(FAST_ACTION_QUEUE_KEY, '{')
    expect(readQueuedChat()).toEqual([])
    expect(readQueuedFastActions()).toEqual([])
  })
})
