// @vitest-environment jsdom
//
// Focused app-level integration tests for behavior that crosses App's
// networking, routing, and live-state seams. Lower-level helpers keep their
// exhaustive coverage in their own colocated tests.
import {
  SurfaceCreatedEventSchema,
  SurfaceMovedEventSchema,
  SurfacePatchEventSchema,
  type ModelConnectionsSnapshot,
  type OnboardingStatus,
} from '@veduta/protocol'
import { fromPartial } from '@total-typescript/shoehorn'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
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

    const focusButtons = await screen.findAllByRole('button', { name: /^Focus Gateway/ })
    expect(focusButtons.map((button) => button.getAttribute('aria-label'))).toEqual([
      'Focus Gateway first',
      'Focus Gateway second',
    ])
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
        .getAllByRole('button', { name: /^Focus Gateway/ })
        .map((button) => button.getAttribute('aria-label')),
    ).toEqual(['Focus Gateway first', 'Focus Gateway second'])
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

    expect(await screen.findByRole('button', { name: 'Focus Hydration' })).toBeDefined()
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

    expect(await screen.findByRole('button', { name: 'Focus Meals' })).toBeDefined()
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
      ...groceries,
      state: { milk: true },
      freshness: { updatedAt: '2026-08-20T10:00:01.000Z', updatedBy: 'user' },
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

    const focusButton = await screen.findByRole('button', { name: 'Focus Weekly groceries' })
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(1))
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'center' })
    expect(focusButton.closest('article')?.classList.contains('creation-highlight')).toBe(true)
    expect(focusButton.getAttribute('aria-pressed')).toBe('false')
    expect(document.activeElement).toBe(chatInput)
    expect(location.pathname).toBe('/app/space/health')
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
    expect(screen.getByText('Accepted')).toBeDefined()
    expect(screen.queryByRole('button', { name: 'Accept Create Space “Travel”' })).toBeNull()
    expect(location.pathname).toBe('/')
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

    const focusButton = await screen.findByRole('button', { name: 'Focus Reduced motion' })
    await waitFor(() =>
      expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'auto', block: 'center' }),
    )
    expect(focusButton.closest('article')?.classList.contains('creation-highlight')).toBe(true)
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

function hasOpacityKeyframe(keyframes: Keyframe[] | PropertyIndexedKeyframes): boolean {
  return Array.isArray(keyframes) && keyframes.some(({ opacity }) => opacity !== undefined)
}
