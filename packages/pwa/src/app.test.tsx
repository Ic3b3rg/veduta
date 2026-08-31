// @vitest-environment jsdom
//
// Focused app-level integration tests for behavior that crosses App's
// networking, routing, and live-state seams. Lower-level helpers keep their
// exhaustive coverage in their own colocated tests.
import {
  PENDING_DECISION_FALLBACK_FEEDBACK,
  SurfaceArchivedEventSchema,
  SurfaceCreatedEventSchema,
  SurfaceMovedEventSchema,
  SurfacePatchEventSchema,
  type FastSurfaceActionResult,
  type ModelConnectionsSnapshot,
  type OnboardingStatus,
  type PendingDecision,
  type PendingDecisionList,
  type Surface,
} from '@veduta/protocol'
import { fromPartial } from '@total-typescript/shoehorn'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ApiModule from './api.ts'
import {
  appTestSurface as appSurface,
  authStatus,
  connectedModelConnectionsSnapshot,
  installAppTestBrowser,
  resetAppTestBrowser,
} from './app-test-support.ts'
import type { MotionAnimationCall } from './motion-test-browser.ts'
import { AUTH_TOKEN_KEY, HOME_CACHE_KEY, SURFACE_ORDER_KEY } from './pwa-storage.ts'

let scrollIntoView: ReturnType<typeof vi.fn>
let atomAnimations: MotionAnimationCall[]

vi.mock('./api.ts', async (importOriginal) => {
  const { createAppApiMock } = await import('./app-test-support.ts')
  return createAppApiMock(await importOriginal<typeof ApiModule>())
})

import { App } from './app.tsx'
import {
  ApiResponseError,
  connectGateway,
  fetchAuthStatus,
  fetchModelConnections,
  fetchOnboardingStatus,
  fetchPendingDecisions,
  fetchSpaces,
  invokeFastAction,
  moveSurface,
  resolvePendingDecision,
} from './api.ts'

// jsdom has no matchMedia implementation; `pwa-storage.ts#isStandalone` (read
// at mount to decide whether to show the install guide) calls it
// unconditionally.
beforeEach(() => {
  const browser = installAppTestBrowser()
  atomAnimations = browser.atomAnimations
  scrollIntoView = browser.scrollIntoView
})

afterEach(resetAppTestBrowser)

const CHATGPT_CONNECTION_ID = 'c0ffee00-0000-4000-8000-000000000073'
const CHATGPT_MODEL_ID = 'gpt-5-codex'

function connectedChatgptSubscriptionSnapshot(): ModelConnectionsSnapshot {
  return {
    vaultAvailable: true,
    mockEnabled: false,
    mockControlAvailable: false,
    methods: [
      {
        id: 'chatgpt-codex',
        provider: 'openai',
        providerDisplayName: 'OpenAI',
        methodDisplayName: 'ChatGPT subscription',
        capabilities: {
          authorization: 'device-code',
          refresh: 'automatic',
          revocation: 'provider',
          metered: false,
        },
        primaryRoutable: true,
        available: true,
      },
    ],
    connections: [
      {
        id: CHATGPT_CONNECTION_ID,
        method: 'chatgpt-codex',
        provider: 'openai',
        label: 'OpenAI · ChatGPT subscription',
        state: 'connected',
        stateAt: '2026-08-11T09:00:00.000Z',
        enabledForFallback: false,
        createdAt: '2026-08-11T09:00:00.000Z',
        selectedModelId: CHATGPT_MODEL_ID,
        catalog: [{ id: CHATGPT_MODEL_ID, label: 'GPT-5 Codex', routable: true }],
      },
    ],
    selection: { connectionId: CHATGPT_CONNECTION_ID, modelId: CHATGPT_MODEL_ID },
  }
}

async function renderConnectedEmptyHealth(clientId: string) {
  vi.mocked(fetchAuthStatus).mockResolvedValue(authStatus({ mode: 'dev' }))
  vi.mocked(fetchSpaces).mockResolvedValue({
    surfaceCursor: 0,
    spaces: [
      {
        id: 'spc-health',
        slug: 'health',
        name: 'Health',
        archived: false,
        attention: 0,
        attentionRevision: 0,
        surfaces: [],
      },
    ],
  })
  vi.mocked(fetchOnboardingStatus).mockResolvedValue(
    fromPartial<OnboardingStatus>({ required: false, completed: true }),
  )
  vi.mocked(fetchPendingDecisions).mockResolvedValue({ revision: 0, decisions: [] })
  vi.mocked(fetchModelConnections).mockResolvedValue(connectedModelConnectionsSnapshot())

  render(<App />)
  await waitFor(() => expect(connectGateway).toHaveBeenCalledOnce())
  const handlers = vi.mocked(connectGateway).mock.calls[0]?.[0]
  if (!handlers) throw new Error('Gateway handlers were not registered')
  await act(async () => handlers.onHello(0, clientId))
  return handlers
}

describe('App', () => {
  it('offers keyboard users a direct path to the Home content', async () => {
    await renderConnectedEmptyHealth('pwa-skip-link')

    const skipLink = screen.getByRole('link', { name: 'Skip to Home content' })
    const home = screen.getByRole('main', { name: 'Home' })

    expect(skipLink.getAttribute('href')).toBe('#main-content')
    expect(home.id).toBe('main-content')
  })

  it('renders the canonical Gateway snapshot and removes obsolete browser-local Surface order', async () => {
    window.history.replaceState({}, '', '/app/space/health')
    localStorage.setItem(
      SURFACE_ORDER_KEY,
      JSON.stringify({ 'spc-health': ['srf-second', 'srf-first'] }),
    )
    vi.mocked(fetchAuthStatus).mockResolvedValue(authStatus({ mode: 'dev' }))
    vi.mocked(fetchSpaces).mockResolvedValue({
      surfaceCursor: 4,
      spaces: [
        {
          id: 'spc-health',
          slug: 'health',
          name: 'Health',
          archived: false,
          attention: 0,
          attentionRevision: 0,
          surfaces: [
            {
              id: 'srf-first',
              spaceId: 'spc-health',
              title: 'Gateway first',
              tree: { id: 'root', type: 'Box' },
              state: {},
              freshness: { updatedAt: '2026-08-16T10:00:00.000Z', updatedBy: 'agent' },
              pinned: true,
              pinnable: true,
            },
            {
              id: 'srf-second',
              spaceId: 'spc-health',
              title: 'Gateway second',
              tree: { id: 'root', type: 'Box' },
              state: {},
              freshness: { updatedAt: '2026-08-16T10:00:00.000Z', updatedBy: 'agent' },
              pinned: false,
              pinnable: true,
            },
          ],
        },
      ],
    })
    vi.mocked(fetchOnboardingStatus).mockResolvedValue(
      fromPartial<OnboardingStatus>({ required: false, completed: true }),
    )
    vi.mocked(fetchModelConnections).mockResolvedValue(connectedModelConnectionsSnapshot())

    render(<App />)

    const surfaces = await screen.findAllByRole('article', { name: /^Gateway .* Surface$/ })
    expect(surfaces.map((surface) => surface.getAttribute('aria-label'))).toEqual([
      'Gateway first Surface',
      'Gateway second Surface',
    ])
    expect(screen.queryByRole('button', { name: /^Focus Gateway/ })).toBeNull()
    expect(localStorage.getItem(SURFACE_ORDER_KEY)).toBeNull()
  })

  it('does not let a stale Move HTTP response overwrite a newer live order', async () => {
    window.history.replaceState({}, '', '/app/space/health')
    vi.mocked(fetchAuthStatus).mockResolvedValue(authStatus({ mode: 'dev' }))
    vi.mocked(fetchSpaces).mockResolvedValue({
      surfaceCursor: 10,
      spaces: [
        {
          id: 'spc-health',
          slug: 'health',
          name: 'Health',
          archived: false,
          attention: 0,
          attentionRevision: 0,
          surfaces: [
            appSurface('srf-first', 'Gateway first'),
            appSurface('srf-second', 'Gateway second'),
          ],
        },
      ],
    })
    vi.mocked(fetchOnboardingStatus).mockResolvedValue(
      fromPartial<OnboardingStatus>({ required: false, completed: true }),
    )
    vi.mocked(fetchModelConnections).mockResolvedValue(connectedModelConnectionsSnapshot())
    let resolveMove: ((value: Awaited<ReturnType<typeof moveSurface>>) => void) | undefined
    vi.mocked(moveSurface).mockReturnValue(
      new Promise((resolve) => {
        resolveMove = resolve
      }),
    )

    render(<App />)
    await waitFor(() => expect(connectGateway).toHaveBeenCalledOnce())
    fireEvent.click(await screen.findByRole('button', { name: 'Move Gateway first down' }))
    const handlers = vi.mocked(connectGateway).mock.calls[0]?.[0]
    if (!handlers) throw new Error('Gateway handlers were not registered')

    act(() => {
      handlers.onSurfaceMoved(
        SurfaceMovedEventSchema.parse({
          cursor: 12,
          at: '2026-08-16T10:02:00.000Z',
          spaceId: 'spc-health',
          surfaceId: 'srf-first',
          direction: 'up',
          order: {
            cursor: 12,
            spaceId: 'spc-health',
            pinnedSurfaceIds: [],
            regularSurfaceIds: ['srf-first', 'srf-second'],
          },
        }),
      )
    })
    await act(async () => {
      resolveMove?.({
        changed: true,
        order: {
          cursor: 11,
          spaceId: 'spc-health',
          pinnedSurfaceIds: [],
          regularSurfaceIds: ['srf-second', 'srf-first'],
        },
      })
      await Promise.resolve()
    })

    expect(
      screen
        .getAllByRole('article', { name: /^Gateway .* Surface$/ })
        .map((surface) => surface.getAttribute('aria-label')),
    ).toEqual(['Gateway first Surface', 'Gateway second Surface'])
  })

  it('renders a selected-subscription Surface, streamed confirmation, and follow-up patch live', async () => {
    window.history.replaceState({}, '', '/app/space/health')
    vi.mocked(fetchAuthStatus).mockResolvedValue(authStatus({ mode: 'dev' }))
    vi.mocked(fetchSpaces).mockResolvedValue({
      surfaceCursor: 0,
      spaces: [
        {
          id: 'spc-health',
          slug: 'health',
          name: 'Health',
          archived: false,
          attention: 0,
          attentionRevision: 0,
          surfaces: [],
        },
      ],
    })
    vi.mocked(fetchOnboardingStatus).mockResolvedValue(
      fromPartial<OnboardingStatus>({ required: false, completed: true }),
    )
    vi.mocked(fetchModelConnections).mockResolvedValue(connectedChatgptSubscriptionSnapshot())

    render(<App />)

    await waitFor(() => expect(connectGateway).toHaveBeenCalledOnce())
    const connectionSelect = await screen.findByRole<HTMLSelectElement>('combobox', {
      name: 'Connection',
    })
    const modelSelect = screen.getByRole<HTMLSelectElement>('combobox', { name: 'Model' })
    expect(connectionSelect.value).toBe(CHATGPT_CONNECTION_ID)
    expect(modelSelect.value).toBe(CHATGPT_MODEL_ID)
    const handlers = vi.mocked(connectGateway).mock.calls[0]?.[0]
    if (!handlers) throw new Error('Gateway handlers were not registered')

    const created = SurfaceCreatedEventSchema.parse({
      cursor: 1,
      at: '2026-08-11T10:00:00.000Z',
      spaceId: 'spc-health',
      surface: {
        id: 'srf-hydration',
        spaceId: 'spc-health',
        title: 'Hydration',
        tree: {
          id: 'root',
          type: 'Box',
          children: [
            { id: 'title', type: 'Title', props: { text: 'Hydration' } },
            { id: 'status', type: 'Stat', binding: 'status', props: { label: 'Status' } },
          ],
        },
        state: { status: 'Needs water' },
        freshness: { updatedAt: '2026-08-11T10:00:00.000Z', updatedBy: 'agent' },
        pinned: false,
        pinnable: true,
      },
      order: createdOrder(1, 'srf-hydration'),
    })

    act(() => {
      handlers.onSurfaceCreated({ type: 'surface.created', event: created })
      handlers.onChatTurnStart({
        type: 'chat.turn-start',
        turnId: 'turn-create',
        spaceId: 'spc-health',
      })
      handlers.onChatTurnDelta({
        type: 'chat.turn-delta',
        turnId: 'turn-create',
        spaceId: 'spc-health',
        text: 'Hydration Surface created.',
      })
    })

    expect(await screen.findByRole('article', { name: 'Hydration Surface' })).toBeDefined()
    expect(screen.getByText('Needs water')).toBeDefined()
    expect(screen.getByText('Hydration Surface created.')).toBeDefined()
    atomAnimations.length = 0

    const patch = SurfacePatchEventSchema.parse({
      cursor: 2,
      at: '2026-08-11T10:01:00.000Z',
      spaceId: 'spc-health',
      patch: {
        surfaceId: 'srf-hydration',
        operations: [{ target: 'state', op: 'replace', path: '/status', value: 'On track' }],
      },
      freshness: { updatedAt: '2026-08-11T10:01:00.000Z', updatedBy: 'agent' },
    })

    act(() => {
      handlers.onChatTurnEnd({
        type: 'chat.turn-end',
        turnId: 'turn-create',
        spaceId: 'spc-health',
        message: { role: 'assistant', text: 'Hydration Surface created.' },
      })
      handlers.onSurfacePatch(patch)
    })

    expect(await screen.findByText('On track')).toBeDefined()
    expect(screen.queryByText('Needs water')).toBeNull()
    expect(screen.getByText('Hydration Surface created.')).toBeDefined()
    expect(atomAnimations.map(({ nodeId }) => nodeId)).toEqual(['status', 'status'])
    expect(atomAnimations[0]).toMatchObject({
      contentKey: null,
      targetTag: 'DIV',
      options: { duration: 720 },
    })
    expect(hasOpacityKeyframe(atomAnimations[0]!.keyframes)).toBe(false)
    expect(atomAnimations[1]).toMatchObject({
      contentKey: 'value',
      targetTag: 'DIV',
      targetText: 'On track',
      options: { duration: 240 },
    })
    expect(hasOpacityKeyframe(atomAnimations[1]!.keyframes)).toBe(true)
  })

  it('fades the content added by the exact Meals chat patch without hiding Atom containers', async () => {
    window.history.replaceState({}, '', '/app/space/health')
    vi.mocked(fetchAuthStatus).mockResolvedValue(authStatus({ mode: 'dev' }))
    vi.mocked(fetchSpaces).mockResolvedValue({
      surfaceCursor: 0,
      spaces: [
        {
          id: 'spc-health',
          slug: 'health',
          name: 'Health',
          archived: false,
          attention: 0,
          attentionRevision: 0,
          surfaces: [
            {
              id: 'srf-meals',
              spaceId: 'spc-health',
              title: 'Meals',
              tree: {
                id: 'root',
                type: 'Box',
                children: [
                  { id: 'title', type: 'Title', props: { text: 'Meals' } },
                  {
                    id: 'summary',
                    type: 'Row',
                    children: [
                      {
                        id: 'meal-count',
                        type: 'Stat',
                        binding: 'mealCount',
                        props: { label: 'Today' },
                      },
                      {
                        id: 'last-meal',
                        type: 'Stat',
                        binding: 'lastMeal',
                        props: { label: 'Last meal' },
                      },
                    ],
                  },
                  {
                    id: 'meal-table',
                    type: 'Table',
                    binding: 'meals',
                    props: { columns: ['time', 'meal'] },
                  },
                  {
                    id: 'hint',
                    type: 'Caption',
                    props: { text: 'Ask the Agent to add a meal in chat to update this Surface.' },
                  },
                ],
              },
              state: { meals: [], lastMeal: 'Nothing logged today', mealCount: 0 },
              freshness: { updatedAt: '2026-08-11T10:00:00.000Z', updatedBy: 'seed' },
              pinned: false,
              pinnable: true,
            },
          ],
        },
      ],
    })
    vi.mocked(fetchOnboardingStatus).mockResolvedValue(
      fromPartial<OnboardingStatus>({ required: false, completed: true }),
    )
    vi.mocked(fetchModelConnections).mockResolvedValue(connectedModelConnectionsSnapshot())

    render(<App />)

    expect(await screen.findByRole('article', { name: 'Meals Surface' })).toBeDefined()
    await waitFor(() => expect(connectGateway).toHaveBeenCalledOnce())
    const handlers = vi.mocked(connectGateway).mock.calls[0]?.[0]
    if (!handlers) throw new Error('Gateway handlers were not registered')
    atomAnimations.length = 0

    act(() => {
      handlers.onSurfacePatch(
        SurfacePatchEventSchema.parse({
          cursor: 1,
          at: '2026-08-11T13:00:00.000Z',
          spaceId: 'spc-health',
          patch: {
            surfaceId: 'srf-meals',
            operations: [
              {
                target: 'state',
                op: 'replace',
                path: '/meals',
                value: [{ time: '13:00', meal: 'fesa di tacchino' }],
              },
              {
                target: 'state',
                op: 'replace',
                path: '/lastMeal',
                value: 'fesa di tacchino',
              },
              { target: 'state', op: 'replace', path: '/mealCount', value: 1 },
            ],
          },
          freshness: { updatedAt: '2026-08-11T13:00:00.000Z', updatedBy: 'agent' },
        }),
      )
    })

    expect(await screen.findAllByText('fesa di tacchino')).toHaveLength(2)
    expect(screen.getAllByText('1').length).toBeGreaterThan(0)
    const contentFades = atomAnimations.filter(({ keyframes }) => hasOpacityKeyframe(keyframes))
    expect(
      contentFades.map(({ nodeId, contentKey, targetTag, targetText, options }) => ({
        nodeId,
        contentKey,
        targetTag,
        targetText,
        duration: options.duration,
      })),
    ).toEqual([
      {
        nodeId: 'meal-count',
        contentKey: 'value',
        targetTag: 'DIV',
        targetText: '1',
        duration: 240,
      },
      {
        nodeId: 'last-meal',
        contentKey: 'value',
        targetTag: 'DIV',
        targetText: 'fesa di tacchino',
        duration: 240,
      },
      {
        nodeId: 'meal-table',
        contentKey: expect.stringMatching(/^row:/),
        targetTag: 'TR',
        targetText: '13:00fesa di tacchino',
        duration: 240,
      },
    ])
    const regionFeedback = atomAnimations.filter(({ keyframes }) => !hasOpacityKeyframe(keyframes))
    expect(regionFeedback.map(({ nodeId }) => nodeId)).toEqual([
      'meal-count',
      'last-meal',
      'meal-table',
    ])
    expect(regionFeedback.every(({ options }) => options.duration === 720)).toBe(true)
    expect(regionFeedback.every(({ contentKey }) => contentKey === null)).toBe(true)
    expect(
      atomAnimations.some(({ nodeId }) => ['root', 'title', 'summary', 'hint'].includes(nodeId)),
    ).toBe(false)
  })

  it('fades an interactive Atom value on its optimistic fast-path update', async () => {
    window.history.replaceState({}, '', '/app/space/health')
    const groceries = {
      id: 'srf-groceries',
      spaceId: 'spc-health',
      title: 'Groceries',
      tree: {
        id: 'root',
        type: 'Box' as const,
        children: [
          {
            id: 'milk',
            type: 'Checkbox' as const,
            binding: 'milk',
            props: { label: 'Milk' },
            actions: [{ name: 'toggle', path: 'fast' as const, stateKey: 'milk', payload: {} }],
          },
        ],
      },
      state: { milk: false },
      freshness: { updatedAt: '2026-08-20T10:00:00.000Z', updatedBy: 'seed' as const },
      pinned: false,
      pinnable: true,
    }
    vi.mocked(fetchAuthStatus).mockResolvedValue(authStatus({ mode: 'dev' }))
    vi.mocked(fetchSpaces).mockResolvedValue({
      surfaceCursor: 0,
      spaces: [
        {
          id: 'spc-health',
          slug: 'health',
          name: 'Health',
          archived: false,
          attention: 0,
          attentionRevision: 0,
          surfaces: [groceries],
        },
      ],
    })
    vi.mocked(fetchOnboardingStatus).mockResolvedValue(
      fromPartial<OnboardingStatus>({ required: false, completed: true }),
    )
    vi.mocked(fetchModelConnections).mockResolvedValue(connectedModelConnectionsSnapshot())
    vi.mocked(invokeFastAction).mockResolvedValue({
      surface: {
        ...groceries,
        state: { milk: true },
        freshness: { updatedAt: '2026-08-20T10:00:01.000Z', updatedBy: 'user' },
      },
      surfaceCursor: 1,
    })

    render(<App />)
    const checkbox = await screen.findByRole<HTMLInputElement>('checkbox', { name: 'Milk' })
    atomAnimations.length = 0

    fireEvent.click(checkbox)

    await waitFor(() => expect(checkbox.checked).toBe(true))
    expect(
      atomAnimations.map(({ nodeId, contentKey, targetTag, options }) => ({
        nodeId,
        contentKey,
        targetTag,
        duration: options.duration,
      })),
    ).toEqual([
      { nodeId: 'milk', contentKey: null, targetTag: 'LABEL', duration: 720 },
      { nodeId: 'milk', contentKey: 'value', targetTag: 'INPUT', duration: 240 },
    ])
  })

  it.each([
    { delivery: 'HTTP before realtime', realtimeFirst: false },
    { delivery: 'realtime before HTTP', realtimeFirst: true },
  ])(
    'keeps a newer one-shot reset authoritative with $delivery delivery',
    async ({ realtimeFirst }) => {
      window.history.replaceState({}, '', '/app/space/system')
      const initial = oneShotActionSurface()
      const response = deferred<FastSurfaceActionResult>()
      const reset = {
        ...initial,
        state: { 'check.requested': false },
        freshness: { updatedAt: '2026-08-20T10:00:02.000Z', updatedBy: 'job' as const },
      }
      vi.mocked(fetchAuthStatus).mockResolvedValue(authStatus({ mode: 'dev' }))
      vi.mocked(fetchSpaces).mockResolvedValue({
        surfaceCursor: 0,
        spaces: [
          {
            id: 'spc-system',
            slug: 'system',
            name: 'System',
            archived: false,
            attention: 0,
            attentionRevision: 0,
            surfaces: [initial],
          },
        ],
      })
      vi.mocked(fetchOnboardingStatus).mockResolvedValue(
        fromPartial<OnboardingStatus>({ required: false, completed: true }),
      )
      vi.mocked(fetchModelConnections).mockResolvedValue(connectedModelConnectionsSnapshot())
      vi.mocked(invokeFastAction)
        .mockImplementationOnce(() => response.promise)
        .mockResolvedValueOnce({ surface: reset, surfaceCursor: 3 })

      render(<App />)
      const checkNow = await screen.findByRole('button', { name: 'Check now' })
      await waitFor(() => expect(connectGateway).toHaveBeenCalledOnce())
      const handlers = vi.mocked(connectGateway).mock.calls[0]?.[0]
      if (!handlers) throw new Error('Gateway handlers were not registered')

      fireEvent.click(checkNow)
      await waitFor(() => expect(invokeFastAction).toHaveBeenCalledTimes(1))
      expect(
        screen.getByRole<HTMLInputElement>('checkbox', { name: 'Check request state' }).checked,
      ).toBe(true)

      const resetEvent = SurfacePatchEventSchema.parse({
        cursor: 2,
        at: '2026-08-20T10:00:02.000Z',
        spaceId: 'spc-system',
        patch: {
          surfaceId: initial.id,
          operations: [{ target: 'state', op: 'replace', path: '/check.requested', value: false }],
        },
        freshness: reset.freshness,
      })
      const httpResult = {
        surface: {
          ...initial,
          state: { 'check.requested': true },
          freshness: { updatedAt: '2026-08-20T10:00:01.000Z', updatedBy: 'user' as const },
        },
        surfaceCursor: 1,
      }

      if (realtimeFirst) {
        act(() => handlers.onSurfacePatch(resetEvent))
        await act(async () => {
          response.resolve(httpResult)
          await response.promise
        })
      } else {
        await act(async () => {
          response.resolve(httpResult)
          await response.promise
        })
        act(() => handlers.onSurfacePatch(resetEvent))
      }

      await waitFor(() => {
        expect(
          screen.getByRole<HTMLInputElement>('checkbox', { name: 'Check request state' }).checked,
        ).toBe(false)
        expect(screen.getByText(/by job$/)).toBeDefined()
      })

      fireEvent.click(checkNow)
      await waitFor(() => expect(invokeFastAction).toHaveBeenCalledTimes(2))
      const firstKey = vi.mocked(invokeFastAction).mock.calls[0]?.[5]
      const secondKey = vi.mocked(invokeFastAction).mock.calls[1]?.[5]
      expect(firstKey).toEqual(expect.any(String))
      expect(secondKey).toEqual(expect.any(String))
      expect(secondKey).not.toBe(firstKey)
    },
  )

  it('keeps the highest per-Surface cursor after replaying an out-of-order refetch buffer', async () => {
    window.history.replaceState({}, '', '/app/space/system')
    const initial = oneShotActionSurface()
    const actionResponse = deferred<FastSurfaceActionResult>()
    const refetchSnapshot = deferred<Awaited<ReturnType<typeof fetchSpaces>>>()
    const discoveredSurface: Surface = {
      id: 'srf-discovered-during-refetch',
      spaceId: 'spc-system',
      title: 'Discovered during refetch',
      tree: { id: 'root', type: 'Box' },
      state: { status: 'snapshot' },
      freshness: { updatedAt: '2026-08-20T10:00:00.000Z', updatedBy: 'agent' },
      pinned: false,
      pinnable: true,
    }
    const initialSnapshot = {
      surfaceCursor: 0,
      spaces: [
        {
          id: 'spc-system',
          slug: 'system',
          name: 'System',
          archived: false,
          attention: 0,
          attentionRevision: 0,
          surfaces: [initial],
        },
      ],
    }
    vi.mocked(fetchAuthStatus).mockResolvedValue(authStatus({ mode: 'dev' }))
    vi.mocked(fetchSpaces)
      .mockResolvedValueOnce(initialSnapshot)
      .mockImplementationOnce(() => refetchSnapshot.promise)
    vi.mocked(fetchOnboardingStatus).mockResolvedValue(
      fromPartial<OnboardingStatus>({ required: false, completed: true }),
    )
    vi.mocked(fetchModelConnections).mockResolvedValue(connectedModelConnectionsSnapshot())
    vi.mocked(invokeFastAction).mockImplementationOnce(() => actionResponse.promise)

    render(<App />)
    const checkNow = await screen.findByRole('button', { name: 'Check now' })
    await waitFor(() => expect(connectGateway).toHaveBeenCalledOnce())
    const handlers = vi.mocked(connectGateway).mock.calls[0]?.[0]
    if (!handlers) throw new Error('Gateway handlers were not registered')

    fireEvent.click(checkNow)
    await waitFor(() => expect(invokeFastAction).toHaveBeenCalledOnce())

    act(() => {
      handlers.onSurfacePatch(
        SurfacePatchEventSchema.parse({
          cursor: 4,
          at: '2026-08-20T10:00:04.000Z',
          spaceId: 'spc-system',
          patch: {
            surfaceId: discoveredSurface.id,
            operations: [{ target: 'state', op: 'replace', path: '/status', value: 'replayed' }],
          },
          freshness: { updatedAt: '2026-08-20T10:00:04.000Z', updatedBy: 'agent' },
        }),
      )
      handlers.onSurfacePatch(
        SurfacePatchEventSchema.parse({
          cursor: 3,
          at: '2026-08-20T10:00:03.000Z',
          spaceId: 'spc-system',
          patch: {
            surfaceId: initial.id,
            operations: [
              { target: 'state', op: 'replace', path: '/check.requested', value: false },
            ],
          },
          freshness: { updatedAt: '2026-08-20T10:00:03.000Z', updatedBy: 'job' },
        }),
      )
      handlers.onSurfacePatch(
        SurfacePatchEventSchema.parse({
          cursor: 1,
          at: '2026-08-20T10:00:01.000Z',
          spaceId: 'spc-system',
          patch: {
            surfaceId: initial.id,
            operations: [{ target: 'state', op: 'replace', path: '/check.requested', value: true }],
          },
          freshness: { updatedAt: '2026-08-20T10:00:01.000Z', updatedBy: 'user' },
        }),
      )
    })
    await waitFor(() => expect(fetchSpaces).toHaveBeenCalledTimes(2))

    await act(async () => {
      refetchSnapshot.resolve({
        surfaceCursor: 0,
        spaces: [{ ...initialSnapshot.spaces[0]!, surfaces: [initial, discoveredSurface] }],
      })
      await refetchSnapshot.promise
    })
    await waitFor(() => {
      expect(
        screen.getByRole<HTMLInputElement>('checkbox', { name: 'Check request state' }).checked,
      ).toBe(false)
    })

    await act(async () => {
      actionResponse.resolve({
        surface: {
          ...initial,
          state: { 'check.requested': true },
          freshness: { updatedAt: '2026-08-20T10:00:02.000Z', updatedBy: 'user' },
        },
        surfaceCursor: 2,
      })
      await actionResponse.promise
    })

    expect(
      screen.getByRole<HTMLInputElement>('checkbox', { name: 'Check request state' }).checked,
    ).toBe(false)
    expect(screen.getByText(/by job$/)).toBeDefined()
  })

  it('centres and highlights a correlated chat-created Surface once without changing focus, route, or selection', async () => {
    window.history.replaceState({}, '', '/app/space/health')
    const handlers = await renderConnectedEmptyHealth('pwa-initiator')
    const chatInput = screen.getByRole<HTMLInputElement>('textbox', {
      name: 'Message Veduta in Health',
    })
    chatInput.focus()

    const created = SurfaceCreatedEventSchema.parse({
      cursor: 1,
      at: '2026-08-16T10:00:00.000Z',
      spaceId: 'spc-health',
      surface: {
        id: 'srf-weekly-groceries',
        spaceId: 'spc-health',
        title: 'Weekly groceries',
        tree: { id: 'root', type: 'Box', children: [] },
        state: {},
        freshness: { updatedAt: '2026-08-16T10:00:00.000Z', updatedBy: 'agent' },
      },
      order: createdOrder(1, 'srf-weekly-groceries'),
    })
    const correlatedMessage = {
      type: 'surface.created' as const,
      event: created,
      initiatingTurn: { clientId: 'pwa-initiator', turnId: 'turn-create' },
    }

    act(() => {
      handlers.onChatTurnStart({
        type: 'chat.turn-start',
        turnId: 'turn-create',
        spaceId: 'spc-health',
      })
      handlers.onSurfaceCreated(correlatedMessage)
    })

    const surfaceArticle = await screen.findByRole('article', {
      name: 'Weekly groceries Surface',
    })
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(1))
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'center' })
    expect(surfaceArticle.classList.contains('surface-reveal-highlight')).toBe(true)
    expect(surfaceArticle.getAttribute('aria-current')).toBeNull()
    expect(document.activeElement).toBe(chatInput)
    expect(location.pathname).toBe('/app/space/health')
  })

  it('reveals a pinned Tree-proposal Decision Surface once across separate live frames', async () => {
    window.history.replaceState({}, '', '/app/space/health')
    const handlers = await renderConnectedEmptyHealth('pwa-tree-proposal')
    const chatInput = screen.getByRole<HTMLInputElement>('textbox', {
      name: 'Message Veduta in Health',
    })
    chatInput.focus()
    const { created, replacement } = treeProposalRevealFixture()

    act(() => {
      handlers.onChatTurnStart({
        type: 'chat.turn-start',
        turnId: 'turn-tree-proposal',
        spaceId: 'spc-health',
      })
      handlers.onSurfaceCreated({
        type: 'surface.created',
        event: created,
        initiatingTurn: {
          clientId: 'pwa-tree-proposal',
          turnId: 'turn-tree-proposal',
        },
      })
    })

    const surfaceArticle = await screen.findByRole('article', {
      name: 'Proposed layout change: Weekly plan Surface',
    })
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(1))
    expect(location.pathname).toBe('/app/space/health')

    act(() => {
      handlers.onChatTurnReplace(replacement)
      handlers.onChatTurnReplace(replacement)
    })

    await screen.findByRole('article', { name: 'Update the weekly plan' })
    expect(location.pathname).toBe('/app/space/health')
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(1))
    expect(surfaceArticle.getAttribute('aria-current')).toBeNull()
    expect(surfaceArticle.classList.contains('pinned')).toBe(false)
    expect(surfaceArticle.classList.contains('surface-reveal-highlight')).toBe(true)
    expect(document.activeElement).toBe(chatInput)

    act(() => {
      handlers.onChatTurnEnd({
        type: 'chat.turn-end',
        turnId: 'turn-tree-proposal',
        spaceId: 'spc-health',
        message: replacement.message,
      })
    })
    expect(scrollIntoView).toHaveBeenCalledTimes(1)
  })

  it('routes Home to one exact pinned Tree-proposal Decision Surface for its live turn', async () => {
    const handlers = await renderConnectedEmptyHealth('pwa-tree-proposal-home')
    const chatInput = screen.getByRole<HTMLInputElement>('textbox', { name: 'Message Veduta' })
    chatInput.focus()
    const { surfaceId, created, replacement } = treeProposalRevealFixture()

    act(() => {
      handlers.onChatTurnStart({
        type: 'chat.turn-start',
        turnId: 'turn-tree-proposal',
        spaceId: 'spc-health',
      })
      handlers.onSurfaceCreated({
        type: 'surface.created',
        event: created,
        initiatingTurn: {
          clientId: 'pwa-tree-proposal-home',
          turnId: 'turn-tree-proposal',
        },
      })
    })
    expect(scrollIntoView).not.toHaveBeenCalled()

    act(() => handlers.onChatTurnReplace(replacement))

    await waitFor(() => expect(location.pathname).toBe(`/app/space/health/surface/${surfaceId}`))
    const surfaceArticle = await screen.findByRole('article', {
      name: 'Proposed layout change: Weekly plan Surface',
    })
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(1))
    expect(surfaceArticle.getAttribute('aria-current')).toBe('true')
    expect(document.activeElement).toBe(chatInput)
  })

  it('does not reveal a Decision Surface recovered from snapshot or lifecycle state', async () => {
    const surfaceId = 'srf-background-decision'
    const surface = appSurface(surfaceId, 'Background decision')
    const pending: PendingDecision = {
      id: 'approval:background',
      kind: 'approval',
      summary: 'Publish the background report',
      scope: { type: 'space', spaceId: 'spc-health' },
      allowedResolutions: ['approve', 'reject'],
      state: 'pending',
      decisionSurfaceId: surfaceId,
      createdAt: '2026-08-28T10:00:00.000Z',
    }
    vi.mocked(fetchAuthStatus).mockResolvedValue(authStatus({ mode: 'dev' }))
    vi.mocked(fetchSpaces).mockResolvedValue({
      surfaceCursor: 1,
      spaces: [
        {
          id: 'spc-health',
          slug: 'health',
          name: 'Health',
          archived: false,
          attention: 0,
          attentionRevision: 0,
          surfaces: [surface],
        },
      ],
    })
    vi.mocked(fetchPendingDecisions).mockResolvedValue({ revision: 1, decisions: [pending] })
    vi.mocked(fetchOnboardingStatus).mockResolvedValue(
      fromPartial<OnboardingStatus>({ required: false, completed: true }),
    )
    vi.mocked(fetchModelConnections).mockResolvedValue(connectedModelConnectionsSnapshot())

    render(<App />)
    await waitFor(() => expect(connectGateway).toHaveBeenCalledOnce())
    const handlers = vi.mocked(connectGateway).mock.calls[0]?.[0]
    if (!handlers) throw new Error('Gateway handlers were not registered')
    await act(async () => handlers.onHello(1, 'pwa-background'))

    expect(await screen.findByRole('button', { name: '1 decision awaits review' })).toBeDefined()
    expect(location.pathname).toBe('/')
    expect(scrollIntoView).not.toHaveBeenCalled()

    act(() => {
      handlers.onPendingDecisionLifecycle({
        type: 'pending-decision.lifecycle',
        revision: 2,
        decision: pending,
        message: 'Awaiting your decision: Publish the background report.',
      })
    })
    fireEvent.click(screen.getByRole('link', { name: /Health/ }))

    const surfaceArticle = await screen.findByRole('article', {
      name: 'Background decision Surface',
    })
    expect(surfaceArticle.classList.contains('surface-reveal-highlight')).toBe(false)
    expect(scrollIntoView).not.toHaveBeenCalled()
  })

  it('accepts a chat Space proposal through the common decision API without changing route', async () => {
    const handlers = await renderConnectedEmptyHealth('pwa-proposal')
    vi.mocked(resolvePendingDecision).mockResolvedValue({
      decision: {
        id: 'space-proposal:proposal-travel',
        kind: 'space-proposal',
        summary: 'Create Space “Travel”',
        scope: { type: 'global' },
        allowedResolutions: ['accept', 'reject'],
        state: 'terminal',
        outcome: 'accepted',
        createdAt: '2026-08-25T10:00:00.000Z',
        decisionAt: '2026-08-25T10:01:00.000Z',
        resolvedAt: '2026-08-25T10:01:00.000Z',
        resolvedBy: 'trusted:user',
      },
      replayed: false,
    })
    vi.mocked(fetchSpaces).mockResolvedValueOnce({
      surfaceCursor: 0,
      spaces: [
        {
          id: 'spc-health',
          slug: 'health',
          name: 'Health',
          archived: false,
          attention: 0,
          attentionRevision: 0,
          surfaces: [],
        },
        {
          id: 'spc-travel',
          slug: 'travel',
          name: 'Travel',
          archived: false,
          attention: 0,
          attentionRevision: 0,
          surfaces: [],
        },
      ],
    })

    act(() => {
      handlers.onChatTurnStart({ type: 'chat.turn-start', turnId: 'turn-proposal' })
      handlers.onChatTurnEnd({
        type: 'chat.turn-end',
        turnId: 'turn-proposal',
        message: {
          role: 'assistant',
          text: 'Travel needs its own Space.',
          pendingDecisions: [
            {
              id: 'space-proposal:proposal-travel',
              kind: 'space-proposal',
              summary: 'Create Space “Travel”',
              scope: { type: 'global' },
              allowedResolutions: ['accept', 'reject'],
              state: 'pending',
              createdAt: '2026-08-25T10:00:00.000Z',
            },
          ],
        },
      })
    })

    fireEvent.click(screen.getByRole('button', { name: 'Accept Create Space “Travel”' }))

    await waitFor(() =>
      expect(resolvePendingDecision).toHaveBeenCalledWith(
        'space-proposal:proposal-travel',
        'accept',
        undefined,
      ),
    )
    expect(await screen.findByRole('button', { name: /Travel/ })).toBeDefined()
    expect(screen.getAllByText('Accepted: Create Space “Travel”.')).toHaveLength(2)
    expect(screen.queryByRole('button', { name: 'Accept Create Space “Travel”' })).toBeNull()
    expect(location.pathname).toBe('/')
  })

  it('places Pending decisions globally and only in the Space proven by their Decision Surface', async () => {
    const handlers = await renderConnectedEmptyHealth('pwa-placement')
    const decisionSurface = SurfaceCreatedEventSchema.parse({
      cursor: 1,
      at: '2026-08-25T10:00:00.000Z',
      spaceId: 'spc-health',
      surface: {
        ...appSurface('srf-decision-health', 'Review hydration change'),
        pinned: true,
      },
      order: {
        cursor: 1,
        spaceId: 'spc-health',
        pinnedSurfaceIds: ['srf-decision-health'],
        regularSurfaceIds: [],
      },
    })
    const assigned: PendingDecision = {
      id: 'tree-proposal:hydration-change',
      kind: 'tree-proposal',
      summary: 'Update the hydration tracker',
      scope: { type: 'space', spaceId: 'spc-health' },
      allowedResolutions: ['accept', 'reject'],
      state: 'pending',
      decisionSurfaceId: 'srf-decision-health',
      createdAt: '2026-08-25T10:00:00.000Z',
    }
    const unassigned: PendingDecision = {
      id: 'space-proposal:travel',
      kind: 'space-proposal',
      summary: 'Create Space “Travel”',
      scope: { type: 'global' },
      allowedResolutions: ['accept', 'reject'],
      state: 'pending',
      createdAt: '2026-08-25T10:01:00.000Z',
    }

    act(() => {
      handlers.onSurfaceCreated({ type: 'surface.created', event: decisionSurface })
      handlers.onPendingDecisionLifecycle({
        type: 'pending-decision.lifecycle',
        revision: 1,
        decision: assigned,
        message: 'Awaiting your decision: Update the hydration tracker.',
      })
      handlers.onPendingDecisionLifecycle({
        type: 'pending-decision.lifecycle',
        revision: 2,
        decision: unassigned,
        message: 'Awaiting your decision: Create Space “Travel”.',
      })
    })

    const summary = await screen.findByRole('button', { name: '2 decisions await review' })
    const healthCard = screen.getByRole('link', { name: /Health/ })
    expect(within(healthCard).getByLabelText('1 pending decision')).toBeDefined()
    fireEvent.click(summary)

    const assignedGlobal = screen.getByRole('article', {
      name: 'Update the hydration tracker',
    })
    const unassignedGlobal = screen.getByRole('article', { name: 'Create Space “Travel”' })
    expect(
      within(assignedGlobal)
        .getByRole('link', { name: 'Review Update the hydration tracker' })
        .getAttribute('href'),
    ).toBe('/app/space/health/surface/srf-decision-health')
    expect(within(unassignedGlobal).queryByRole('link', { name: /Review/ })).toBeNull()

    fireEvent.click(healthCard)

    const spaceNotifications = await screen.findByRole('region', { name: 'Pending decisions' })
    expect(within(spaceNotifications).getByText('Update the hydration tracker')).toBeDefined()
    expect(within(spaceNotifications).queryByText('Create Space “Travel”')).toBeNull()
    fireEvent.click(
      within(spaceNotifications).getByRole('link', {
        name: 'Review Update the hydration tracker',
      }),
    )

    await waitFor(() =>
      expect(location.pathname).toBe('/app/space/health/surface/srf-decision-health'),
    )
    expect(
      screen
        .getByRole('article', { name: 'Review hydration change Surface' })
        .getAttribute('aria-current'),
    ).toBe('true')

    act(() => {
      handlers.onSurfaceArchived(
        SurfaceArchivedEventSchema.parse({
          cursor: 2,
          at: '2026-08-25T10:02:00.000Z',
          spaceId: 'spc-health',
          surfaceId: 'srf-decision-health',
          order: {
            cursor: 2,
            spaceId: 'spc-health',
            pinnedSurfaceIds: [],
            regularSurfaceIds: [],
          },
        }),
      )
    })
    fireEvent.click(await screen.findByRole('link', { name: 'Back to Home' }))

    expect(await screen.findByRole('button', { name: '2 decisions await review' })).toBeDefined()
    expect(
      within(screen.getByRole('link', { name: /Health/ })).queryByLabelText(/pending/),
    ).toBeNull()
  })

  it('dismisses one Pending decision from Home, its owning Space, and chat through shared state', async () => {
    const handlers = await renderConnectedEmptyHealth('pwa-dismiss')
    const decisionSurface = SurfaceCreatedEventSchema.parse({
      cursor: 1,
      at: '2026-08-25T10:00:00.000Z',
      spaceId: 'spc-health',
      surface: appSurface('srf-decision-dismiss', 'Review weekly report'),
      order: {
        cursor: 1,
        spaceId: 'spc-health',
        pinnedSurfaceIds: [],
        regularSurfaceIds: ['srf-decision-dismiss'],
      },
    })
    const pending: PendingDecision = {
      id: 'approval:effect-dismiss',
      kind: 'approval',
      summary: 'Send the weekly report',
      scope: { type: 'space', spaceId: 'spc-health' },
      allowedResolutions: ['approve', 'reject'],
      state: 'pending',
      decisionSurfaceId: 'srf-decision-dismiss',
      createdAt: '2026-08-25T10:00:00.000Z',
    }

    act(() => {
      handlers.onSurfaceCreated({ type: 'surface.created', event: decisionSurface })
      handlers.onChatTurnStart({ type: 'chat.turn-start', turnId: 'turn-dismiss' })
      handlers.onChatTurnEnd({
        type: 'chat.turn-end',
        turnId: 'turn-dismiss',
        message: {
          role: 'assistant',
          text: 'The weekly report needs approval.',
          pendingDecisions: [pending],
        },
      })
    })

    fireEvent.click(await screen.findByRole('link', { name: 'Home' }))
    fireEvent.click(await screen.findByRole('button', { name: '1 decision awaits review' }))
    const shellDecision = document.querySelector<HTMLElement>('.pending-decision-notification')
    if (!shellDecision) throw new Error('shell Pending decision presentation missing')
    expect(document.querySelector('.chat-pending-decision')).not.toBeNull()

    fireEvent.click(
      within(shellDecision).getByRole('button', { name: 'Dismiss Send the weekly report' }),
    )

    expect(screen.queryByRole('button', { name: '1 decision awaits review' })).toBeNull()
    expect(
      within(screen.getByRole('link', { name: /Health/ })).queryByLabelText(/pending decision/),
    ).toBeNull()
    expect(document.querySelector('.chat-pending-decision')).toBeNull()

    fireEvent.click(screen.getByRole('link', { name: /Health/ }))
    expect(screen.queryByRole('region', { name: 'Pending decisions' })).toBeNull()

    vi.mocked(fetchPendingDecisions).mockResolvedValueOnce({ revision: 2, decisions: [pending] })
    await act(async () => handlers.onHello(1, 'pwa-dismiss'))
    expect(screen.queryByRole('region', { name: 'Pending decisions' })).toBeNull()
    expect(document.querySelector('.chat-pending-decision')).toBeNull()
  })

  it('coalesces repeated shell and chat quick actions for the same decision', async () => {
    const handlers = await renderConnectedEmptyHealth('pwa-decision-race')
    const pending: PendingDecision = {
      id: 'approval:effect-race',
      kind: 'approval',
      summary: 'Send the weekly report',
      scope: { type: 'space', spaceId: 'spc-health' },
      allowedResolutions: ['approve', 'reject'],
      state: 'pending',
      decisionSurfaceId: 'srf-decision-race',
      createdAt: '2026-08-25T10:00:00.000Z',
    }
    const terminal: PendingDecision = {
      ...pending,
      state: 'terminal',
      outcome: 'executed',
      decisionAt: '2026-08-25T10:01:00.000Z',
      resolvedAt: '2026-08-25T10:01:01.000Z',
      resolvedBy: 'trusted:user',
    }
    let finishResolution:
      ((value: Awaited<ReturnType<typeof resolvePendingDecision>>) => void) | undefined
    vi.mocked(resolvePendingDecision).mockReturnValueOnce(
      new Promise((resolve) => {
        finishResolution = resolve
      }),
    )

    act(() => {
      handlers.onChatTurnStart({ type: 'chat.turn-start', turnId: 'turn-race' })
      handlers.onChatTurnEnd({
        type: 'chat.turn-end',
        turnId: 'turn-race',
        message: {
          role: 'assistant',
          text: 'The weekly report needs approval.',
          pendingDecisions: [pending],
        },
      })
    })

    fireEvent.click(await screen.findByRole('button', { name: '1 decision awaits review' }))
    const shellDecision = document.querySelector<HTMLElement>('.pending-decision-notification')
    const chatDecision = document.querySelector<HTMLElement>('.chat-pending-decision')
    if (!shellDecision || !chatDecision) throw new Error('Pending decision presentations missing')

    fireEvent.click(
      within(shellDecision).getByRole('button', { name: 'Approve Send the weekly report' }),
    )
    fireEvent.click(
      within(chatDecision).getByRole('button', { name: 'Approve Send the weekly report' }),
    )

    expect(resolvePendingDecision).toHaveBeenCalledTimes(1)
    expect(
      within(shellDecision).getByRole<HTMLButtonElement>('button', {
        name: 'Approve Send the weekly report',
      }).disabled,
    ).toBe(true)
    expect(
      within(chatDecision).getByRole<HTMLButtonElement>('button', {
        name: 'Approve Send the weekly report',
      }).disabled,
    ).toBe(true)

    await act(async () => finishResolution?.({ decision: terminal, replayed: false }))

    expect(screen.queryByRole('button', { name: '1 decision awaits review' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Approve Send the weekly report' })).toBeNull()
    expect(screen.getAllByText('Executed: Send the weekly report.')).toHaveLength(2)
  })

  it('shows one convergent Pending-decision outcome in chat and the fixed shell', async () => {
    const handlers = await renderConnectedEmptyHealth('pwa-outcome')
    const pending: PendingDecision = {
      id: 'approval:effect-1',
      kind: 'approval' as const,
      summary: 'Send message to alice@example.com',
      scope: { type: 'space' as const, spaceId: 'spc-health' },
      allowedResolutions: ['approve', 'reject'],
      state: 'pending',
      decisionSurfaceId: 'srf-approval-1',
      createdAt: '2026-08-25T10:00:00.000Z',
    }
    const resolving: PendingDecision = {
      ...pending,
      state: 'resolving',
      decisionAt: '2026-08-25T10:01:00.000Z',
      resolvedBy: 'trusted:user' as const,
    }
    const terminal: PendingDecision = {
      ...resolving,
      state: 'terminal',
      outcome: 'executed',
      resolvedAt: '2026-08-25T10:01:01.000Z',
    }

    act(() => {
      handlers.onChatTurnStart({ type: 'chat.turn-start', turnId: 'turn-approval' })
      handlers.onChatTurnDelta({
        type: 'chat.turn-delta',
        turnId: 'turn-approval',
        text: 'Done — send_message completed.',
      })
      handlers.onChatTurnReplace({
        type: 'chat.turn-replace',
        turnId: 'turn-approval',
        message: {
          role: 'assistant',
          text: 'Awaiting your decision: Send message to alice@example.com.',
          pendingDecisions: [pending],
        },
      })
      handlers.onApprovalCard({
        type: 'approval.card',
        card: {
          id: 'effect-1',
          level: 'L1',
          title: 'Send message',
          body: 'Safe notification summary',
          actionLabel: 'Approve',
          createdAt: '2026-08-25T10:00:00.000Z',
          surfaceId: 'srf-approval-1',
          expiresAt: '2026-08-25T10:10:00.000Z',
        },
      })
      handlers.onPendingDecisionLifecycle({
        type: 'pending-decision.lifecycle',
        revision: 1,
        decision: resolving,
        message: 'In progress: Send message to alice@example.com.',
      })
    })

    expect(
      await screen.findAllByText('In progress: Send message to alice@example.com.', {
        exact: true,
      }),
    ).toHaveLength(2)
    expect(screen.queryByText('Done — send_message completed.')).toBeNull()
    expect(screen.queryByRole('heading', { name: 'Send message' })).toBeNull()

    act(() => {
      handlers.onPendingDecisionLifecycle({
        type: 'pending-decision.lifecycle',
        revision: 2,
        decision: terminal,
        message: 'Executed: Send message to alice@example.com.',
      })
      handlers.onPendingDecisionLifecycle({
        type: 'pending-decision.lifecycle',
        revision: 2,
        decision: terminal,
        message: 'Executed: Send message to alice@example.com.',
      })
    })

    expect(
      await screen.findAllByText('Executed: Send message to alice@example.com.', { exact: true }),
    ).toHaveLength(2)
    expect(
      document.querySelectorAll('[data-decision-feedback-id="approval:effect-1"]'),
    ).toHaveLength(2)
    expect(screen.queryByText('In progress: Send message to alice@example.com.')).toBeNull()

    act(() => {
      handlers.onChatTurnEnd({
        type: 'chat.turn-end',
        turnId: 'turn-approval',
        message: {
          role: 'assistant',
          text: 'Done — send_message completed.',
          pendingDecisions: [pending],
        },
      })
    })

    expect(
      await screen.findAllByText('Executed: Send message to alice@example.com.', { exact: true }),
    ).toHaveLength(2)
    expect(screen.queryByText('Done — send_message completed.')).toBeNull()
    expect(
      screen.queryByRole('button', { name: 'Approve Send message to alice@example.com' }),
    ).toBeNull()
  })

  it('replaces an unprojected decision fallback when its terminal lifecycle arrives', async () => {
    const handlers = await renderConnectedEmptyHealth('pwa-unprojected-outcome')
    const terminal: PendingDecision = {
      id: 'approval:effect-unavailable',
      kind: 'approval',
      summary: 'Send message to alice@example.com',
      scope: { type: 'space', spaceId: 'spc-health' },
      allowedResolutions: ['approve', 'reject'],
      state: 'terminal',
      outcome: 'executed',
      decisionSurfaceId: 'srf-approval-unavailable',
      createdAt: '2026-08-25T10:00:00.000Z',
      decisionAt: '2026-08-25T10:01:00.000Z',
      resolvedAt: '2026-08-25T10:01:01.000Z',
      resolvedBy: 'trusted:user',
    }

    act(() => {
      handlers.onChatTurnStart({ type: 'chat.turn-start', turnId: 'turn-unprojected' })
      handlers.onChatTurnReplace({
        type: 'chat.turn-replace',
        turnId: 'turn-unprojected',
        message: {
          role: 'assistant',
          text: PENDING_DECISION_FALLBACK_FEEDBACK,
          pendingDecisionIds: [terminal.id],
        },
      })
      handlers.onChatTurnEnd({
        type: 'chat.turn-end',
        turnId: 'turn-unprojected',
        message: {
          role: 'assistant',
          text: PENDING_DECISION_FALLBACK_FEEDBACK,
          pendingDecisionIds: [terminal.id],
        },
      })
    })

    expect(await screen.findByText(PENDING_DECISION_FALLBACK_FEEDBACK)).toBeDefined()

    act(() => {
      handlers.onPendingDecisionLifecycle({
        type: 'pending-decision.lifecycle',
        revision: 1,
        decision: terminal,
        message: 'Executed: Send message to alice@example.com.',
      })
    })

    expect(screen.queryByText(PENDING_DECISION_FALLBACK_FEEDBACK)).toBeNull()
    expect(
      await screen.findAllByText('Executed: Send message to alice@example.com.', { exact: true }),
    ).toHaveLength(2)
    expect(
      document.querySelectorAll('[data-decision-feedback-id="approval:effect-unavailable"]'),
    ).toHaveLength(2)
  })

  it('reconciles a known Pending decision after reconnect without duplicating chat feedback', async () => {
    const handlers = await renderConnectedEmptyHealth('pwa-reconnect')
    await waitFor(() => expect(fetchPendingDecisions).toHaveBeenCalledOnce())
    const resolving: PendingDecision = {
      id: 'space-proposal:proposal-travel',
      kind: 'space-proposal' as const,
      summary: 'Create Space “Travel”',
      scope: { type: 'global' as const },
      allowedResolutions: ['accept', 'reject'],
      state: 'resolving',
      createdAt: '2026-08-25T10:00:00.000Z',
      decisionAt: '2026-08-25T10:01:00.000Z',
      resolvedBy: 'trusted:user' as const,
    }
    const terminal: PendingDecision = {
      ...resolving,
      state: 'terminal',
      outcome: 'accepted',
      resolvedAt: '2026-08-25T10:01:01.000Z',
    }

    act(() => {
      handlers.onPendingDecisionLifecycle({
        type: 'pending-decision.lifecycle',
        revision: 1,
        decision: resolving,
        message: 'In progress: Create Space “Travel”.',
      })
    })
    expect(await screen.findAllByText('In progress: Create Space “Travel”.')).toHaveLength(2)

    vi.mocked(fetchPendingDecisions).mockResolvedValueOnce({ revision: 2, decisions: [terminal] })
    await act(async () => handlers.onHello(0, 'pwa-reconnect'))

    expect(
      await screen.findAllByText('Accepted: Create Space “Travel”.', { exact: true }),
    ).toHaveLength(2)
    expect(document.querySelectorAll('.chat-entry[data-decision-feedback-id]')).toHaveLength(1)
  })

  it('keeps a live terminal outcome that also lands in the reconnect snapshot', async () => {
    const handlers = await renderConnectedEmptyHealth('pwa-reconnect-race')
    await waitFor(() => expect(fetchPendingDecisions).toHaveBeenCalledOnce())
    const terminal: PendingDecision = {
      id: 'space-proposal:proposal-travel',
      kind: 'space-proposal',
      summary: 'Create Space “Travel”',
      scope: { type: 'global' },
      allowedResolutions: ['accept', 'reject'],
      state: 'terminal',
      outcome: 'accepted',
      createdAt: '2026-08-25T10:00:00.000Z',
      resolvedAt: '2026-08-25T10:01:01.000Z',
      resolvedBy: 'trusted:user',
    }
    let resolveSnapshot: ((snapshot: PendingDecisionList) => void) | undefined
    vi.mocked(fetchPendingDecisions).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveSnapshot = resolve
      }),
    )

    act(() => handlers.onHello(0, 'pwa-reconnect-race'))
    act(() => {
      handlers.onPendingDecisionLifecycle({
        type: 'pending-decision.lifecycle',
        revision: 2,
        decision: terminal,
        message: 'Accepted: Create Space “Travel”.',
      })
    })
    await act(async () => {
      resolveSnapshot?.({ revision: 2, decisions: [terminal] })
    })

    expect(
      await screen.findAllByText('Accepted: Create Space “Travel”.', { exact: true }),
    ).toHaveLength(2)
    expect(document.querySelectorAll('.chat-entry[data-decision-feedback-id]')).toHaveLength(1)
  })

  it('recovers an outcome first observed while this PWA was offline without duplicating it', async () => {
    const handlers = await renderConnectedEmptyHealth('pwa-offline-outcome')
    await waitFor(() => expect(fetchPendingDecisions).toHaveBeenCalledOnce())
    const terminal: PendingDecision = {
      id: 'tree-proposal:17',
      kind: 'tree-proposal',
      summary: 'Change the “Weekly plan” Surface tree',
      scope: { type: 'space', spaceId: 'spc-health' },
      allowedResolutions: ['accept', 'reject'],
      state: 'terminal',
      outcome: 'stale',
      createdAt: '2026-08-25T10:00:00.000Z',
      resolvedAt: '2026-08-25T10:04:00.000Z',
      resolvedBy: 'trusted:user',
    }
    const snapshot = { revision: 4, decisions: [terminal] }

    vi.mocked(fetchPendingDecisions).mockResolvedValueOnce(snapshot)
    await act(async () => handlers.onHello(0, 'pwa-offline-outcome'))

    expect(
      await screen.findAllByText(
        'Refused because it became stale: Change the “Weekly plan” Surface tree.',
      ),
    ).toHaveLength(2)

    vi.mocked(fetchPendingDecisions).mockResolvedValueOnce(snapshot)
    await act(async () => handlers.onHello(0, 'pwa-offline-outcome'))
    expect(document.querySelectorAll('.chat-entry[data-decision-feedback-id]')).toHaveLength(1)
  })

  it('uses immediate positioning and a non-animated visible highlight for reduced motion', async () => {
    window.history.replaceState({}, '', '/app/space/health')
    vi.stubGlobal(
      'matchMedia',
      vi.fn().mockReturnValue({
        matches: true,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }),
    )
    const handlers = await renderConnectedEmptyHealth('pwa-reduced')
    act(() => {
      handlers.onChatTurnStart({ type: 'chat.turn-start', turnId: 'turn-reduced' })
      handlers.onSurfaceCreated({
        type: 'surface.created',
        initiatingTurn: { clientId: 'pwa-reduced', turnId: 'turn-reduced' },
        event: SurfaceCreatedEventSchema.parse({
          cursor: 1,
          at: '2026-08-16T10:00:00.000Z',
          spaceId: 'spc-health',
          surface: {
            id: 'srf-reduced',
            spaceId: 'spc-health',
            title: 'Reduced motion',
            tree: { id: 'root', type: 'Box' },
            state: {},
            freshness: { updatedAt: '2026-08-16T10:00:00.000Z', updatedBy: 'agent' },
          },
          order: createdOrder(1, 'srf-reduced'),
        }),
      })
    })

    const surfaceArticle = await screen.findByRole('article', {
      name: 'Reduced motion Surface',
    })
    await waitFor(() =>
      expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'auto', block: 'center' }),
    )
    expect(surfaceArticle.classList.contains('surface-reveal-highlight')).toBe(true)
  })

  it('renders the status-unavailable screen instead of Home when the onboarding status fetch fails on a production session', async () => {
    localStorage.setItem(AUTH_TOKEN_KEY, 'a-stored-token')
    vi.mocked(fetchAuthStatus).mockResolvedValue(authStatus())
    vi.mocked(fetchSpaces).mockResolvedValue({ spaces: [], surfaceCursor: 0 })
    vi.mocked(fetchOnboardingStatus).mockRejectedValue(new Error('the daemon is unreachable'))

    render(<App />)

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toBe(
      'Veduta could not read its setup status, so Home is not being shown. Check the daemon ' +
        'and try again.',
    )
    expect(screen.getByRole('button', { name: 'Retry' })).toBeDefined()
    expect(screen.queryByLabelText('Spaces')).toBeNull()
  })

  it('discards an unauthorized stored session and returns first boot to passkey registration', async () => {
    window.history.replaceState({}, '', '/setup?code=fresh-code')
    localStorage.setItem(AUTH_TOKEN_KEY, 'stale-token')
    localStorage.setItem(
      HOME_CACHE_KEY,
      JSON.stringify({
        surfaceCursor: 0,
        spaces: [
          {
            id: 'spc-health',
            slug: 'health',
            name: 'Health',
            archived: false,
            surfaces: [],
          },
        ],
      }),
    )
    vi.mocked(fetchAuthStatus).mockResolvedValue(
      authStatus({ bootstrapRequired: true, passkeyRegistered: false }),
    )
    vi.mocked(fetchSpaces).mockRejectedValue(new ApiResponseError('passkey session required', 401))
    vi.mocked(fetchOnboardingStatus).mockRejectedValue(
      new ApiResponseError('passkey session required', 401),
    )

    render(<App />)

    expect(await screen.findByRole('button', { name: 'Register passkey' })).toBeDefined()
    expect((screen.getByLabelText('One-time code') as HTMLInputElement).value).toBe('fresh-code')
    expect(localStorage.getItem(AUTH_TOKEN_KEY)).toBeNull()
    expect(screen.queryByText(/could not read its setup status/i)).toBeNull()
  })

  it('the Model connections button renders with zero connections', async () => {
    vi.mocked(fetchAuthStatus).mockResolvedValue(authStatus({ mode: 'dev' }))
    vi.mocked(fetchSpaces).mockResolvedValue({ spaces: [], surfaceCursor: 0 })
    vi.mocked(fetchOnboardingStatus).mockResolvedValue(
      fromPartial<OnboardingStatus>({ required: false, completed: true }),
    )
    // A pure-mock install (issue #47): `ChatModelSelects` renders nothing
    // for this snapshot, yet the settings view must still be reachable to
    // add a first connection.
    vi.mocked(fetchModelConnections).mockResolvedValue({
      vaultAvailable: true,
      mockEnabled: true,
      mockControlAvailable: false,
      methods: [],
      connections: [],
      selection: null,
    })

    render(<App />)

    await waitFor(() => expect(screen.getByLabelText('Spaces')).toBeDefined())

    expect(await screen.findByRole('button', { name: 'Model connections' })).toBeDefined()
  })
})

function createdOrder(cursor: number, surfaceId: string) {
  return {
    cursor,
    spaceId: 'spc-health',
    pinnedSurfaceIds: [],
    regularSurfaceIds: [surfaceId],
  }
}

function oneShotActionSurface(): Surface {
  return {
    id: 'srf-update-test',
    spaceId: 'spc-system',
    title: 'Updates',
    tree: {
      id: 'root',
      type: 'Box',
      children: [
        {
          id: 'check-now',
          type: 'Button',
          props: { label: 'Check now' },
          actions: [
            {
              name: 'check',
              path: 'fast',
              stateKey: 'check.requested',
              payload: { value: true },
            },
          ],
        },
        {
          id: 'check-request-state',
          type: 'Checkbox',
          binding: 'check.requested',
          props: { label: 'Check request state' },
        },
      ],
    },
    state: { 'check.requested': false },
    freshness: { updatedAt: '2026-08-20T10:00:00.000Z', updatedBy: 'job' },
    pinned: false,
    pinnable: true,
  }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

function treeProposalRevealFixture() {
  const surfaceId = 'srf-tree-proposal-1'
  const pending: PendingDecision = {
    id: 'tree-proposal:1',
    kind: 'tree-proposal',
    summary: 'Update the weekly plan',
    scope: { type: 'space', spaceId: 'spc-health' },
    allowedResolutions: ['accept', 'reject'],
    state: 'pending',
    decisionSurfaceId: surfaceId,
    createdAt: '2026-08-28T10:00:00.000Z',
  }
  const created = SurfaceCreatedEventSchema.parse({
    cursor: 1,
    at: '2026-08-28T10:00:00.000Z',
    spaceId: 'spc-health',
    surface: appSurface(surfaceId, 'Proposed layout change: Weekly plan'),
    order: createdOrder(1, surfaceId),
  })
  return {
    surfaceId,
    created,
    replacement: {
      type: 'chat.turn-replace' as const,
      turnId: 'turn-tree-proposal',
      spaceId: 'spc-health',
      message: {
        role: 'assistant' as const,
        text: 'Awaiting your decision: Update the weekly plan.',
        pendingDecisions: [pending],
      },
    },
  }
}

function hasOpacityKeyframe(keyframes: Keyframe[] | PropertyIndexedKeyframes): boolean {
  return Array.isArray(keyframes) && keyframes.some(({ opacity }) => opacity !== undefined)
}
