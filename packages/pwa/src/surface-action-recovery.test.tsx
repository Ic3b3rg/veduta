// @vitest-environment jsdom
import { fromPartial } from '@total-typescript/shoehorn'
import { SurfaceSchema, type SurfaceSnapshot } from '@veduta/protocol'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useSyncExternalStore } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import * as api from './api.ts'
import { committedActionOutcome } from './action-test-support.ts'
import type { GatewayHandlers } from './gateway-client.ts'
import { createPwaLiveStateRuntime, type PwaLiveStateRuntime } from './pwa-live-state-runtime.ts'
import { SurfaceCard } from './surface-card.tsx'
import { PwaRuntimeContext } from './use-live-state.ts'

const before = SurfaceSchema.parse({
  id: 'srf-recovery',
  spaceId: 'spc-test',
  title: 'Items',
  tree: {
    id: 'root',
    type: 'Box',
    children: [
      {
        id: 'form',
        type: 'Form',
        props: { label: 'Add item', submitLabel: 'Add' },
        children: [{ id: 'note', type: 'Input', binding: 'note', props: { label: 'Item' } }],
        actions: [
          {
            name: 'submit',
            path: 'fast',
            revision: 'acr-recovery',
            plan: {
              inputs: { note: { type: 'string' } },
              targets: {
                note: { type: 'string' },
                items: {
                  type: 'array',
                  items: {
                    type: 'object',
                    identityKey: 'id',
                    fields: { id: { type: 'string' }, label: { type: 'string' } },
                  },
                },
              },
              steps: [
                {
                  op: 'append',
                  target: 'items',
                  value: {
                    source: 'object',
                    fields: {
                      id: { source: 'metadata', name: 'recordId' },
                      label: { source: 'input', name: 'note' },
                    },
                  },
                },
                { op: 'clear', target: 'note', value: '' },
              ],
            },
          },
        ],
      },
      { id: 'items', type: 'Table', binding: 'items', props: { columns: ['label'] } },
    ],
  },
  state: { note: '', items: [] },
  freshness: { updatedAt: '2026-10-01T08:00:00Z', updatedBy: 'user' },
})

function RecoveryCard({ runtime }: { runtime: PwaLiveStateRuntime }) {
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

it('clears a matching failed Form after automatic confirmation and lets a new identical draft create a new intent', async () => {
  const values = new Map<string, string>()
  const connections: GatewayHandlers[] = []
  const storage = fromPartial<Storage>({
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value)
    },
    removeItem: (key: string) => {
      values.delete(key)
    },
  })
  const snapshot: SurfaceSnapshot = fromPartial({
    surfaceCursor: 0,
    spaces: [
      {
        id: before.spaceId,
        slug: 'test',
        name: 'Test',
        archived: false,
        attention: 0,
        attentionRevision: 0,
        surfaces: [before],
      },
    ],
  })
  const first = { id: 'record-one', label: 'A' }
  const second = { id: 'record-two', label: 'A' }
  const invokeSurfaceAction = vi
    .fn<typeof api.invokeSurfaceAction>()
    .mockRejectedValueOnce(new api.ApiResponseError('The response was lost.', 503))
    .mockImplementationOnce(async (_id, invocation) =>
      committedActionOutcome(
        invocation,
        { ...before, state: { note: '', items: [first] } },
        {
          surfaceId: before.id,
          operations: [
            { target: 'state', op: 'replace', path: '/items', value: [first] },
            { target: 'state', op: 'replace', path: '/note', value: '' },
          ],
        },
        1,
      ),
    )
    .mockImplementationOnce(async (_id, invocation) =>
      committedActionOutcome(
        invocation,
        { ...before, state: { note: '', items: [first, second] } },
        {
          surfaceId: before.id,
          operations: [
            { target: 'state', op: 'replace', path: '/items', value: [first, second] },
            { target: 'state', op: 'replace', path: '/note', value: '' },
          ],
        },
        2,
      ),
    )
  const runtime = createPwaLiveStateRuntime({
    storage,
    api: {
      ...api,
      invokeSurfaceAction,
      fetchAuthStatus: vi.fn(async () => ({
        mode: 'dev' as const,
        bootstrapRequired: false,
        passkeyRegistered: false,
      })),
      fetchSpaces: vi.fn(async () => snapshot),
      fetchPendingDecisions: vi.fn(async () => ({ revision: 0, decisions: [] })),
      fetchAutomationOutcomeNotifications: vi.fn(async () => ({ revision: 0, notifications: [] })),
      connectGateway: (handlers) => {
        connections.push(handlers)
        return { sendChat: () => true, close: () => {} }
      },
    },
  })
  try {
    await runtime.start()
    connections[0]!.onHello(0, 'client-form')
    render(<RecoveryCard runtime={runtime} />)
    const input = screen.getByRole('textbox', { name: 'Item' })
    fireEvent.change(input, { target: { value: 'A' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    expect((await screen.findByRole('alert')).textContent).toBe('The response was lost.')
    expect(input).toHaveProperty('value', 'A')
    await act(async () => runtime.retry())
    await waitFor(() => expect(connections).toHaveLength(2))
    await act(async () => connections[1]!.onHello(0, 'client-form'))
    await waitFor(() => expect(runtime.getSnapshot().queuedFastActions).toHaveLength(0))
    expect(screen.queryByRole('alert')).toBeNull()
    expect(input).toHaveProperty('value', '')
    expect(invokeSurfaceAction.mock.calls[0]![1]).toEqual(invokeSurfaceAction.mock.calls[1]![1])
    fireEvent.change(input, { target: { value: 'A' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    await waitFor(() => expect(invokeSurfaceAction).toHaveBeenCalledTimes(3))
    const original = invokeSurfaceAction.mock.calls[0]![1]
    const fresh = invokeSurfaceAction.mock.calls[2]![1]
    expect(fresh).not.toEqual(original)
    await waitFor(() => expect(screen.getAllByRole('cell', { name: 'A' })).toHaveLength(2))
  } finally {
    runtime.stop()
  }
})
