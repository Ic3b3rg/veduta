import { fromPartial } from '@total-typescript/shoehorn'
import type { Surface, SurfacePatchEvent, SurfaceSnapshot } from '@veduta/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as api from './api.ts'
import type { GatewayHandlers } from './gateway-client.ts'
import { createPwaLiveStateRuntime } from './pwa-live-state-runtime.ts'

function surface(value = 0): Surface {
  return {
    id: 'srf-test',
    spaceId: 'spc-test',
    title: 'Test',
    tree: { id: 'root', type: 'Stat', props: { label: 'Value' }, binding: 'value' },
    state: { value },
    pinned: false,
    pinnable: true,
    freshness: { updatedAt: '2026-10-01T08:00:00Z', updatedBy: 'user' },
  }
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
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function setup() {
  const values = new Map<string, string>()
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
  const sendChat = vi.fn(() => true)
  const close = vi.fn()
  const fetchSpaces = vi.fn(async () => snapshot())
  const invokeFastAction = vi.fn(api.invokeFastAction)
  const runtime = createPwaLiveStateRuntime({
    storage,
    api: {
      ...api,
      fetchAuthStatus: vi.fn(async () => ({
        mode: 'dev' as const,
        bootstrapRequired: false,
        passkeyRegistered: false,
      })),
      fetchSpaces,
      invokeFastAction,
      fetchPendingDecisions: vi.fn(async () => ({ revision: 0, decisions: [] })),
      connectGateway: vi.fn((handlers) => {
        connections.push(handlers)
        return { sendChat, close }
      }),
    },
  })
  return { runtime, connections, fetchSpaces, invokeFastAction, sendChat, close, values }
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

  it('keeps optimistic control feedback out of the confirmed cache', async () => {
    const { runtime, connections, fetchSpaces, invokeFastAction, values } = setup()
    const initial = surface()
    initial.tree = {
      id: 'root',
      type: 'Checkbox',
      binding: 'done',
      props: { label: 'Done' },
      actions: [{ name: 'toggle', path: 'fast', stateKey: 'done', payload: {} }],
    }
    initial.state = { done: false }
    const initialSnapshot = snapshot()
    initialSnapshot.spaces[0]!.surfaces = [initial]
    fetchSpaces.mockResolvedValue(initialSnapshot)
    const response = deferred<Awaited<ReturnType<typeof api.invokeFastAction>>>()
    invokeFastAction.mockReturnValue(response.promise)
    await runtime.start()
    connections[0]!.onHello(0, 'client-test')
    await Promise.resolve()
    const submitting = runtime.dispatchSurfaceAction(initial.id, 'root', 'toggle', true)
    expect(runtime.getSnapshot().spaces[0]?.surfaces[0]?.state['done']).toBe(true)
    expect(JSON.parse(values.get('veduta.homeSnapshot')!).spaces[0].surfaces[0].state.done).toBe(
      false,
    )
    response.resolve(
      fromPartial({ surface: { ...initial, state: { done: true } }, surfaceCursor: 1 }),
    )
    await submitting
    expect(JSON.parse(values.get('veduta.homeSnapshot')!).spaces[0].surfaces[0].state.done).toBe(
      true,
    )
    runtime.stop()
  })

  it('replays buffered frames and refuses stale HTTP results without moving the global cursor', async () => {
    const { runtime, connections, fetchSpaces } = setup()
    await runtime.start()
    const fetching = deferred<SurfaceSnapshot>()
    fetchSpaces.mockReturnValueOnce(fetching.promise)
    connections[0]!.onHello(0, 'client-test')
    connections[0]!.onSurfacePatch(patch(2, 2))
    fetching.resolve(snapshot(1, 1))
    await vi.waitFor(() => expect(runtime.getSnapshot().surfaceCursor).toBe(2))
    runtime.confirmSurface(surface(3), undefined, 3)
    runtime.confirmSurface(surface(1), undefined, 1)
    expect(runtime.getSnapshot().spaces[0]?.surfaces[0]?.state['value']).toBe(3)
    expect(runtime.getSnapshot().surfaceCursor).toBe(2)
    connections[0]!.onSurfacePatch(patch(2, 2))
    expect(runtime.getSnapshot().spaces[0]?.surfaces[0]?.state['value']).toBe(3)
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
    expect(sendChat).toHaveBeenCalledExactlyOnceWith('queued message', 'spc-test')
    expect(runtime.getSnapshot().queuedChat).toHaveLength(0)
    connections[0]!.onClose()
    await vi.advanceTimersByTimeAsync(1000)
    expect(connections[1]?.clientId).toBe('client-test')
    connections[1]!.onHello(0, 'client-test')
    expect(sendChat).toHaveBeenCalledTimes(1)
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

  it('resumes a queued intent after remount without applying a stopped HTTP result', async () => {
    const { runtime, connections, invokeFastAction } = setup()
    const oldResult = deferred<Awaited<ReturnType<typeof api.invokeFastAction>>>()
    invokeFastAction.mockReturnValueOnce(oldResult.promise)
    invokeFastAction.mockResolvedValue(fromPartial({ surface: surface(2), surfaceCursor: 2 }))
    await runtime.start()
    runtime.queueFastAction({
      id: 'queued-intent',
      surfaceId: 'srf-test',
      nodeId: 'root',
      actionName: 'set',
      value: 2,
      idempotencyKey: 'stable-intent',
      at: '2026-10-01T08:00:00Z',
    })
    connections[0]!.onHello(0, 'client-test')
    expect(invokeFastAction).toHaveBeenCalledTimes(1)
    runtime.stop()
    await runtime.start()
    connections[1]!.onHello(0, 'client-test')
    oldResult.resolve(fromPartial({ surface: surface(99), surfaceCursor: 99 }))
    await vi.waitFor(() => expect(invokeFastAction).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(runtime.getSnapshot().queuedFastActions).toHaveLength(0))
    expect(invokeFastAction.mock.calls.map((call) => call[5])).toEqual([
      'stable-intent',
      'stable-intent',
    ])
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
