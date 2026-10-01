import { fromPartial } from '@total-typescript/shoehorn'
import {
  inputSetPlan,
  SurfaceSchema,
  type ActionInvocation,
  type CommittedFastActionOutcome,
  type SurfaceSnapshot,
} from '@veduta/protocol'
import { describe, expect, it, vi } from 'vitest'
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

function setup(stored: Record<string, string> = {}) {
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
        surfaces: [initial],
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

describe('PWA live Action lifecycle', () => {
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
})
