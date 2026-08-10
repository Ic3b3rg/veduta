// @vitest-environment jsdom
//
// Focused app-level tests for the two pieces issue #47 adds to `app.tsx`
// (the fail-closed status-unavailable gate and the Model connections view
// switch) -- `app.tsx` had no test file before this issue, so this file
// covers ONLY the new behavior rather than attempting full app-level
// coverage of the pre-existing Gateway/streaming/Space machinery.
import type { AuthStatus, ModelConnectionsSnapshot, OnboardingStatus } from '@veduta/protocol'
import { fromPartial } from '@total-typescript/shoehorn'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ApiModule from './api.ts'
import { AUTH_TOKEN_KEY } from './pwa-storage.ts'

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

describe('App', () => {
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

  it('the Model connections button renders with zero connections', async () => {
    vi.mocked(fetchAuthStatus).mockResolvedValue(authStatus({ mode: 'dev' }))
    vi.mocked(fetchSpaces).mockResolvedValue({ spaces: [], surfaceCursor: 0 })
    vi.mocked(fetchOnboardingStatus).mockResolvedValue(
      fromPartial<OnboardingStatus>({ required: false, completed: true }),
    )
    // A pure-mock install (issue #47 fix batch C): `ChatModelSelects` renders
    // nothing for this snapshot, yet the settings view must still be
    // reachable to add a first connection.
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
