// @vitest-environment jsdom
import { fromPartial } from '@total-typescript/shoehorn'
import {
  AgentActionInvocationSchema,
  AgentActionTurnSchema,
  SurfaceSchema,
  type SurfaceSnapshot,
} from '@veduta/protocol'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useSyncExternalStore } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import * as api from './api.ts'
import type { GatewayHandlers } from './gateway-client.ts'
import { createPwaLiveStateRuntime, type PwaLiveStateRuntime } from './pwa-live-state-runtime.ts'
import { SurfaceCard } from './surface-card.tsx'
import { PwaRuntimeContext } from './use-live-state.ts'

const initial = SurfaceSchema.parse({
  id: 'srf-agent-control',
  spaceId: 'spc-test',
  title: 'Agent action demo',
  freshness: { updatedAt: '2026-10-01T12:00:00.000Z', updatedBy: 'agent' },
  state: { result: 'Waiting', records: [] },
  tree: {
    id: 'demo-root',
    type: 'Col',
    children: [
      { id: 'result', type: 'Stat', binding: 'result', props: { label: 'Result' } },
      { id: 'records', type: 'Table', binding: 'records', props: { columns: ['label'] } },
      {
        id: 'demo-button',
        type: 'Button',
        props: { label: 'Complete demo' },
        actions: [
          {
            name: 'complete_demo',
            path: 'agent',
            payload: { request: 'Complete the Agent action demo' },
          },
        ],
      },
    ],
  },
})

function AgentCard({ runtime }: { runtime: PwaLiveStateRuntime }) {
  const snapshot = useSyncExternalStore(runtime.subscribe, runtime.getSnapshot)
  const surface = snapshot.spaces[0]?.surfaces[0]
  if (!surface) return null
  return (
    <PwaRuntimeContext.Provider value={runtime}>
      <SurfaceCard
        surface={surface}
        selected={false}
        canMoveUp={false}
        canMoveDown={false}
        onFocus={() => {}}
        onMoveUp={() => {}}
        onMoveDown={() => {}}
        onTogglePin={() => {}}
        onRevealFeedbackShown={() => {}}
      />
    </PwaRuntimeContext.Provider>
  )
}

beforeEach(() =>
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  ),
)
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

it('an unfinished Agent control remains busy after Card remount and runtime reload until its canonical effect completes', async () => {
  const values = new Map<string, string>()
  const storage = fromPartial<Storage>({
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  })
  const snapshot = fromPartial<SurfaceSnapshot>({
    surfaceCursor: 0,
    spaces: [{ id: initial.spaceId, name: 'Test', slug: 'test', surfaces: [initial] }],
  })
  const connections: GatewayHandlers[] = []
  const invokeSurfaceAction = vi
    .fn<typeof api.invokeSurfaceAction>()
    .mockReturnValue(new Promise<api.SurfaceActionResponse>(() => {}))
  const createRuntime = () =>
    createPwaLiveStateRuntime({
      storage,
      api: {
        ...api,
        invokeSurfaceAction,
        fetchSpaces: vi.fn(async () => snapshot),
        fetchAuthStatus: vi.fn(async () => ({
          mode: 'dev' as const,
          bootstrapRequired: false,
          passkeyRegistered: false,
        })),
        fetchPendingDecisions: vi.fn(async () => ({ revision: 0, decisions: [] })),
        fetchAutomationOutcomeNotifications: vi.fn(async () => ({
          revision: 0,
          notifications: [],
        })),
        connectGateway: (handlers) => {
          connections.push(handlers)
          return { sendChat: () => true, close: () => {} }
        },
      },
    })
  const first = createRuntime()
  let reloaded: PwaLiveStateRuntime | undefined
  try {
    await first.start()
    await act(async () => connections[0]?.onHello(0, 'agent-control-client'))
    const mounted = render(<AgentCard runtime={first} />)
    const control = () => screen.getByRole('button', { name: 'Complete demo' })
    fireEvent.click(control())
    expect(control()).toHaveProperty('disabled', true)
    const original = AgentActionInvocationSchema.parse(invokeSurfaceAction.mock.calls[0]?.[1])
    mounted.unmount()
    const remounted = render(<AgentCard runtime={first} />)
    expect(control()).toHaveProperty('disabled', true)
    expect(control().getAttribute('aria-busy')).toBe('true')
    expect(screen.getByRole('status').textContent).toBe('Working…')
    fireEvent.click(control())
    expect(invokeSurfaceAction).toHaveBeenCalledTimes(1)
    remounted.unmount()
    first.stop()

    reloaded = createRuntime()
    await reloaded.start()
    await act(async () => connections[1]?.onHello(0, 'agent-control-client'))
    render(<AgentCard runtime={reloaded} />)
    expect(invokeSurfaceAction).toHaveBeenCalledTimes(2)
    expect(invokeSurfaceAction.mock.calls[1]?.[1]).toEqual(original)
    expect(control()).toHaveProperty('disabled', true)
    expect(control().getAttribute('aria-busy')).toBe('true')
    expect(screen.getByRole('status').textContent).toBe('Working…')
    expect(screen.getByText('Waiting')).toBeDefined()
    const gateway = connections[1]
    if (!gateway?.onSurfaceActionTurn) throw new Error('Agent lifecycle connection unavailable')
    await act(async () =>
      gateway.onSurfacePatch({
        cursor: 1,
        at: '2026-10-01T12:00:01.000Z',
        spaceId: initial.spaceId,
        freshness: { updatedAt: '2026-10-01T12:00:01.000Z', updatedBy: 'agent' },
        patch: {
          surfaceId: initial.id,
          operations: [
            { target: 'state', op: 'replace', path: '/result', value: 'Completed' },
            {
              target: 'state',
              op: 'replace',
              path: '/records',
              value: [{ id: 'agent-demo-1', label: 'Completed' }],
            },
          ],
        },
      }),
    )
    expect(control()).toHaveProperty('disabled', true)
    await act(async () =>
      gateway.onSurfaceActionTurn?.({
        type: 'surface.action-turn',
        turn: AgentActionTurnSchema.parse({
          id: 'agent-turn-remount',
          spaceId: initial.spaceId,
          surfaceId: initial.id,
          atomId: original.nodeId,
          actionName: original.name,
          idempotencyKey: original.idempotencyKey,
          status: 'completed',
          surfaceCursor: 1,
          message: { role: 'assistant', text: 'The declared Agent action completed.' },
        }),
      }),
    )
    await waitFor(() => expect(control()).toHaveProperty('disabled', false))
    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getAllByRole('cell', { name: 'Completed' })).toHaveLength(1)
  } finally {
    first.stop()
    reloaded?.stop()
  }
})

it.each([
  { label: 'declared payload', payload: { request: 'Complete the Agent action demo' } },
  { label: 'omitted payload', payload: undefined },
])(
  'an Agent Button with $label waits for canonical completion, clears a late failure, and gives a fresh click a fresh identity',
  async ({ payload }) => {
    const before = SurfaceSchema.parse({
      ...initial,
      tree: {
        ...initial.tree,
        children: initial.tree.children?.map((node) =>
          node.id === 'demo-button'
            ? {
                ...node,
                actions: [
                  { name: 'complete_demo', path: 'agent', ...(payload ? { payload } : {}) },
                ],
              }
            : node,
        ),
      },
    })
    const values = new Map<string, string>()
    const storage = fromPartial<Storage>({
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => void values.set(key, value),
      removeItem: (key: string) => void values.delete(key),
    })
    const connections: GatewayHandlers[] = []
    const snapshot = fromPartial<SurfaceSnapshot>({
      surfaceCursor: 0,
      spaces: [{ id: before.spaceId, name: 'Test', slug: 'test', surfaces: [before] }],
    })
    let loseSecondResponse: (failure: Error) => void = () => {
      throw new Error('No held Agent response')
    }
    const secondResponse = new Promise<api.SurfaceActionResponse>((_resolve, reject) => {
      loseSecondResponse = reject
    })
    const invokeSurfaceAction = vi
      .fn<typeof api.invokeSurfaceAction>()
      .mockRejectedValueOnce(new api.ApiResponseError('Gateway unavailable. Try again.', 503))
      .mockReturnValueOnce(secondResponse)
    const runtime = createPwaLiveStateRuntime({
      storage,
      api: {
        ...api,
        invokeSurfaceAction,
        fetchSpaces: vi.fn(async () => snapshot),
        fetchAuthStatus: vi.fn(async () => ({
          mode: 'dev' as const,
          bootstrapRequired: false,
          passkeyRegistered: false,
        })),
        fetchPendingDecisions: vi.fn(async () => ({ revision: 0, decisions: [] })),
        fetchAutomationOutcomeNotifications: vi.fn(async () => ({
          revision: 0,
          notifications: [],
        })),
        connectGateway: (handlers) => {
          connections.push(handlers)
          return { sendChat: () => true, close: () => {} }
        },
      },
    })
    try {
      await runtime.start()
      const gateway = connections[0]
      if (!gateway?.onSurfaceActionTurn) throw new Error('Agent lifecycle connection unavailable')
      await act(async () => gateway.onHello(0, 'agent-control-client'))
      render(<AgentCard runtime={runtime} />)
      const button = screen.getByRole('button', { name: 'Complete demo' })
      fireEvent.click(button)
      const alert = await screen.findByRole('alert')
      expect(alert.textContent).toBe('Gateway unavailable. Try again.')
      expect(button.getAttribute('aria-describedby')).toBe(alert.id)
      expect(button).toHaveProperty('disabled', false)
      expect(screen.getByText('Waiting')).toBeDefined()
      const original = AgentActionInvocationSchema.parse(invokeSurfaceAction.mock.calls[0]?.[1])
      expect(original.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/)
      expect(original.payload).toEqual(payload ?? {})

      const complete = (idempotencyKey: string | undefined, cursor: number) => {
        const turn = AgentActionTurnSchema.parse({
          id: `agent-turn-${cursor}`,
          spaceId: before.spaceId,
          surfaceId: before.id,
          atomId: original.nodeId,
          actionName: original.name,
          idempotencyKey,
          status: 'completed',
          surfaceCursor: cursor,
          message: { role: 'assistant', text: 'The declared Agent action completed.' },
        })
        if (turn.status !== 'completed') throw new Error('Expected completed Agent fixture')
        return turn
      }
      const patch = (cursor: number) => ({
        cursor,
        at: '2026-10-01T12:00:01.000Z',
        spaceId: before.spaceId,
        patch: {
          surfaceId: before.id,
          operations: [
            {
              target: 'state' as const,
              op: 'replace' as const,
              path: '/result',
              value: 'Completed',
            },
            {
              target: 'state' as const,
              op: 'replace' as const,
              path: '/records',
              value: Array.from({ length: cursor }, (_, index) => ({
                id: `agent-demo-${index + 1}`,
                label: 'Completed',
              })),
            },
          ],
        },
        freshness: { updatedAt: '2026-10-01T12:00:01.000Z', updatedBy: 'agent' as const },
      })
      await act(async () => gateway.onSurfacePatch(patch(1)))
      expect(screen.getAllByRole('cell', { name: 'Completed' })).toHaveLength(1)
      expect(screen.getByRole('alert').textContent).toBe('Gateway unavailable. Try again.')
      await act(async () =>
        gateway.onSurfaceActionTurn?.({
          type: 'surface.action-turn',
          turn: complete(original.idempotencyKey, 1),
        }),
      )
      await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
      expect(button.getAttribute('aria-invalid')).toBeNull()
      expect(JSON.parse(values.get('veduta.agentActionQueue') ?? '[]')).toEqual([])

      fireEvent.click(button)
      const fresh = AgentActionInvocationSchema.parse(invokeSurfaceAction.mock.calls[1]?.[1])
      expect(fresh.idempotencyKey).not.toBe(original.idempotencyKey)
      expect(button).toHaveProperty('disabled', true)
      expect(button.getAttribute('aria-busy')).toBe('true')
      const {
        message: _message,
        surfaceCursor: _cursor,
        ...identity
      } = complete(fresh.idempotencyKey, 2)
      await act(async () =>
        gateway.onSurfaceActionTurn?.({
          type: 'surface.action-turn',
          turn: AgentActionTurnSchema.parse({ ...identity, status: 'running' }),
        }),
      )
      expect(button).toHaveProperty('disabled', true)
      expect(screen.getAllByRole('cell', { name: 'Completed' })).toHaveLength(1)
      await act(async () => gateway.onSurfacePatch(patch(2)))
      expect(button).toHaveProperty('disabled', true)
      await act(async () =>
        gateway.onSurfaceActionTurn?.({
          type: 'surface.action-turn',
          turn: complete(fresh.idempotencyKey, 2),
        }),
      )
      await waitFor(() => expect(button).toHaveProperty('disabled', false))
      expect(screen.queryByRole('status')).toBeNull()
      expect(screen.getAllByRole('cell', { name: 'Completed' })).toHaveLength(2)
      await act(async () => loseSecondResponse(new api.ApiResponseError('Late lost response', 503)))
      expect(screen.queryByRole('alert')).toBeNull()
      expect(invokeSurfaceAction).toHaveBeenCalledTimes(2)
    } finally {
      runtime.stop()
    }
  },
)
