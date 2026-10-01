import { fromPartial } from '@total-typescript/shoehorn'
import {
  inputSetPlan,
  literalSetPlan,
  SurfaceSchema,
  type ActionInvocation,
  type CommittedFastActionOutcome,
  type SurfaceSnapshot,
} from '@veduta/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as api from './api.ts'
import type { GatewayHandlers } from './gateway-client.ts'
import { createPwaLiveStateRuntime } from './pwa-live-state-runtime.ts'

const initial = SurfaceSchema.parse({
  id: 'srf-action',
  spaceId: 'spc-action',
  title: 'Actions',
  tree: {
    id: 'done',
    type: 'Checkbox',
    props: { label: 'Done' },
    binding: 'done',
    actions: [
      {
        name: 'toggle',
        path: 'fast',
        revision: 'acr-test',
        plan: inputSetPlan('done', { type: 'boolean' }),
      },
    ],
  },
  state: { done: false },
  pinned: false,
  pinnable: true,
  presentation: 'standard',
  freshness: { updatedAt: '2026-10-01T08:00:00Z', updatedBy: 'user' },
})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((done, failed) => {
    resolve = done
    reject = failed
  })
  return { promise, resolve, reject }
}

function committed(invocation: ActionInvocation, cursor = 1): CommittedFastActionOutcome {
  if (!('intentId' in invocation)) throw new Error('expected a fast invocation')
  return {
    outcome: 'committed',
    surfaceId: initial.id,
    nodeId: invocation.nodeId,
    actionName: invocation.name,
    actionRevision: invocation.actionRevision,
    intentId: invocation.intentId,
    surfaceVersion: cursor + 1,
    treeVersion: 1,
    surfaceCommitId: `scm-test-${cursor}`,
    eventCursor: cursor,
    surfaceCursor: cursor,
    duplicate: false,
    patch: {
      surfaceId: initial.id,
      operations: [{ target: 'state', op: 'replace', path: '/done', value: true }],
    },
    surface: { ...initial, state: { done: true } },
  }
}

function setup(stored: Record<string, string> = {}, fixture = initial) {
  const values = new Map(Object.entries(stored))
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
  const snapshot: SurfaceSnapshot = fromPartial({
    surfaceCursor: 0,
    spaces: [
      {
        id: 'spc-action',
        slug: 'actions',
        name: 'Actions',
        archived: false,
        attention: 0,
        attentionRevision: 0,
        surfaces: [fixture],
      },
    ],
  })
  const invokeSurfaceAction = vi.fn<typeof api.invokeSurfaceAction>()
  const fetchSpaces = vi.fn(async () => snapshot)
  const runtime = createPwaLiveStateRuntime({
    storage,
    api: {
      ...api,
      invokeSurfaceAction,
      fetchSpaces,
      fetchAuthStatus: vi.fn(async () => ({
        mode: 'dev' as const,
        bootstrapRequired: false,
        passkeyRegistered: false,
      })),
      fetchPendingDecisions: vi.fn(async () => ({ revision: 0, decisions: [] })),
      fetchAutomationOutcomeNotifications: vi.fn(async () => ({ revision: 0, notifications: [] })),
      connectGateway: (handlers) => {
        connections.push(handlers)
        return { sendChat: () => true, close: () => {} }
      },
    },
  })
  const start = async () => {
    await runtime.start()
    connections.at(-1)!.onHello(0, 'client-actions')
    await vi.waitFor(() => expect(fetchSpaces).toHaveBeenCalledTimes(2))
    await Promise.resolve()
  }
  return { runtime, invokeSurfaceAction, fetchSpaces, values, connections, start }
}

afterEach(() => vi.useRealTimers())

describe('PWA live Action lifecycle', () => {
  it('confirms a canonical HTTP result independently of motion after an unseen Table recomposition', async () => {
    const previous = SurfaceSchema.parse({
      ...initial,
      tree: {
        id: 'root',
        type: 'Box',
        children: [
          {
            id: 'button',
            type: 'Button',
            props: { label: 'Apply' },
            actions: [
              {
                name: 'apply',
                path: 'fast',
                revision: 'acr-test',
                plan: literalSetPlan('value', 1),
              },
            ],
          },
          { id: 'rows', type: 'Table', binding: 'rows', props: { columns: ['a'] } },
        ],
      },
      state: { value: 0, rows: [{ a: 'A' }] },
    })
    const next = SurfaceSchema.parse({
      ...previous,
      tree: {
        ...previous.tree,
        children: [
          previous.tree.children![0]!,
          { id: 'rows', type: 'Table', binding: 'rows', props: { columns: ['b'] } },
        ],
      },
      state: { value: 1, rows: [{ b: 'B' }] },
    })
    const { runtime, invokeSurfaceAction, values, start } = setup({}, previous)
    invokeSurfaceAction.mockImplementation(async (_id, invocation) => ({
      ...committed(invocation),
      surface: next,
      patch: {
        surfaceId: next.id,
        operations: [{ target: 'state', op: 'replace', path: '/value', value: 1 }],
      },
    }))
    await start()
    await runtime.dispatchSurfaceAction(previous.id, 'button', 'apply')
    expect(runtime.getSnapshot().queuedFastActions).toHaveLength(0)
    expect(runtime.getSnapshot().error).toBeNull()
    expect(JSON.parse(values.get('veduta.homeSnapshot')!).spaces[0].surfaces[0].state).toEqual(
      next.state,
    )
    runtime.stop()
  })

  it('resends an unsettled intent on reconnect while ignoring a hung old HTTP request', async () => {
    const { runtime, invokeSurfaceAction, connections, start } = setup()
    const oldResponse = deferred<api.SurfaceActionResponse>()
    invokeSurfaceAction.mockReturnValueOnce(oldResponse.promise)
    invokeSurfaceAction.mockImplementation(async (_id, invocation) => committed(invocation))
    await start()
    vi.useFakeTimers()
    const submission = runtime
      .dispatchSurfaceAction(initial.id, 'done', 'toggle', true)
      .catch((error: unknown) => error)
    const original = invokeSurfaceAction.mock.calls[0]![1]
    connections[0]!.onClose()
    await vi.advanceTimersByTimeAsync(1000)
    connections[1]!.onHello(0, 'client-actions')
    await Promise.resolve()
    expect(invokeSurfaceAction).toHaveBeenCalledTimes(2)
    expect(invokeSurfaceAction.mock.calls[1]![1]).toEqual(original)
    expect(await submission).toBeInstanceOf(Error)
    oldResponse.resolve(committed(original))
    await Promise.resolve()
    expect(runtime.getSnapshot().queuedFastActions).toHaveLength(0)
    expect(runtime.getSnapshot().spaces[0]?.surfaces[0]?.state['done']).toBe(true)
    runtime.stop()
  })

  it('visibly discards incompatible persisted commands without sending them', async () => {
    const { runtime, invokeSurfaceAction, start } = setup({
      'veduta.fastActionQueue': '{invalid',
    })
    await start()
    expect(runtime.getSnapshot().error).toContain('incompatible queued action')
    expect(runtime.getSnapshot().queuedFastActions).toHaveLength(0)
    expect(invokeSurfaceAction).not.toHaveBeenCalled()
    runtime.stop()
  })

  it('persists the complete invocation and reuses its intent after a retryable failure', async () => {
    const { runtime, invokeSurfaceAction, values, start } = setup()
    invokeSurfaceAction.mockRejectedValueOnce(new api.ApiResponseError('Gateway unavailable', 503))
    invokeSurfaceAction.mockImplementation(async (_id, invocation) => committed(invocation))
    await start()
    await expect(runtime.dispatchSurfaceAction(initial.id, 'done', 'toggle', true)).rejects.toThrow(
      'Gateway unavailable',
    )
    const original = invokeSurfaceAction.mock.calls[0]![1]
    const queue = JSON.parse(values.get('veduta.fastActionQueue')!)
    expect(queue).toHaveLength(1)
    expect(queue[0].invocation).toEqual(original)
    expect(runtime.getSnapshot().spaces[0]?.surfaces[0]?.state['done']).toBe(false)
    await runtime.dispatchSurfaceAction(initial.id, 'done', 'toggle', true)
    expect(invokeSurfaceAction.mock.calls[1]![1]).toEqual(original)
    expect(runtime.getSnapshot().queuedFastActions).toHaveLength(0)
    expect(runtime.getSnapshot().spaces[0]?.surfaces[0]?.state['done']).toBe(true)
    runtime.stop()
  })

  it('uses one typed intent and confirms realtime delivery despite a lost HTTP response', async () => {
    const { runtime, invokeSurfaceAction, connections, values, start } = setup()
    const response = deferred<api.SurfaceActionResponse>()
    invokeSurfaceAction.mockReturnValue(response.promise)
    await start()
    const first = runtime.dispatchSurfaceAction(initial.id, 'done', 'toggle', true)
    const second = runtime.dispatchSurfaceAction(initial.id, 'done', 'toggle', true)
    expect(invokeSurfaceAction).toHaveBeenCalledTimes(1)
    const invocation = invokeSurfaceAction.mock.calls[0]![1]
    expect(invocation).toMatchObject({
      nodeId: 'done',
      name: 'toggle',
      actionRevision: 'acr-test',
      inputs: { value: true },
    })
    expect(runtime.getSnapshot().spaces[0]?.surfaces[0]?.state['done']).toBe(false)
    const outcome = committed(invocation)
    const { surface: _surface, patch, ...actionOutcome } = outcome
    connections[0]!.onSurfacePatch({
      cursor: 1,
      at: '2026-10-01T08:00:01Z',
      spaceId: initial.spaceId,
      patch,
      actionOutcome,
      freshness: outcome.surface.freshness,
    })
    await Promise.all([first, second])
    response.reject(new Error('HTTP response lost'))
    await Promise.resolve()
    expect(runtime.getSnapshot().error).toBeNull()
    expect(runtime.getSnapshot().queuedFastActions).toHaveLength(0)
    expect(JSON.parse(values.get('veduta.homeSnapshot')!).spaces[0].surfaces[0].state.done).toBe(
      true,
    )
    runtime.stop()
  })

  it('keeps Event recovery pending and acknowledges its late canonical receipt once', async () => {
    const { runtime, invokeSurfaceAction, connections, start } = setup()
    invokeSurfaceAction.mockImplementation(async (_id, invocation) => {
      const outcome = committed(invocation)
      return {
        outcome: 'recovery_pending',
        surfaceId: outcome.surfaceId,
        nodeId: outcome.nodeId,
        actionName: outcome.actionName,
        actionRevision: outcome.actionRevision,
        intentId: outcome.intentId,
        surfaceCommitId: outcome.surfaceCommitId,
        spaceId: initial.spaceId,
        duplicate: false,
      }
    })
    await start()
    await expect(runtime.dispatchSurfaceAction(initial.id, 'done', 'toggle', true)).rejects.toThrow(
      'awaiting Event recovery',
    )
    expect(runtime.getSnapshot().queuedFastActions[0]?.status).toBe('recovery_pending')
    expect(runtime.getSnapshot().spaces[0]?.surfaces[0]?.state['done']).toBe(false)
    const outcome = committed(invokeSurfaceAction.mock.calls[0]![1])
    const { surface: _surface, patch, ...actionOutcome } = outcome
    connections[0]!.onSurfacePatch({
      cursor: 1,
      at: '2026-10-01T08:00:01Z',
      spaceId: initial.spaceId,
      patch,
      actionOutcome,
      freshness: outcome.surface.freshness,
    })
    expect(runtime.getSnapshot().queuedFastActions).toHaveLength(0)
    await runtime.dispatchSurfaceAction(initial.id, 'done', 'toggle', true)
    expect(invokeSurfaceAction).toHaveBeenCalledTimes(1)
    runtime.stop()
  })

  it('keeps a failed local submission acknowledgement after automatic retry succeeds', async () => {
    const { runtime, invokeSurfaceAction, connections, start } = setup()
    invokeSurfaceAction.mockRejectedValueOnce(new api.ApiResponseError('Retry required', 503))
    invokeSurfaceAction.mockImplementation(async (_id, invocation) => committed(invocation))
    await start()
    await expect(runtime.dispatchSurfaceAction(initial.id, 'done', 'toggle', true)).rejects.toThrow(
      'Retry required',
    )
    vi.useFakeTimers()
    connections[0]!.onClose()
    await vi.advanceTimersByTimeAsync(1000)
    connections[1]!.onHello(0, 'client-actions')
    await Promise.resolve()
    expect(runtime.getSnapshot().queuedFastActions).toHaveLength(0)
    expect(invokeSurfaceAction).toHaveBeenCalledTimes(2)
    await runtime.dispatchSurfaceAction(initial.id, 'done', 'toggle', true)
    expect(invokeSurfaceAction).toHaveBeenCalledTimes(2)
    runtime.stop()
  })

  it('keeps an identical new gesture separate from a superseded unsettled intent', async () => {
    const { runtime, invokeSurfaceAction, connections, start } = setup()
    invokeSurfaceAction.mockRejectedValue(new api.ApiResponseError('Retry required', 503))
    await start()
    for (const value of [true, false, true]) {
      await expect(
        runtime.dispatchSurfaceAction(initial.id, 'done', 'toggle', value),
      ).rejects.toThrow('Retry required')
    }
    const invocations = invokeSurfaceAction.mock.calls.map(([, invocation]) => {
      if (!('intentId' in invocation)) throw new Error('expected a fast invocation')
      return invocation
    })
    expect(new Set(invocations.map((invocation) => invocation.intentId)).size).toBe(3)
    expect(runtime.getSnapshot().queuedFastActions).toHaveLength(3)
    const older = committed(invocations[0]!)
    const { surface: _surface, patch, ...actionOutcome } = older
    connections[0]!.onSurfacePatch({
      cursor: 1,
      at: '2026-10-01T08:00:01Z',
      spaceId: initial.spaceId,
      patch,
      actionOutcome,
      freshness: older.surface.freshness,
    })
    expect(runtime.getSnapshot().queuedFastActions).toHaveLength(2)
    expect(runtime.getSnapshot().actionConfirmations[initial.id]).toBeUndefined()
    runtime.stop()
  })

  it('rejects a stale queued declaration visibly without rewriting its revision or intent', async () => {
    const invocation = {
      nodeId: 'done',
      name: 'toggle',
      actionRevision: 'acr-obsolete',
      intentId: 'aaaa1111-1111-4111-8111-111111111111',
      inputs: { value: true },
    }
    const { runtime, invokeSurfaceAction, start } = setup({
      'veduta.fastActionQueue': JSON.stringify([
        {
          id: invocation.intentId,
          surfaceId: initial.id,
          invocation,
          at: '2026-10-01T08:00:00Z',
          status: 'queued',
        },
      ]),
    })
    invokeSurfaceAction.mockRejectedValue(
      new api.ApiResponseError('This action is stale. Refresh it.', 409),
    )
    await start()
    await vi.waitFor(() => expect(runtime.getSnapshot().queuedFastActions).toHaveLength(0))
    expect(invokeSurfaceAction).toHaveBeenCalledExactlyOnceWith(initial.id, invocation, undefined)
    expect(runtime.getSnapshot().error).toContain('stale')
    expect(runtime.getSnapshot().spaces[0]?.surfaces[0]?.state['done']).toBe(false)
    runtime.stop()
  })

  it('accepts a typed noop without inventing a Surface update or dropping authentication on rejection', async () => {
    const { runtime, invokeSurfaceAction, start } = setup()
    invokeSurfaceAction.mockImplementationOnce(async (_id, invocation) => {
      if (!('intentId' in invocation)) throw new Error('expected a fast invocation')
      return {
        outcome: 'noop',
        reason: 'unchanged',
        surfaceId: initial.id,
        nodeId: invocation.nodeId,
        actionName: invocation.name,
        actionRevision: invocation.actionRevision,
        intentId: invocation.intentId,
        duplicate: false,
      }
    })
    invokeSurfaceAction.mockRejectedValue(new api.ApiResponseError('Control disabled', 403))
    await start()
    await runtime.dispatchSurfaceAction(initial.id, 'done', 'toggle', true)
    expect(runtime.getSnapshot().spaces[0]?.surfaces[0]?.state).toEqual({ done: false })
    expect(runtime.getSnapshot().surfaceCursor).toBe(0)
    expect(runtime.getSnapshot().surfaceUpdateFeedbacks).toEqual({})
    expect(runtime.getSnapshot().queuedFastActions).toHaveLength(0)
    await expect(runtime.dispatchSurfaceAction(initial.id, 'done', 'toggle', true)).rejects.toThrow(
      'Control disabled',
    )
    expect(runtime.getSnapshot().gatewayOnline).toBe(true)
    expect(runtime.getSnapshot().queuedFastActions).toHaveLength(0)
    runtime.stop()
  })
})
