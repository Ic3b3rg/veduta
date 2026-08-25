// @vitest-environment jsdom
//
// App-level integration tests for navigation sources and guarded routes.
import type { ModelConnectionsSnapshot, OnboardingStatus } from '@veduta/protocol'
import { fromPartial } from '@total-typescript/shoehorn'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ApiModule from './api.ts'
import { authStatus, installAppTestBrowser, resetAppTestBrowser } from './app-test-support.ts'
import { AUTH_TOKEN_KEY, CHAT_HISTORY_KEY } from './pwa-storage.ts'

vi.mock('./api.ts', async (importOriginal) => {
  const { createAppApiMock } = await import('./app-test-support.ts')
  return createAppApiMock(await importOriginal<typeof ApiModule>())
})

import { App } from './app.tsx'
import {
  fetchAuthStatus,
  fetchModelConnections,
  fetchOnboardingStatus,
  fetchSpaces,
  finishOnboarding,
  type SpaceWithSurfaces,
} from './api.ts'

beforeEach(() => {
  installAppTestBrowser()
})

afterEach(resetAppTestBrowser)

function modelConnectionsSnapshot(): ModelConnectionsSnapshot {
  return {
    vaultAvailable: true,
    mockEnabled: true,
    mockControlAvailable: false,
    methods: [],
    connections: [],
    selection: null,
  }
}

function mockReadyApp(spaces: SpaceWithSurfaces[] = []): void {
  vi.mocked(fetchAuthStatus).mockResolvedValue(authStatus({ mode: 'dev' }))
  vi.mocked(fetchSpaces).mockResolvedValue({ spaces, surfaceCursor: 0 })
  vi.mocked(fetchOnboardingStatus).mockResolvedValue(
    fromPartial<OnboardingStatus>({ required: false, completed: true }),
  )
  vi.mocked(fetchModelConnections).mockResolvedValue(modelConnectionsSnapshot())
}

function healthSpaces(): SpaceWithSurfaces[] {
  return [
    {
      id: 'spc-health',
      slug: 'health',
      name: 'Health',
      archived: false,
      attention: 0,
      attentionRevision: 0,
      surfaces: [
        {
          id: 'srf-hydration',
          spaceId: 'spc-health',
          title: 'Hydration',
          tree: { id: 'root', type: 'Box' },
          state: {},
          freshness: { updatedAt: '2026-08-16T10:00:00.000Z', updatedBy: 'agent' },
          pinned: false,
          pinnable: true,
        },
      ],
    },
  ]
}

function installServiceWorkerMessages(): EventTarget {
  const messages = new EventTarget()
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: messages,
  })
  return messages
}

function navigateFromServiceWorker(messages: EventTarget, url: string): void {
  act(() => {
    messages.dispatchEvent(new MessageEvent('message', { data: { type: 'navigate', url } }))
  })
}

async function expectFocusedHealthRoute(path: string, surfaceSelected: boolean): Promise<void> {
  await waitFor(() =>
    expect(screen.getByRole('button', { name: /Health/ }).getAttribute('aria-pressed')).toBe(
      'true',
    ),
  )
  expect(screen.getByRole('button', { name: 'Focus Hydration' }).getAttribute('aria-pressed')).toBe(
    String(surfaceSelected),
  )
  expect(location.pathname).toBe(path)
}

describe('App routing', () => {
  it('navigates from setup to Home when onboarding completes', async () => {
    window.history.replaceState({}, '', '/setup')
    localStorage.setItem(AUTH_TOKEN_KEY, 'onboarding-token')
    vi.mocked(fetchAuthStatus).mockResolvedValue(authStatus())
    vi.mocked(fetchSpaces).mockResolvedValue({ spaces: [], surfaceCursor: 0 })
    vi.mocked(fetchOnboardingStatus).mockResolvedValue(
      fromPartial<OnboardingStatus>({
        required: true,
        completed: false,
        profile: 'vps',
        currentStep: 'finish',
        steps: [{ id: 'finish', status: 'pending' }],
      }),
    )
    vi.mocked(fetchModelConnections).mockResolvedValue(modelConnectionsSnapshot())
    vi.mocked(finishOnboarding).mockResolvedValue({
      restartRequired: false,
      restarting: false,
    })

    render(<App />)

    fireEvent.click(await screen.findByRole('button', { name: 'Finish' }))

    await waitFor(() => expect(location.pathname).toBe('/'))
    expect(await screen.findByLabelText('Spaces')).toBeDefined()
  })

  it('redirects completed setup sessions to Home', async () => {
    window.history.replaceState({}, '', '/setup')
    localStorage.setItem(AUTH_TOKEN_KEY, 'completed-setup-token')
    mockReadyApp()

    render(<App />)

    await waitFor(() => expect(location.pathname).toBe('/'))
    expect(await screen.findByLabelText('Spaces')).toBeDefined()
  })

  it('routes Model connections through browser Back and Forward', async () => {
    mockReadyApp()

    render(<App />)

    await waitFor(() => expect(screen.getByLabelText('Spaces')).toBeDefined())
    fireEvent.click(await screen.findByRole('button', { name: 'Model connections' }))

    expect(
      await screen.findByRole('heading', { name: 'Model connections', level: 2 }),
    ).toBeDefined()
    expect(location.pathname).toBe('/app/settings/models')
    expect(screen.queryByLabelText('Spaces')).toBeNull()

    act(() => history.back())

    expect(await screen.findByLabelText('Spaces')).toBeDefined()
    expect(location.pathname).toBe('/')

    act(() => history.forward())

    expect(
      await screen.findByRole('heading', { name: 'Model connections', level: 2 }),
    ).toBeDefined()
    expect(location.pathname).toBe('/app/settings/models')
  })

  it('recognizes a direct Model connections load after the guards settle', async () => {
    window.history.replaceState({}, '', '/app/settings/models')
    mockReadyApp()

    render(<App />)

    expect(
      await screen.findByRole('heading', { name: 'Model connections', level: 2 }),
    ).toBeDefined()
    expect(screen.queryByLabelText('Spaces')).toBeNull()
    expect(location.pathname).toBe('/app/settings/models')
  })

  it.each([
    ['/app/space/health', false],
    ['/app/space/health/surface/srf-hydration', true],
  ])('recognizes a direct load of %s', async (path, surfaceSelected) => {
    window.history.replaceState({}, '', path)
    mockReadyApp(healthSpaces())

    render(<App />)

    await expectFocusedHealthRoute(path, surfaceSelected)
  })

  it('routes service-worker navigation messages through the client router', async () => {
    const serviceWorkerMessages = installServiceWorkerMessages()
    mockReadyApp()

    render(<App />)
    await screen.findByLabelText('Spaces')

    navigateFromServiceWorker(serviceWorkerMessages, '/app/settings/models')

    expect(
      await screen.findByRole('heading', { name: 'Model connections', level: 2 }),
    ).toBeDefined()
    expect(location.pathname).toBe('/app/settings/models')
  })

  it('derives the focused Space and Surface from routed service-worker navigation', async () => {
    const serviceWorkerMessages = installServiceWorkerMessages()
    const path = '/app/space/health/surface/srf-hydration'
    mockReadyApp(healthSpaces())

    render(<App />)
    await screen.findByLabelText('Spaces')

    navigateFromServiceWorker(serviceWorkerMessages, path)

    await expectFocusedHealthRoute(path, true)
  })

  it('routes chat result links without reloading the PWA', async () => {
    const path = '/app/space/health/surface/srf-hydration'
    localStorage.setItem(
      CHAT_HISTORY_KEY,
      JSON.stringify([
        {
          role: 'assistant',
          text: 'Hydration is ready.',
          targets: [
            {
              spaceId: 'spc-health',
              spaceSlug: 'health',
              spaceName: 'Health',
              surfaceId: 'srf-hydration',
              surfaceTitle: 'Hydration',
            },
          ],
        },
      ]),
    )
    mockReadyApp(healthSpaces())

    render(<App />)

    fireEvent.click(await screen.findByRole('link', { name: 'Open Health · Hydration' }))

    await expectFocusedHealthRoute(path, true)
    expect(document.activeElement).toBe(
      screen.getByRole('textbox', { name: 'Message Veduta in Health' }),
    )
  })
})
