// @vitest-environment jsdom
import { renderNode } from '@veduta/catalog'
import { fromPartial } from '@total-typescript/shoehorn'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchSpaces, pinSurface, invokeSurfaceAction } from './surface-api.ts'
import { connectGateway, type GatewayHandlers } from './gateway-client.ts'
import { applySurfacePatchToSpaces, cachedSnapshot, saveSnapshot } from './home-state.ts'
import { createPwaLiveStateRuntime } from './pwa-live-state-runtime.ts'

const at = '2026-10-01T08:00:00Z'

function futureSnapshot() {
  return {
    surfaceCursor: 1,
    spaces: [
      {
        id: 'spc-test',
        slug: 'test',
        name: 'Test',
        surfaces: [
          {
            id: 'srf-future',
            spaceId: 'spc-test',
            title: 'Future composition',
            freshness: { updatedAt: at, updatedBy: 'agent' },
            tree: {
              id: 'root',
              type: 'Box',
              children: [
                {
                  id: 'future-gauge',
                  type: 'FutureGauge',
                  props: { reading: 74 },
                  binding: { source: 'future' },
                  actions: { futureVerb: 'record' },
                  children: [{ id: 'known-child', type: 'Text', binding: 'detail' }],
                },
                { id: 'known-sibling', type: 'Stat', props: { label: 'Recorded', value: 74 } },
              ],
            },
            state: { detail: 'Known descendant remains visible' },
          },
        ],
      },
    ],
  }
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('Surface wire compatibility', () => {
  it('renders a future Atom from an HTTP snapshot while preserving known content', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(futureSnapshot()))),
    )
    const snapshot = await fetchSpaces()
    const surface = snapshot.spaces[0]?.surfaces[0]
    if (!surface) throw new Error('expected the received Surface')
    render(renderNode(surface.tree, { state: surface.state, dispatch: vi.fn() }))

    expect(screen.getByTestId('unknown-atom').textContent).toContain('FutureGauge')
    expect(screen.getByTestId('unknown-atom').textContent).toContain('future-gauge')
    expect(screen.getByText('Known descendant remains visible')).toBeTruthy()
    expect(screen.getByText('74')).toBeTruthy()
  })

  it('renders a future Atom delivered as a serialized live Gateway creation', () => {
    const socket = fromPartial<WebSocket>({ close: vi.fn() })
    vi.stubGlobal('location', { protocol: 'http:', host: 'localhost:5173' })
    vi.stubGlobal(
      'WebSocket',
      vi.fn(() => socket),
    )
    const onError = vi.fn()
    connectGateway(
      fromPartial<GatewayHandlers>({
        surfaceCursor: 0,
        onError,
        onSurfaceCreated: (frame: Parameters<GatewayHandlers['onSurfaceCreated']>[0]) =>
          render(
            renderNode(frame.event.surface.tree, {
              state: frame.event.surface.state,
              dispatch: vi.fn(),
            }),
          ),
      }),
    )
    socket.onmessage?.call(
      socket,
      fromPartial<MessageEvent>({
        data: JSON.stringify({
          type: 'surface.created',
          event: {
            cursor: 1,
            at,
            spaceId: 'spc-test',
            surface: futureSnapshot().spaces[0]?.surfaces[0],
            order: {
              cursor: 1,
              spaceId: 'spc-test',
              pinnedSurfaceIds: [],
              regularSurfaceIds: ['srf-future'],
            },
          },
        }),
      }),
    )

    expect(screen.getByTestId('unknown-atom').textContent).toContain('FutureGauge')
    expect(screen.getByText('Known descendant remains visible')).toBeTruthy()
    expect(onError).not.toHaveBeenCalled()
  })

  it('preserves a received future Atom through the confirmed cache and a fresh read', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(futureSnapshot()))),
    )
    const received = await fetchSpaces()
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
    saveSnapshot(storage, 'confirmed', received)
    const surface = cachedSnapshot(storage, 'confirmed')?.spaces[0]?.surfaces[0]
    if (!surface) throw new Error('expected the confirmed cached Surface')
    render(renderNode(surface.tree, { state: surface.state, dispatch: vi.fn() }))

    expect(screen.getByTestId('unknown-atom').textContent).toContain('FutureGauge')
    expect(screen.getByText('Known descendant remains visible')).toBeTruthy()
  })

  it('replays a serialized state patch without losing an unchanged future Atom', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(futureSnapshot()))),
    )
    const received = await fetchSpaces()
    const socket = fromPartial<WebSocket>({ close: vi.fn() })
    vi.stubGlobal('location', { protocol: 'http:', host: 'localhost:5173' })
    vi.stubGlobal(
      'WebSocket',
      vi.fn(() => socket),
    )
    connectGateway(
      fromPartial<GatewayHandlers>({
        surfaceCursor: 1,
        onSurfacePatch: (event: Parameters<GatewayHandlers['onSurfacePatch']>[0]) => {
          const surface = applySurfacePatchToSpaces(received.spaces, event).spaces[0]?.surfaces[0]
          if (!surface) throw new Error('expected the replayed Surface')
          render(renderNode(surface.tree, { state: surface.state, dispatch: vi.fn() }))
        },
      }),
    )
    socket.onmessage?.call(
      socket,
      fromPartial<MessageEvent>({
        data: JSON.stringify({
          type: 'surface.patch',
          event: {
            cursor: 2,
            at,
            spaceId: 'spc-test',
            freshness: { updatedAt: at, updatedBy: 'agent' },
            patch: {
              surfaceId: 'srf-future',
              operations: [
                { target: 'state', op: 'replace', path: '/detail', value: 'Live known content' },
              ],
            },
          },
        }),
      }),
    )

    expect(screen.getByTestId('unknown-atom').textContent).toContain('FutureGauge')
    expect(screen.getByText('Live known content')).toBeTruthy()
  })
  it('projects a future HTTP Atom through the running PWA and refuses its undeclared action', async () => {
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
    const fetch = vi.fn(async (path: string) => {
      if (path === '/api/auth/status')
        return new Response(
          JSON.stringify({
            mode: 'dev',
            bootstrapRequired: false,
            passkeyRegistered: false,
          }),
        )
      if (path === '/api/spaces') return new Response(JSON.stringify(futureSnapshot()))
      throw new Error(`unexpected HTTP request ${path}`)
    })
    vi.stubGlobal('fetch', fetch)
    const socket = fromPartial<WebSocket>({ close: vi.fn() })
    vi.stubGlobal(
      'WebSocket',
      vi.fn(() => socket),
    )
    const runtime = createPwaLiveStateRuntime({ storage })
    try {
      await runtime.start()
      const surface = runtime.getSnapshot().spaces[0]?.surfaces[0]
      if (!surface)
        throw new Error(`expected the projected Surface: ${runtime.getSnapshot().error}`)
      render(renderNode(surface.tree, { state: surface.state, dispatch: vi.fn() }))
      expect(screen.getByTestId('unknown-atom').textContent).toContain('FutureGauge')
      expect(screen.getByText('Known descendant remains visible')).toBeTruthy()
      expect(runtime.getSnapshot().error).toBeNull()
      await runtime.dispatchSurfaceAction(surface.id, 'future-gauge', 'record', 80)
      expect(runtime.getSnapshot().error).toContain('undeclared action')
      expect(fetch).toHaveBeenCalledTimes(2)
      expect(values.get('veduta.homeSnapshot')).toContain('FutureGauge')
    } finally {
      runtime.stop()
    }
  })

  it('reads future compositions from HTTP action and Pin confirmations', async () => {
    const surface = futureSnapshot().spaces[0]?.surfaces[0]
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async (path: string) =>
          new Response(
            JSON.stringify(
              path.endsWith('/pin')
                ? {
                    changed: true,
                    surface: { ...surface, pinned: true },
                    order: {
                      cursor: 2,
                      spaceId: 'spc-test',
                      pinnedSurfaceIds: ['srf-future'],
                      regularSurfaceIds: [],
                    },
                  }
                : { surface, surfaceCursor: 2 },
            ),
          ),
      ),
    )
    expect((await pinSurface('srf-future', true)).surface.tree.children?.[0]?.type).toBe(
      'FutureGauge',
    )
    const action = await invokeSurfaceAction('srf-future', 'known-child', 'record')
    expect('surface' in action && action.surface.tree.children?.[0]?.type).toBe('FutureGauge')
  })

  it('replays buffered serialized tree and state patches, then restores the confirmed cache offline', async () => {
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
    let syncing = false
    let offline = false
    let finishSnapshot: ((response: Response) => void) | undefined
    vi.stubGlobal(
      'fetch',
      vi.fn(async (path: string) => {
        if (path === '/api/auth/status')
          return new Response(
            JSON.stringify({
              mode: 'dev',
              bootstrapRequired: false,
              passkeyRegistered: false,
            }),
          )
        if (path === '/api/pending-decisions')
          return new Response(JSON.stringify({ revision: 0, decisions: [] }))
        if (path === '/api/spaces') {
          if (offline) throw new Error('offline')
          if (syncing)
            return new Promise<Response>((resolve) => {
              finishSnapshot = resolve
            })
          return new Response(JSON.stringify(futureSnapshot()))
        }
        throw new Error(`unexpected HTTP request ${path}`)
      }),
    )
    const socket = fromPartial<WebSocket>({ close: vi.fn() })
    vi.stubGlobal(
      'WebSocket',
      vi.fn(() => socket),
    )
    const runtime = createPwaLiveStateRuntime({ storage })
    try {
      await runtime.start()
      syncing = true
      const receive = (frame: unknown) =>
        socket.onmessage?.call(socket, fromPartial<MessageEvent>({ data: JSON.stringify(frame) }))
      receive({ type: 'hello', clientId: 'client-test', surfaceCursor: 1, replayed: 0 })
      const original = futureSnapshot().spaces[0]?.surfaces[0]?.tree.children[0]
      receive({
        type: 'surface.patch',
        event: {
          cursor: 2,
          at,
          spaceId: 'spc-test',
          freshness: { updatedAt: at, updatedBy: 'agent' },
          patch: {
            surfaceId: 'srf-future',
            operations: [
              {
                target: 'tree',
                op: 'replace',
                path: '/children/0',
                value: { ...original, props: { reading: 80 }, futureRevision: 2 },
              },
            ],
          },
        },
      })
      receive({
        type: 'surface.patch',
        event: {
          cursor: 3,
          at,
          spaceId: 'spc-test',
          freshness: { updatedAt: at, updatedBy: 'agent' },
          patch: {
            surfaceId: 'srf-future',
            operations: [
              {
                target: 'state',
                op: 'replace',
                path: '/detail',
                value: 'Confirmed after reconnect',
              },
            ],
          },
        },
      })
      await vi.waitFor(() => expect(finishSnapshot).toBeTypeOf('function'))
      finishSnapshot?.(new Response(JSON.stringify(futureSnapshot())))
      await vi.waitFor(() => expect(runtime.getSnapshot().surfaceCursor).toBe(3))
      expect(runtime.getSnapshot().error).toBeNull()
      expect(runtime.getSnapshot().spaces[0]?.surfaces[0]?.tree.children?.[0]).toMatchObject({
        type: 'FutureGauge',
        props: { reading: 80 },
        futureRevision: 2,
      })
      expect(values.get('veduta.homeSnapshot')).toContain('Confirmed after reconnect')
    } finally {
      runtime.stop()
    }
    offline = true
    const remounted = createPwaLiveStateRuntime({ storage })
    try {
      await remounted.start()
      const surface = remounted.getSnapshot().spaces[0]?.surfaces[0]
      if (!surface) throw new Error('expected the restored Surface')
      render(renderNode(surface.tree, { state: surface.state, dispatch: vi.fn() }))
      expect(screen.getByTestId('unknown-atom').textContent).toContain('FutureGauge')
      expect(screen.getByText('Confirmed after reconnect')).toBeTruthy()
      expect(screen.getByText('74')).toBeTruthy()
      expect(remounted.getSnapshot().surfaceCursor).toBe(3)
    } finally {
      remounted.stop()
    }
  })
})
