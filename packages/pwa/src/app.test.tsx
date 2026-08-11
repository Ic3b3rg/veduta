// @vitest-environment jsdom
//
// Focused app-level integration tests for behavior that crosses App's
// networking, routing, and live-state seams. Lower-level helpers keep their
// exhaustive coverage in their own colocated tests.
import {
  SurfaceCreatedEventSchema,
  SurfacePatchEventSchema,
  type AuthStatus,
  type ModelConnectionsSnapshot,
  type OnboardingStatus,
} from '@veduta/protocol'
import { fromPartial } from '@total-typescript/shoehorn'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ApiModule from './api.ts'
import { AUTH_TOKEN_KEY, HOME_CACHE_KEY } from './pwa-storage.ts'

vi.mock('./api.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof ApiModule>()
  return {
    ...actual,
    fetchAuthStatus: vi.fn(),
    fetchSpaces: vi.fn(),
    fetchOnboardingStatus: vi.fn(),
    connectGateway: vi.fn(() => ({ close: vi.fn(), sendChat: vi.fn(() => false) })),
    fetchModelConnections: vi.fn(),
  }
})

import { App } from './app.tsx'
import {
  ApiResponseError,
  connectGateway,
  fetchAuthStatus,
  fetchModelConnections,
  fetchOnboardingStatus,
  fetchSpaces,
} from './api.ts'

// jsdom has no matchMedia implementation; `pwa-storage.ts#isStandalone` (read
// at mount to decide whether to show the install guide) calls it
// unconditionally.
beforeEach(() => {
  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockReturnValue({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }),
  )
})

afterEach(() => {
  cleanup()
  localStorage.clear()
  window.history.replaceState({}, '', '/')
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

function authStatus(overrides: Partial<AuthStatus> = {}): AuthStatus {
  return { mode: 'production', bootstrapRequired: false, passkeyRegistered: true, ...overrides }
}

function connectedModelConnectionsSnapshot(): ModelConnectionsSnapshot {
  return {
    vaultAvailable: true,
    mockEnabled: false,
    mockControlAvailable: false,
    methods: [],
    connections: [
      {
        id: 'a1a1a1a1-0000-4000-8000-000000000001',
        method: 'anthropic-api-key',
        provider: 'anthropic',
        label: 'Claude',
        state: 'connected',
        stateAt: '2026-08-09T00:00:00.000Z',
        enabledForFallback: false,
        createdAt: '2026-08-09T00:00:00.000Z',
        selectedModelId: 'claude-sonnet-5',
        catalog: [{ id: 'claude-sonnet-5', label: 'Claude Sonnet', routable: true }],
      },
    ],
    selection: { connectionId: 'a1a1a1a1-0000-4000-8000-000000000001', modelId: 'claude-sonnet-5' },
  }
}

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
          vedutaTools: true,
          metered: false,
        },
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

describe('App', () => {
  it('renders a selected-subscription Surface, streamed confirmation, and follow-up patch live', async () => {
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
    })

    act(() => {
      handlers.onSurfaceCreated(created)
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

  it('the Model connections button opens the settings view', async () => {
    vi.mocked(fetchAuthStatus).mockResolvedValue(authStatus({ mode: 'dev' }))
    vi.mocked(fetchSpaces).mockResolvedValue({ spaces: [], surfaceCursor: 0 })
    vi.mocked(fetchOnboardingStatus).mockResolvedValue(
      fromPartial<OnboardingStatus>({ required: false, completed: true }),
    )
    vi.mocked(fetchModelConnections).mockResolvedValue(connectedModelConnectionsSnapshot())

    render(<App />)

    await waitFor(() => expect(screen.getByLabelText('Spaces')).toBeDefined())

    fireEvent.click(await screen.findByRole('button', { name: 'Model connections' }))

    expect(
      await screen.findByRole('heading', { name: 'Model connections', level: 2 }),
    ).toBeDefined()
    expect(screen.queryByLabelText('Spaces')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Back' }))

    expect(await screen.findByLabelText('Spaces')).toBeDefined()
  })
})
