import { fromPartial } from '@total-typescript/shoehorn'
import { SurfaceSchema, type AgentActionTurn, type SurfaceSnapshot } from '@veduta/protocol'
import { describe, expect, it, vi } from 'vitest'
import * as api from './api.ts'
import type { GatewayHandlers } from './gateway-client.ts'
import { createPwaLiveStateRuntime } from './pwa-live-state-runtime.ts'

const surface = SurfaceSchema.parse({
  id: 'srf-agent',
  spaceId: 'spc-agent',
  title: 'Agent action',
  tree: {
    id: 'run',
    type: 'Button',
    props: { label: 'Run' },
    actions: [{ name: 'run', path: 'agent', payload: { request: 'Explain this Surface' } }],
  },
  state: {},
  pinned: false,
  pinnable: true,
  presentation: 'standard',
  freshness: { updatedAt: '2026-10-01T08:00:00Z', updatedBy: 'agent' },
})

function harness(values = new Map<string, string>()) {
  const storage = fromPartial<Storage>({
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  })
  const snapshot = fromPartial<SurfaceSnapshot>({
    surfaceCursor: 0,
    spaces: [{ id: surface.spaceId, slug: 'agent', name: 'Agent', surfaces: [surface] }],
  })
  let connection!: GatewayHandlers
  const invoke = vi.fn<typeof api.invokeSurfaceAction>()
  const runtime = createPwaLiveStateRuntime({
    storage,
    api: {
      ...api,
      invokeSurfaceAction: invoke,
      fetchSpaces: vi.fn(async () => snapshot),
      fetchAuthStatus: vi.fn(async () => ({
        mode: 'dev' as const,
        bootstrapRequired: false,
        passkeyRegistered: false,
      })),
      fetchPendingDecisions: vi.fn(async () => ({ revision: 0, decisions: [] })),
      fetchAutomationOutcomeNotifications: vi.fn(async () => ({ revision: 0, notifications: [] })),
      connectGateway: (handlers) => {
        connection = handlers
        return { sendChat: () => true, close: () => {} }
      },
    },
  })
  return {
    runtime,
    invoke,
    values,
    connection: () => connection,
    async start() {
      await runtime.start()
      connection.onHello(0, 'agent-client')
      await Promise.resolve()
    },
  }
}

function completed(idempotencyKey: string): Extract<AgentActionTurn, { status: 'completed' }> {
  return {
    id: 'agent-turn-1',
    spaceId: surface.spaceId,
    surfaceId: surface.id,
    atomId: 'run',
    actionName: 'run',
    idempotencyKey,
    status: 'completed',
    surfaceCursor: 0,
    message: { role: 'assistant', text: 'The declared action completed.' },
  }
}

describe('PWA Agent action lifecycle', () => {
  it('keeps a queue acknowledgment pending until a matching terminal receipt arrives', async () => {
    const h = harness()
    await h.start()
    h.invoke.mockImplementation(async (_id, invocation) => {
      if ('intentId' in invocation || !invocation.idempotencyKey)
        throw new Error('Agent UUID required')
      const { message: _, surfaceCursor: __, ...turn } = completed(invocation.idempotencyKey)
      return { turn: { ...turn, status: 'running' } }
    })
    let settled = false
    const dispatch = h.runtime.dispatchSurfaceAction(surface.id, 'run', 'run').then(() => {
      settled = true
    })
    await vi.waitFor(() => expect(h.invoke).toHaveBeenCalledTimes(1))
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(h.runtime.getSnapshot().actionStatuses[surface.id]?.['run']?.['run']).toEqual({
      status: 'pending',
    })
    const invocation = h.invoke.mock.calls[0]![1]
    if ('intentId' in invocation || !invocation.idempotencyKey)
      throw new Error('Agent UUID required')
    h.connection().onSurfaceActionTurn?.({
      type: 'surface.action-turn',
      turn: completed(invocation.idempotencyKey),
    })
    await dispatch
    expect(h.runtime.getSnapshot().actionStatuses[surface.id]).toBeUndefined()
    expect(h.runtime.getSnapshot().chatEntries.at(-1)?.text).toBe('The declared action completed.')
    h.runtime.stop()
  })

  it('replays the same durable identity after lost HTTP and reload, then gives a fresh gesture a fresh identity', async () => {
    const h = harness()
    await h.start()
    h.invoke.mockRejectedValueOnce(new api.ApiResponseError('Response lost', 503))
    await expect(h.runtime.dispatchSurfaceAction(surface.id, 'run', 'run')).rejects.toThrow(
      'Response lost',
    )
    expect(h.runtime.getSnapshot().actionStatuses[surface.id]?.['run']?.['run']).toEqual({
      status: 'failed',
      message: 'Response lost',
    })
    const original = h.invoke.mock.calls[0]![1]
    expect(original).toHaveProperty('idempotencyKey', expect.any(String))
    h.runtime.stop()
    const next = harness(h.values)
    expect(next.runtime.getSnapshot().actionStatuses[surface.id]?.['run']?.['run']).toEqual({
      status: 'queued',
      message: 'The Agent action is queued and awaits confirmation.',
    })
    next.invoke.mockImplementation(async (_id, invocation) => {
      if ('intentId' in invocation || !invocation.idempotencyKey)
        throw new Error('Agent UUID required')
      return { turn: completed(invocation.idempotencyKey) }
    })
    await next.start()
    await vi.waitFor(() => expect(next.invoke).toHaveBeenCalledTimes(1))
    expect(next.invoke.mock.calls[0]![1]).toEqual(original)
    await vi.waitFor(() => expect(next.runtime.getSnapshot().chatEntries).toHaveLength(1))
    await next.runtime.dispatchSurfaceAction(surface.id, 'run', 'run')
    expect(next.invoke.mock.calls[1]![1]).not.toEqual(original)
    next.runtime.stop()
  })

  it('retains the original identity when completion arrives before its canonical Surface cursor', async () => {
    const h = harness()
    await h.start()
    h.invoke.mockImplementation(async (_id, invocation) => {
      if ('intentId' in invocation || !invocation.idempotencyKey)
        throw new Error('Agent UUID required')
      return { turn: { ...completed(invocation.idempotencyKey), surfaceCursor: 7 } }
    })
    await expect(h.runtime.dispatchSurfaceAction(surface.id, 'run', 'run')).rejects.toThrow(
      'canonical Surface updates are not yet available',
    )
    expect(h.runtime.getSnapshot().chatEntries).toHaveLength(0)
    const original = h.invoke.mock.calls[0]![1]
    h.invoke.mockImplementation(async (_id, invocation) => {
      if ('intentId' in invocation || !invocation.idempotencyKey)
        throw new Error('Agent UUID required')
      return { turn: completed(invocation.idempotencyKey) }
    })
    await h.runtime.dispatchSurfaceAction(surface.id, 'run', 'run')
    expect(h.invoke.mock.calls[1]![1]).toEqual(original)
    expect(h.runtime.getSnapshot().chatEntries).toHaveLength(1)
    h.runtime.stop()
  })

  it('exposes a failed Agent outcome as a recoverable failure and never publishes its model success', async () => {
    const h = harness()
    await h.start()
    h.invoke.mockImplementation(async (_id, invocation) => {
      if ('intentId' in invocation || !invocation.idempotencyKey)
        throw new Error('Agent UUID required')
      const { message: _, surfaceCursor: __, ...turn } = completed(invocation.idempotencyKey)
      return {
        turn: { ...turn, status: 'failed', error: 'The proposed Surface update was rejected.' },
      }
    })
    await expect(h.runtime.dispatchSurfaceAction(surface.id, 'run', 'run')).rejects.toThrow(
      'Surface update was rejected',
    )
    expect(h.runtime.getSnapshot().chatEntries).toHaveLength(0)
    expect(h.runtime.getSnapshot().actionStatuses[surface.id]?.['run']?.['run']).toEqual({
      status: 'failed',
      message: 'The proposed Surface update was rejected.',
    })
    const previous = h.invoke.mock.calls[0]![1]
    h.invoke.mockImplementation(async (_id, invocation) => {
      if ('intentId' in invocation || !invocation.idempotencyKey)
        throw new Error('Agent UUID required')
      return { turn: completed(invocation.idempotencyKey) }
    })
    await h.runtime.dispatchSurfaceAction(surface.id, 'run', 'run')
    expect(h.invoke.mock.calls[1]![1]).not.toEqual(previous)
    expect(h.runtime.getSnapshot().actionStatuses[surface.id]).toBeUndefined()
    h.runtime.stop()
  })
})
