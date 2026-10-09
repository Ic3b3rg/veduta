import { fromPartial } from '@total-typescript/shoehorn'
import { SurfaceSchema, type SurfaceSnapshot, type SurfaceOrder } from '@veduta/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as api from './api.ts'
import { createPwaLiveStateRuntime, type PwaLiveStateRuntime } from './pwa-live-state-runtime.ts'

const runtimes: PwaLiveStateRuntime[] = []
afterEach(() => {
  runtimes.splice(0).forEach((runtime) => runtime.stop())
  vi.useRealTimers()
})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((done, failed) => {
    resolve = done
    reject = failed
  })
  return { promise, resolve, reject }
}

async function setup(pinned = false, firstId = 'srf-first') {
  const first = SurfaceSchema.parse({
    id: firstId,
    spaceId: 'spc-test',
    title: 'First',
    pinned,
    tree: { id: 'root', type: 'Text', props: { text: 'First content' } },
    state: {},
    freshness: { updatedAt: '2026-10-01T08:00:00Z', updatedBy: 'user' },
  })
  const second = { ...first, id: 'srf-second', title: 'Second', pinned: false }
  const snapshot: SurfaceSnapshot = {
    surfaceCursor: 0,
    spaces: [
      {
        id: 'spc-test',
        slug: 'test',
        name: 'Test',
        archived: false,
        attention: 0,
        attentionRevision: 0,
        surfaces: [first, second],
      },
    ],
  }
  const values = new Map<string, string>()
  const write = vi.fn((key: string, value: string) => {
    values.set(key, value)
  })
  const connections: api.GatewayHandlers[] = []
  const pinSurface = vi.fn(api.pinSurface)
  const moveSurface = vi.fn(api.moveSurface)
  const sendChat = vi.fn(() => true)
  const invokeSurfaceAction = vi.fn(api.invokeSurfaceAction)
  const fetchSpaces = vi.fn(async () => snapshot)
  const runtime = createPwaLiveStateRuntime({
    storage: fromPartial<Storage>({
      getItem: (key: string) => values.get(key) ?? null,
      setItem: write,
      removeItem: (key: string) => {
        values.delete(key)
      },
    }),
    api: {
      ...api,
      pinSurface,
      moveSurface,
      fetchSpaces,
      invokeSurfaceAction,
      fetchAuthStatus: async () => ({
        mode: 'dev',
        bootstrapRequired: false,
        passkeyRegistered: false,
      }),
      fetchPendingDecisions: async () => ({ revision: 0, decisions: [] }),
      fetchAutomationOutcomeNotifications: async () => ({ revision: 0, notifications: [] }),
      fetchChatTimeline: async () => ({ entries: [] }),
      connectGateway: (handlers) => {
        connections.push(handlers)
        return { close: vi.fn(), sendChat }
      },
    },
  })
  runtimes.push(runtime)
  await runtime.start()
  connections[0]!.onHello(0, 'client-order')
  await runtime.refreshSpaces()
  return {
    runtime,
    first,
    second,
    connections,
    pinSurface,
    moveSurface,
    values,
    write,
    sendChat,
    invokeSurfaceAction,
    fetchSpaces,
  }
}

function order(pinned: boolean, cursor = 1): SurfaceOrder {
  return {
    spaceId: 'spc-test',
    cursor,
    pinnedSurfaceIds: pinned ? ['srf-first'] : [],
    regularSurfaceIds: pinned ? ['srf-second'] : ['srf-first', 'srf-second'],
  }
}

describe('Surface ordering commands', () => {
  it.each(
    ['Pin', 'Unpin', 'Move'].flatMap((action) =>
      ['srf-first', '__proto__'].map((id) => ({ action, id })),
    ),
  )(
    'keeps $action single-flight for $id while unrelated work is pending',
    async ({ action, id }) => {
      const { runtime, first, second, pinSurface, moveSurface } = await setup(
        action === 'Unpin',
        id,
      )
      const pin = deferred<Awaited<ReturnType<typeof api.pinSurface>>>()
      const move = deferred<Awaited<ReturnType<typeof api.moveSurface>>>()
      pinSurface.mockReturnValue(pin.promise)
      moveSurface.mockReturnValue(move.promise)
      const before = runtime.getSnapshot().spaces
      const work =
        action === 'Move'
          ? runtime.moveSurface(first.spaceId, first.id, 'down')
          : runtime.togglePin(first)
      void runtime.togglePin(first)
      void runtime.moveSurface(first.spaceId, first.id, 'up')
      expect(pinSurface.mock.calls.length + moveSurface.mock.calls.length).toBe(1)
      expect(runtime.getSnapshot().spaces).toBe(before)
      expect(runtime.getSnapshot().surfaceOrderStatuses[first.id]?.state).toBe('pending')
      const other = runtime.moveSurface(second.spaceId, second.id, 'up')
      expect(moveSurface).toHaveBeenCalledWith(second.spaceId, second.id, 'up', undefined)
      void runtime.togglePin(first)
      expect(pinSurface.mock.calls.length + moveSurface.mock.calls.length).toBe(2)
      if (pinSurface.mock.calls.length > 0) pin.reject(new Error('rejected'))
      move.reject(new Error('transport failed'))
      await Promise.all([work, other])
      expect(runtime.getSnapshot().spaces).toBe(before)
      expect(runtime.getSnapshot().surfaceOrderStatuses[first.id]).toMatchObject({
        state: 'failed',
        message: expect.stringContaining(action),
      })
      expect(runtime.getSnapshot().surfaceOrderStatuses[first.id]?.message).toContain('First')
    },
  )

  it.each(['HTTP first', 'live first'] as const)(
    'converges delayed Pin confirmation in %s order without optimistic changes',
    async (delivery) => {
      const { runtime, first, pinSurface, connections } = await setup()
      const response = deferred<Awaited<ReturnType<typeof api.pinSurface>>>()
      pinSurface.mockReturnValue(response.promise)
      const confirmed = {
        ...first,
        pinned: true,
        freshness: { updatedAt: '2026-10-01T08:01:00Z', updatedBy: 'user' as const },
      }
      const before = runtime.getSnapshot().spaces
      const work = runtime.togglePin(first)
      expect(runtime.getSnapshot().spaces).toBe(before)
      const frame = {
        cursor: 1,
        at: confirmed.freshness.updatedAt,
        spaceId: first.spaceId,
        surfaceId: first.id,
        pinned: true,
        freshness: confirmed.freshness,
        order: order(true),
      }
      if (delivery === 'live first') connections[0]!.onSurfacePinned(frame)
      const afterLive = runtime.getSnapshot().spaces
      response.resolve({ changed: true, surface: confirmed, order: order(true) })
      await work
      if (delivery === 'live first') expect(runtime.getSnapshot().spaces).toBe(afterLive)
      const afterConfirmation = runtime.getSnapshot().spaces
      if (delivery === 'HTTP first') connections[0]!.onSurfacePinned(frame)
      connections[0]!.onSurfacePinned(frame)
      expect(runtime.getSnapshot().spaces).toBe(afterConfirmation)
      expect(runtime.getSnapshot().spaces[0]?.surfaces).toHaveLength(2)
      expect(runtime.getSnapshot().spaces[0]?.surfaces[0]).toEqual(confirmed)
      expect(runtime.getSnapshot().surfaceOrderStatuses[first.id]).toBeUndefined()
    },
  )

  it('refuses offline ordering without adding any queued work or retrying on reconnect', async () => {
    vi.useFakeTimers()
    const {
      runtime,
      first,
      connections,
      pinSurface,
      moveSurface,
      values,
      sendChat,
      invokeSurfaceAction,
    } = await setup()
    const before = runtime.getSnapshot().spaces
    connections[0]!.onClose()
    const storedBefore = new Map(values)
    await runtime.togglePin(first)
    await runtime.togglePin({ ...first, pinned: true })
    await runtime.moveSurface(first.spaceId, first.id, 'down')
    expect(runtime.getSnapshot().surfaceOrderStatuses[first.id]).toMatchObject({
      state: 'failed',
      message: expect.stringContaining('offline'),
    })
    expect(pinSurface).not.toHaveBeenCalled()
    expect(moveSurface).not.toHaveBeenCalled()
    expect(runtime.getSnapshot().spaces).toBe(before)
    expect(runtime.getSnapshot().queuedChat).toEqual([])
    expect(runtime.getSnapshot().queuedFastActions).toEqual([])
    expect(values).toEqual(storedBefore)
    await vi.advanceTimersByTimeAsync(1000)
    connections[1]!.onHello(0, 'client-order')
    await runtime.refreshSpaces()
    expect(pinSurface).not.toHaveBeenCalled()
    expect(moveSurface).not.toHaveBeenCalled()
    expect(sendChat).not.toHaveBeenCalled()
    expect(invokeSurfaceAction).not.toHaveBeenCalled()
    moveSurface.mockResolvedValue({
      changed: true,
      order: { ...order(false), regularSurfaceIds: ['srf-second', 'srf-first'] },
    })
    await runtime.moveSurface(first.spaceId, first.id, 'down')
    expect(moveSurface).toHaveBeenCalledOnce()
    expect(runtime.getSnapshot().spaces[0]?.surfaces.map((s) => s.id)).toEqual([
      'srf-second',
      'srf-first',
    ])
    expect(runtime.getSnapshot().surfaceOrderStatuses[first.id]).toBeUndefined()
  })

  it('does not let a request from a stopped lifetime update a restarted runtime', async () => {
    const { runtime, first, pinSurface } = await setup()
    const response = deferred<Awaited<ReturnType<typeof api.pinSurface>>>()
    pinSurface.mockReturnValue(response.promise)
    const work = runtime.togglePin(first)
    runtime.stop()
    await runtime.start()
    response.resolve({ changed: true, surface: { ...first, pinned: true }, order: order(true) })
    await work
    expect(runtime.getSnapshot().spaces[0]?.surfaces[0]?.pinned).toBe(false)
    expect(runtime.getSnapshot().surfaceOrderStatuses[first.id]).toBeUndefined()
  })

  it('keeps an accepted Pin pending until a missing prerequisite is reconciled', async () => {
    const { runtime, first, second, pinSurface, fetchSpaces } = await setup()
    const before = runtime.getSnapshot().spaces
    const refresh = deferred<SurfaceSnapshot>()
    fetchSpaces.mockReturnValueOnce(refresh.promise)
    pinSurface.mockResolvedValue({
      changed: true,
      surface: { ...first, pinned: true },
      order: { ...order(true), pinnedSurfaceIds: ['srf-first', 'srf-missing'] },
    })
    await runtime.togglePin(first)
    expect(runtime.getSnapshot().spaces).toEqual(before)
    expect(runtime.getSnapshot().surfaceOrderStatuses[first.id]).toMatchObject({
      state: 'pending',
      message: expect.stringContaining('accepted'),
    })
    await runtime.togglePin(first)
    expect(pinSurface).toHaveBeenCalledOnce()
    refresh.resolve({
      surfaceCursor: 1,
      spaces: [
        {
          ...before[0]!,
          surfaces: [
            { ...first, pinned: true },
            { ...first, id: 'srf-missing', pinned: true },
            second,
          ],
        },
      ],
    })
    await runtime.refreshSpaces()
    expect(runtime.getSnapshot().surfaceOrderStatuses[first.id]).toBeUndefined()
    expect(runtime.getSnapshot().spaces[0]?.surfaces[0]?.pinned).toBe(true)
    expect(pinSurface).toHaveBeenCalledOnce()
  })

  it('keeps accepted work protected and reconciles even when the optional offline cache is full', async () => {
    const { runtime, first, second, pinSurface, fetchSpaces, write } = await setup()
    const before = runtime.getSnapshot().spaces
    const refresh = deferred<SurfaceSnapshot>()
    fetchSpaces.mockReturnValueOnce(refresh.promise)
    write.mockImplementation(() => {
      throw new DOMException('Storage full', 'QuotaExceededError')
    })
    pinSurface.mockResolvedValue({
      changed: true,
      surface: { ...first, pinned: true },
      order: { ...order(true), pinnedSurfaceIds: ['srf-first', 'srf-missing'] },
    })
    await runtime.togglePin(first)
    expect(runtime.getSnapshot().surfaceOrderStatuses[first.id]?.state).toBe('pending')
    await runtime.togglePin(first)
    expect(pinSurface).toHaveBeenCalledOnce()
    expect(fetchSpaces).toHaveBeenCalledTimes(3)
    refresh.resolve({
      surfaceCursor: 1,
      spaces: [
        {
          ...before[0]!,
          surfaces: [
            { ...first, pinned: true },
            { ...first, id: 'srf-missing', pinned: true },
            second,
          ],
        },
      ],
    })
    await runtime.refreshSpaces()
    expect(runtime.getSnapshot().surfaceOrderStatuses[first.id]).toBeUndefined()
    expect(runtime.getSnapshot().spaces[0]?.surfaces[0]?.pinned).toBe(true)
    expect(pinSurface).toHaveBeenCalledOnce()
    expect(runtime.getSnapshot().error).toContain('offline copy')
    expect(runtime.getSnapshot().error).not.toContain('Pin')
  })

  it.each(['snapshot', 'confirmation'] as const)(
    'reconciles concurrent accepted Pin and Move through %s without repeating commands',
    async (recovery) => {
      const { runtime, first, second, pinSurface, moveSurface, fetchSpaces, connections } =
        await setup()
      const third = { ...second, id: 'srf-third', title: 'Third' }
      const initial: SurfaceSnapshot = {
        surfaceCursor: 0,
        spaces: [{ ...runtime.getSnapshot().spaces[0]!, surfaces: [first, second, third] }],
      }
      fetchSpaces.mockResolvedValue(initial)
      await runtime.refreshSpaces()
      const pin = deferred<Awaited<ReturnType<typeof api.pinSurface>>>()
      const move = deferred<Awaited<ReturnType<typeof api.moveSurface>>>()
      const refresh = deferred<SurfaceSnapshot>()
      pinSurface.mockReturnValue(pin.promise)
      moveSurface.mockReturnValue(move.promise)
      fetchSpaces.mockReturnValueOnce(refresh.promise)
      const pinning = runtime.togglePin(first)
      const moving = runtime.moveSurface(third.spaceId, third.id, 'up')
      const moveOrder = { ...order(true, 2), regularSurfaceIds: [third.id, second.id] }
      move.resolve({ changed: true, order: moveOrder })
      await moving
      expect(runtime.getSnapshot().surfaceOrderStatuses[third.id]?.state).toBe('pending')
      const pinned = { ...first, pinned: true }
      const pinResult = {
        changed: true,
        surface: pinned,
        order: { ...order(true), regularSurfaceIds: [second.id, third.id] },
      }
      if (recovery === 'snapshot') {
        refresh.resolve({
          surfaceCursor: 2,
          spaces: [{ ...initial.spaces[0]!, surfaces: [pinned, third, second] }],
        })
        await runtime.refreshSpaces()
      }
      pin.resolve(pinResult)
      await pinning
      if (recovery === 'confirmation') {
        expect(runtime.getSnapshot().spaces[0]?.surfaces.map((s) => s.id)).toEqual([
          first.id,
          third.id,
          second.id,
        ])
        refresh.resolve(initial)
        await runtime.refreshSpaces()
      }
      connections[0]!.onSurfacePinned({
        cursor: 1,
        at: first.freshness.updatedAt,
        spaceId: first.spaceId,
        surfaceId: first.id,
        pinned: true,
        freshness: first.freshness,
        order: pinResult.order,
      })
      connections[0]!.onSurfaceMoved({
        cursor: 2,
        at: first.freshness.updatedAt,
        spaceId: first.spaceId,
        surfaceId: third.id,
        direction: 'up',
        order: moveOrder,
      })
      expect(runtime.getSnapshot().spaces[0]?.surfaces.map((s) => s.id)).toEqual([
        first.id,
        third.id,
        second.id,
      ])
      expect(runtime.getSnapshot().surfaceOrderStatuses[first.id]).toBeUndefined()
      expect(runtime.getSnapshot().surfaceOrderStatuses[third.id]).toBeUndefined()
      expect(pinSurface).toHaveBeenCalledOnce()
      expect(moveSurface).toHaveBeenCalledOnce()
    },
  )
})
