import { fromPartial } from '@total-typescript/shoehorn'
import {
  GatewayClientMessageSchema,
  FastActionInvocationSchema,
  SurfaceSchema,
  inputSetPlan,
  literalSetPlan,
  type Surface,
  type SurfacePatchEvent,
  type SurfaceSnapshot,
  type ChatTimelinePage,
} from '@veduta/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as api from './api.ts'
import type { GatewayHandlers } from './gateway-client.ts'
import { createPwaLiveStateRuntime } from './pwa-live-state-runtime.ts'
import { committedActionOutcome } from './action-test-support.ts'
import { LiveSurfaceProjection } from './live-surface-projection.ts'

function surface(value = 0): Surface {
  return SurfaceSchema.parse({
    id: 'srf-test',
    spaceId: 'spc-test',
    title: 'Test',
    tree: {
      id: 'root',
      type: 'Box',
      children: [
        { id: 'value', type: 'Stat', props: { label: 'Value' }, binding: 'value' },
        {
          id: 'set-one',
          type: 'Button',
          props: { label: 'Set one' },
          actions: [
            {
              name: 'set',
              path: 'fast',
              revision: 'acr-set-one',
              plan: literalSetPlan('value', 1),
            },
          ],
        },
        {
          id: 'set-two',
          type: 'Button',
          props: { label: 'Set two' },
          actions: [
            {
              name: 'set',
              path: 'fast',
              revision: 'acr-set-two',
              plan: literalSetPlan('value', 2),
            },
          ],
        },
      ],
    },
    state: { value },
    pinned: false,
    pinnable: true,
    presentation: 'standard',
    freshness: { updatedAt: '2026-10-01T08:00:00Z', updatedBy: 'user' },
  })
}

function snapshot(value = 0, cursor = 0): SurfaceSnapshot {
  return fromPartial<SurfaceSnapshot>({
    surfaceCursor: cursor,
    spaces: [
      {
        id: 'spc-test',
        slug: 'test',
        name: 'Test',
        archived: false,
        attention: 0,
        attentionRevision: 0,
        surfaces: [surface(value)],
      },
    ],
  })
}

function patch(value: number, cursor: number): SurfacePatchEvent {
  return {
    cursor,
    at: '2026-10-01T08:00:01Z',
    spaceId: 'spc-test',
    patch: {
      surfaceId: 'srf-test',
      operations: [{ target: 'state', op: 'replace', path: '/value', value }],
    },
    freshness: { updatedAt: '2026-10-01T08:00:01Z', updatedBy: 'user' },
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((done, failed) => {
    resolve = done
    reject = failed
  })
  return { promise, resolve, reject }
}

function setup(initialStorage: Record<string, string> = {}) {
  const values = new Map<string, string>(Object.entries(initialStorage))
  const storage = fromPartial<Storage>({
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value)
    },
    removeItem: (key: string) => {
      values.delete(key)
    },
  })
  const connections: GatewayHandlers[] = []
  const sendChat = vi.fn<api.GatewayConnection['sendChat']>(() => true)
  const subscribeChat = vi.fn(() => true)
  const close = vi.fn()
  const fetchSpaces = vi.fn(async () => snapshot())
  const fetchChatTimeline = vi.fn(async (): Promise<ChatTimelinePage> => ({ entries: [] }))
  const invokeSurfaceAction = vi.fn(api.invokeSurfaceAction)
  const pinSurface = vi.fn(api.pinSurface)
  const fetchAuthStatus = vi
    .fn(api.fetchAuthStatus)
    .mockResolvedValue({ mode: 'dev', bootstrapRequired: false, passkeyRegistered: false })
  const runtime = createPwaLiveStateRuntime({
    storage,
    api: {
      ...api,
      fetchAuthStatus,
      fetchSpaces,
      fetchChatTimeline,
      invokeSurfaceAction,
      pinSurface,
      fetchPendingDecisions: vi.fn(async () => ({ revision: 0, decisions: [] })),
      connectGateway: vi.fn((handlers) => {
        connections.push(handlers)
        return { sendChat, subscribeChat, close }
      }),
    },
  })
  return {
    runtime,
    connections,
    fetchSpaces,
    fetchAuthStatus,
    invokeSurfaceAction,
    pinSurface,
    sendChat,
    subscribeChat,
    fetchChatTimeline,
    close,
    values,
  }
}

afterEach(() => vi.useRealTimers())

describe('PWA live-state runtime', () => {
  it('owns one lifecycle and publishes immutable snapshots without React', async () => {
    const { runtime, connections, close } = setup()
    const listener = vi.fn()
    runtime.subscribe(listener)
    await runtime.start()
    await runtime.start()
    expect(connections).toHaveLength(1)
    connections[0]!.onHello(0, 'client-test')
    await vi.waitFor(() => expect(runtime.getSnapshot().gatewayOnline).toBe(true))
    expect(Object.isFrozen(runtime.getSnapshot().spaces[0]?.surfaces[0]?.state)).toBe(true)
    expect(listener).toHaveBeenCalled()
    runtime.stop()
    runtime.stop()
    expect(close).toHaveBeenCalledTimes(1)
    expect(runtime.getSnapshot().gatewayOnline).toBe(false)
  })

  it('keeps a pending control unchanged until its canonical outcome commits', async () => {
    const { runtime, connections, fetchSpaces, invokeSurfaceAction, values } = setup()
    const initial = surface()
    initial.tree = {
      id: 'root',
      type: 'Checkbox',
      binding: 'done',
      props: { label: 'Done' },
      actions: [
        {
          name: 'toggle',
          path: 'fast',
          revision: 'acr-done',
          plan: inputSetPlan('done', { type: 'boolean' }),
        },
      ],
    }
    initial.state = { done: false }
    const initialSnapshot = snapshot()
    initialSnapshot.spaces[0]!.surfaces = [initial]
    fetchSpaces.mockResolvedValue(initialSnapshot)
    const response = deferred<Awaited<ReturnType<typeof api.invokeSurfaceAction>>>()
    invokeSurfaceAction.mockReturnValue(response.promise)
    await runtime.start()
    connections[0]!.onHello(0, 'client-test')
    await Promise.resolve()
    const submitting = runtime.dispatchSurfaceAction(initial.id, 'root', 'toggle', true)
    expect(runtime.getSnapshot().spaces[0]?.surfaces[0]?.state['done']).toBe(false)
    expect(JSON.parse(values.get('veduta.homeSnapshot')!).spaces[0].surfaces[0].state.done).toBe(
      false,
    )
    const invocation = invokeSurfaceAction.mock.calls[0]?.[1]
    if (!invocation) throw new Error('Expected the typed toggle invocation')
    response.resolve(
      committedActionOutcome(
        invocation,
        { ...initial, state: { done: true } },
        {
          surfaceId: initial.id,
          operations: [{ target: 'state', op: 'replace', path: '/done', value: true }],
        },
        1,
      ),
    )
    await submitting
    expect(runtime.getSnapshot().spaces[0]?.surfaces[0]?.state['done']).toBe(true)
    expect(JSON.parse(values.get('veduta.homeSnapshot')!).spaces[0].surfaces[0].state.done).toBe(
      true,
    )
    runtime.stop()
  })

  it('replays buffered frames after a stale HTTP snapshot', async () => {
    const { runtime, connections, fetchSpaces } = setup()
    await runtime.start()
    const fetching = deferred<SurfaceSnapshot>()
    fetchSpaces.mockReturnValueOnce(fetching.promise)
    connections[0]!.onHello(0, 'client-test')
    connections[0]!.onSurfacePatch(patch(2, 2))
    fetching.resolve(snapshot(1, 1))
    await vi.waitFor(() => expect(runtime.getSnapshot().surfaceCursor).toBe(2))
    expect(runtime.getSnapshot().spaces[0]?.surfaces[0]?.state['value']).toBe(2)
    connections[0]!.onSurfacePatch(patch(1, 1))
    expect(runtime.getSnapshot().spaces[0]?.surfaces[0]?.state['value']).toBe(2)
    expect(runtime.getSnapshot().surfaceCursor).toBe(2)
    runtime.stop()
  })

  it('reconciles presentation and content independently when their frames arrive out of order', async () => {
    const { runtime, connections, fetchSpaces } = setup()
    await runtime.start()
    connections[0]!.onSurfacePresentation({
      cursor: 2,
      at: '2026-10-01T08:00:02Z',
      spaceId: 'spc-test',
      surfaceId: 'srf-test',
      presentation: 'full',
      freshness: { updatedAt: '2026-10-01T08:00:02Z', updatedBy: 'user' },
    })
    connections[0]!.onSurfacePatch(patch(1, 1))
    expect(runtime.getSnapshot().spaces[0]?.surfaces[0]).toMatchObject({
      presentation: 'full',
      state: { value: 1 },
      freshness: { updatedAt: '2026-10-01T08:00:02Z' },
    })
    fetchSpaces.mockResolvedValueOnce(snapshot(1, 1))
    connections[0]!.onHello(2, 'client-test')
    await vi.waitFor(() => expect(fetchSpaces).toHaveBeenCalledTimes(2))
    expect(runtime.getSnapshot().spaces[0]?.surfaces[0]?.presentation).toBe('full')
    runtime.stop()
  })

  it('keeps queued Chat identity stable and flushes once after reconnect', async () => {
    vi.useFakeTimers()
    const { runtime, connections, sendChat, values } = setup()
    await runtime.start()
    runtime.sendChat('queued message', 'spc-test')
    const identity = runtime.getSnapshot().queuedChat[0]?.id
    expect(identity).toBeTruthy()
    expect(values.get('veduta.chatQueue')).toContain(identity)
    connections[0]!.onHello(0, 'client-test')
    await Promise.resolve()
    expect(sendChat).toHaveBeenCalledExactlyOnceWith(
      'queued message',
      'spc-test',
      identity,
      undefined,
    )
    expect(runtime.getSnapshot().queuedChat).toHaveLength(1)
    connections[0]!.onChatAccepted?.({
      type: 'chat.accepted',
      acceptance: {
        submissionId: identity!,
        turnId: 'cht-queued',
        entryId: 'cte-queued',
        scope: { type: 'space', spaceId: 'spc-test' },
        state: 'accepted',
      },
    })
    expect(runtime.getSnapshot().queuedChat).toHaveLength(0)
    connections[0]!.onClose()
    await vi.advanceTimersByTimeAsync(1000)
    expect(connections[1]?.clientId).toBe('client-test')
    connections[1]!.onHello(0, 'client-test')
    expect(sendChat).toHaveBeenCalledTimes(1)
    runtime.stop()
  })

  it('reattaches to a Gateway-owned running turn after reload without resubmitting', async () => {
    const { runtime, connections, fetchChatTimeline, subscribeChat, sendChat } = setup()
    fetchChatTimeline.mockResolvedValue({
      entries: [
        {
          id: 'cte-running',
          turnId: 'cht-running',
          scope: { type: 'global' },
          cursor: 'cursor-running',
          position: 1,
          revision: 2,
          kind: 'user',
          message: { role: 'user', text: 'Long request' },
          createdAt: '2026-10-01T08:00:00.000Z',
          updatedAt: '2026-10-01T08:00:01.000Z',
          turnState: 'running',
        },
      ],
    })
    await runtime.start()
    connections[0]!.onHello(0, 'new-device')
    await vi.waitFor(() => expect(subscribeChat).toHaveBeenCalledWith('cht-running'))
    expect(runtime.getSnapshot().chatEntries).toEqual([{ role: 'user', text: 'Long request' }])
    expect(sendChat).not.toHaveBeenCalled()
    runtime.stop()
  })

  it('rebases cached freshness after reconnecting to a restored Gateway', async () => {
    vi.useFakeTimers()
    const { runtime, connections, fetchSpaces } = setup()
    fetchSpaces.mockResolvedValue(snapshot(10, 10))
    await runtime.start()
    connections[0]!.onHello(10, 'client-test')
    await Promise.resolve()
    connections[0]!.onClose()
    fetchSpaces.mockResolvedValue(snapshot(2, 2))
    await vi.advanceTimersByTimeAsync(1000)
    connections[1]!.onHello(2, 'client-test')
    await Promise.resolve()
    expect(runtime.getSnapshot().surfaceCursor).toBe(2)
    expect(runtime.getSnapshot().spaces[0]?.surfaces[0]?.state['value']).toBe(2)
    connections[1]!.onSurfacePatch(patch(3, 3))
    expect(runtime.getSnapshot().spaces[0]?.surfaces[0]?.state['value']).toBe(3)
    runtime.stop()
  })

  it('resumes an unsettled intent after remount without applying a stopped HTTP result', async () => {
    const { runtime, connections, invokeSurfaceAction } = setup()
    const oldResult = deferred<Awaited<ReturnType<typeof api.invokeSurfaceAction>>>()
    invokeSurfaceAction.mockReturnValueOnce(oldResult.promise)
    invokeSurfaceAction.mockImplementation(async (_surfaceId, invocation) =>
      committedActionOutcome(invocation, surface(2), patch(2, 2).patch, 2),
    )
    await runtime.start()
    connections[0]!.onHello(0, 'client-test')
    const submitting = runtime
      .dispatchSurfaceAction('srf-test', 'set-two', 'set')
      .catch(() => undefined)
    await vi.waitFor(() => expect(invokeSurfaceAction).toHaveBeenCalledTimes(1))
    const invocation = invokeSurfaceAction.mock.calls[0]?.[1]
    if (!invocation) throw new Error('Expected the typed set invocation')
    runtime.stop()
    await runtime.start()
    connections[1]!.onHello(0, 'client-test')
    oldResult.resolve(committedActionOutcome(invocation, surface(99), patch(99, 99).patch, 99))
    await submitting
    await vi.waitFor(() => expect(invokeSurfaceAction).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(runtime.getSnapshot().queuedFastActions).toHaveLength(0))
    const invocations = invokeSurfaceAction.mock.calls.map((call) =>
      FastActionInvocationSchema.parse(call[1]),
    )
    expect(invocations[0]?.intentId).toBe(invocations[1]?.intentId)
    expect(invocations[1]).toEqual(invocations[0])
    expect(runtime.getSnapshot().spaces[0]?.surfaces[0]?.state['value']).toBe(2)
    runtime.stop()
  })

  it('ignores snapshots and handlers from a stopped generation', async () => {
    const { runtime, connections, fetchSpaces } = setup()
    await runtime.start()
    const stale = deferred<SurfaceSnapshot>()
    fetchSpaces.mockReturnValueOnce(stale.promise)
    connections[0]!.onHello(0, 'client-test')
    runtime.stop()
    await runtime.start()
    stale.resolve(snapshot(99, 99))
    connections[0]!.onSurfacePatch(patch(88, 88))
    await Promise.resolve()
    expect(runtime.getSnapshot().spaces[0]?.surfaces[0]?.state['value']).toBe(0)
    runtime.stop()
  })

  it('does not invent an interruption when a Chat stream disconnects', async () => {
    const { runtime, connections } = setup()
    await runtime.start()
    connections[0]!.onChatTurnStart({ type: 'chat.turn-start', turnId: 'old-turn' })
    connections[0]!.onChatTurnDelta({
      type: 'chat.turn-delta',
      turnId: 'old-turn',
      text: 'Partial reply',
    })
    runtime.stop()
    runtime.stop()
    await runtime.start()
    expect(runtime.getSnapshot().streamingTurns).toHaveLength(0)
    expect(runtime.getSnapshot().chatEntries).toHaveLength(0)
    runtime.stop()
  })

  it('keeps a known production session signed out while revocation status recovery is unavailable', async () => {
    const { runtime, connections, fetchAuthStatus } = setup({
      'veduta.authToken': 'vdt_device_session',
    })
    fetchAuthStatus.mockResolvedValueOnce({
      mode: 'production',
      bootstrapRequired: false,
      passkeyRegistered: true,
    })
    await runtime.start()
    const status = deferred<Awaited<ReturnType<typeof api.fetchAuthStatus>>>()
    fetchAuthStatus.mockReturnValueOnce(status.promise)
    connections[0]!.onError('Gateway session revoked')
    expect(runtime.getSnapshot().authToken).toBeUndefined()
    expect(runtime.getSnapshot().authStatus?.mode).toBe('production')
    status.reject(new Error('Auth status unavailable'))
    await vi.waitFor(() => expect(runtime.getSnapshot().error).toContain('Auth status unavailable'))
    expect(runtime.getSnapshot().authStatus?.mode).toBe('production')
    expect(connections).toHaveLength(1)
    runtime.stop()
  })

  it('reports an invalid persisted Chat entry and still sends valid queued work', async () => {
    const { runtime, connections, sendChat } = setup({
      'veduta.chatQueue': JSON.stringify([
        { id: 'invalid', text: '', at: '2026-10-01T08:00:00Z' },
        {
          id: '00000000-0000-4000-8000-000000000001',
          text: 'Valid queued Chat',
          at: '2026-10-01T08:00:00Z',
        },
      ]),
    })
    sendChat.mockImplementation((text) => {
      GatewayClientMessageSchema.parse({ type: 'chat.send', text })
      return true
    })
    await runtime.start()
    expect(() => connections[0]!.onHello(0, 'client-test')).not.toThrow()
    expect(sendChat).toHaveBeenCalledExactlyOnceWith(
      'Valid queued Chat',
      undefined,
      '00000000-0000-4000-8000-000000000001',
      undefined,
    )
    expect(runtime.getSnapshot().error).toContain('Queued Chat')
    expect(runtime.getSnapshot().queuedChat).toHaveLength(2)
    runtime.stop()
  })

  it('preserves a confirmed Pin through an older in-flight snapshot and duplicate frame', async () => {
    const { runtime, connections, fetchSpaces, pinSurface } = setup()
    await runtime.start()
    const fetching = deferred<SurfaceSnapshot>()
    fetchSpaces.mockReturnValueOnce(fetching.promise)
    connections[0]!.onHello(0, 'client-test')
    pinSurface.mockResolvedValue(
      fromPartial({
        surface: { ...surface(), pinned: true },
        order: {
          spaceId: 'spc-test',
          cursor: 2,
          pinnedSurfaceIds: ['srf-test'],
          regularSurfaceIds: [],
        },
      }),
    )
    await runtime.togglePin(surface())
    connections[0]!.onSurfacePinned({
      cursor: 2,
      at: '2026-10-01T08:00:02Z',
      spaceId: 'spc-test',
      surfaceId: 'srf-test',
      pinned: true,
      freshness: { updatedAt: '2026-10-01T08:00:02Z', updatedBy: 'user' },
      order: {
        spaceId: 'spc-test',
        cursor: 2,
        pinnedSurfaceIds: ['srf-test'],
        regularSurfaceIds: [],
      },
    })
    fetching.resolve(snapshot(0, 0))
    await vi.waitFor(() => expect(runtime.getSnapshot().surfaceCursor).toBe(2))
    expect(runtime.getSnapshot().spaces[0]?.surfaces[0]?.pinned).toBe(true)
    runtime.stop()
  })

  it('continues recovery through a corrupt buffered patch to a later valid frame', async () => {
    const { runtime, connections, fetchSpaces } = setup()
    await runtime.start()
    const fetching = deferred<SurfaceSnapshot>()
    fetchSpaces.mockReturnValueOnce(fetching.promise)
    connections[0]!.onHello(0, 'client-test')
    connections[0]!.onSurfacePatch({
      ...patch(1, 1),
      patch: {
        surfaceId: 'srf-test',
        operations: [{ target: 'state', op: 'replace', path: '/missing', value: 1 }],
      },
    })
    connections[0]!.onSurfacePatch(patch(2, 2))
    fetching.resolve(snapshot())
    await vi.waitFor(() =>
      expect(runtime.getSnapshot().spaces[0]?.surfaces[0]?.state['value']).toBe(2),
    )
    expect(runtime.getSnapshot().error).toBeTruthy()
    runtime.stop()
  })

  it('flushes work added during an in-flight queue batch without requiring reconnect', async () => {
    const { runtime, connections, invokeSurfaceAction } = setup()
    const response = deferred<Awaited<ReturnType<typeof api.invokeSurfaceAction>>>()
    invokeSurfaceAction.mockReturnValueOnce(response.promise)
    invokeSurfaceAction.mockImplementation(async (_surfaceId, invocation) =>
      committedActionOutcome(invocation, surface(2), patch(2, 2).patch, 2),
    )
    await runtime.start()
    const firstSubmission = runtime
      .dispatchSurfaceAction('srf-test', 'set-one', 'set')
      .catch(() => undefined)
    connections[0]!.onHello(0, 'client-test')
    await vi.waitFor(() => expect(invokeSurfaceAction).toHaveBeenCalledTimes(1))
    const secondSubmission = runtime
      .dispatchSurfaceAction('srf-test', 'set-two', 'set')
      .catch(() => undefined)
    const invocation = invokeSurfaceAction.mock.calls[0]?.[1]
    if (!invocation) throw new Error('Expected the first typed set invocation')
    response.resolve(committedActionOutcome(invocation, surface(1), patch(1, 1).patch, 1))
    await Promise.all([firstSubmission, secondSubmission])
    await vi.waitFor(() => expect(invokeSurfaceAction).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(runtime.getSnapshot().queuedFastActions).toHaveLength(0))
    const invocations = invokeSurfaceAction.mock.calls.map((call) =>
      FastActionInvocationSchema.parse(call[1]),
    )
    expect(invocations.map((invocation) => invocation.nodeId)).toEqual(['set-one', 'set-two'])
    expect(invocations[0]?.intentId).not.toBe(invocations[1]?.intentId)
    expect(runtime.getSnapshot().spaces[0]?.surfaces[0]?.state['value']).toBe(2)
    runtime.stop()
  })

  it('shows an unresolvable update, recovers by snapshot, and preserves the confirmed cache', async () => {
    const { runtime, connections, fetchSpaces, values } = setup()
    await runtime.start()
    fetchSpaces.mockResolvedValueOnce(snapshot(5, 5))
    connections[0]!.onSurfacePatch({
      ...patch(4, 4),
      patch: { ...patch(4, 4).patch, surfaceId: 'unknown' },
    })
    await vi.waitFor(() => expect(runtime.getSnapshot().surfaceCursor).toBe(5))
    expect(values.get('veduta.homeSnapshot')).toContain('"value":5')
    connections[0]!.onError('Malformed Gateway frame')
    expect(runtime.getSnapshot().error).toContain('Malformed Gateway frame')
    runtime.stop()
  })
})

describe('Live Surface projection confirmation', () => {
  it('keeps a newer canonical HTTP confirmation without advancing the realtime cursor', () => {
    const projection = new LiveSurfaceProjection(snapshot())
    projection.apply({ type: 'surface.patch', event: patch(2, 2) })
    projection.confirmSurface(surface(3), 3)
    projection.confirmSurface(surface(1), 1)
    expect(projection.spaces[0]?.surfaces[0]?.state['value']).toBe(3)
    expect(projection.cursor).toBe(2)
    projection.apply({ type: 'surface.patch', event: patch(2, 2) })
    expect(projection.spaces[0]?.surfaces[0]?.state['value']).toBe(3)
  })
})
