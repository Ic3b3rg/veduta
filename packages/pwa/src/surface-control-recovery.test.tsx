// @vitest-environment jsdom
import { fromPartial } from '@total-typescript/shoehorn'
import { FastActionInvocationSchema, SurfaceSchema, type SurfaceSnapshot } from '@veduta/protocol'
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
  id: 'srf-control-recovery',
  spaceId: 'spc-test',
  title: 'Records',
  tree: {
    id: 'root',
    type: 'Box',
    children: [
      {
        id: 'record-button',
        type: 'Button',
        props: { label: 'Record entry' },
        actions: [
          {
            name: 'press',
            path: 'fast',
            revision: 'acr-record-button',
            plan: {
              inputs: {},
              targets: {
                records: {
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
                  target: 'records',
                  value: {
                    source: 'object',
                    fields: {
                      id: { source: 'metadata', name: 'recordId' },
                      label: { source: 'literal', value: 'A' },
                    },
                  },
                },
              ],
            },
          },
        ],
      },
      { id: 'records', type: 'Table', binding: 'records', props: { columns: ['label'] } },
    ],
  },
  state: { records: [] },
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

it('recovers an unbound Button from its canonical receipt and accepts a fresh identical click', async () => {
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
  const response = deferred<api.SurfaceActionResponse>()
  const invokeSurfaceAction = vi
    .fn<typeof api.invokeSurfaceAction>()
    .mockRejectedValueOnce(new api.ApiResponseError('Gateway unavailable. Try again.', 503))
    .mockReturnValueOnce(response.promise)
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
    const gateway = connections[0]
    if (!gateway) throw new Error('Gateway connection unavailable')
    await act(async () => gateway.onHello(0, 'client-control'))
    render(<RecoveryCard runtime={runtime} />)
    const button = screen.getByRole('button', { name: 'Record entry' })
    fireEvent.click(button)

    const error = await screen.findByRole('alert')
    expect(error.textContent).toBe('Gateway unavailable. Try again.')
    expect(error.id).not.toBe('')
    expect(button.getAttribute('aria-describedby')?.split(/\s+/)).toContain(error.id)
    expect(button.getAttribute('aria-invalid')).toBe('true')
    expect(button).toHaveProperty('disabled', false)
    expect(button.getAttribute('aria-busy')).not.toBe('true')
    expect(screen.queryAllByRole('cell', { name: 'A' })).toHaveLength(0)
    expect(runtime.getSnapshot().queuedFastActions).toHaveLength(1)
    const original = FastActionInvocationSchema.parse(invokeSurfaceAction.mock.calls[0]?.[1])
    expect(original.inputs).toEqual({})

    const firstRecord = { id: 'record-one', label: 'A' }
    const first = committedActionOutcome(
      original,
      { ...before, state: { records: [firstRecord] } },
      {
        surfaceId: before.id,
        operations: [{ target: 'state', op: 'replace', path: '/records', value: [firstRecord] }],
      },
      1,
    )
    const { surface: _firstSurface, patch: firstPatch, ...firstMetadata } = first
    await act(async () =>
      gateway.onSurfacePatch({
        cursor: 1,
        at: '2026-10-01T08:00:01Z',
        spaceId: before.spaceId,
        patch: firstPatch,
        actionOutcome: firstMetadata,
        freshness: first.surface.freshness,
      }),
    )

    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
    expect(button.getAttribute('aria-invalid')).not.toBe('true')
    expect(button).toHaveProperty('disabled', false)
    expect(button.getAttribute('aria-busy')).not.toBe('true')
    expect(screen.getAllByRole('cell', { name: 'A' })).toHaveLength(1)
    expect(runtime.getSnapshot().queuedFastActions).toHaveLength(0)

    fireEvent.click(button)
    expect(invokeSurfaceAction).toHaveBeenCalledTimes(2)
    const fresh = FastActionInvocationSchema.parse(invokeSurfaceAction.mock.calls[1]?.[1])
    expect(fresh.intentId).not.toBe(original.intentId)
    expect(fresh.inputs).toEqual({})
    expect(button).toHaveProperty('disabled', true)
    expect(button.getAttribute('aria-busy')).toBe('true')
    expect(screen.getAllByRole('cell', { name: 'A' })).toHaveLength(1)

    const secondRecord = { id: 'record-two', label: 'A' }
    const second = committedActionOutcome(
      fresh,
      { ...before, state: { records: [firstRecord, secondRecord] } },
      {
        surfaceId: before.id,
        operations: [
          {
            target: 'state',
            op: 'replace',
            path: '/records',
            value: [firstRecord, secondRecord],
          },
        ],
      },
      2,
    )
    const { surface: _secondSurface, patch: secondPatch, ...secondMetadata } = second
    await act(async () =>
      gateway.onSurfacePatch({
        cursor: 2,
        at: '2026-10-01T08:00:02Z',
        spaceId: before.spaceId,
        patch: secondPatch,
        actionOutcome: secondMetadata,
        freshness: second.surface.freshness,
      }),
    )
    await act(async () => response.resolve(second))

    expect(screen.queryByRole('alert')).toBeNull()
    expect(button).toHaveProperty('disabled', false)
    expect(button.getAttribute('aria-busy')).not.toBe('true')
    expect(screen.getAllByRole('cell', { name: 'A' })).toHaveLength(2)
    expect(runtime.getSnapshot().queuedFastActions).toHaveLength(0)
    expect(invokeSurfaceAction).toHaveBeenCalledTimes(2)
  } finally {
    runtime.stop()
  }
})

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
