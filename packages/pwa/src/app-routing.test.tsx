// @vitest-environment jsdom
//
// App-level integration tests for navigation sources and guarded routes.
import {
  SurfacePatchEventSchema,
  type ModelConnectionsSnapshot,
  type OnboardingStatus,
} from '@veduta/protocol'
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
  connectGateway,
  fetchAuthStatus,
  fetchModelConnections,
  fetchOnboardingStatus,
  fetchSpaces,
  finishOnboarding,
  invokeFastAction,
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

function healthAndWorkSpaces(): SpaceWithSurfaces[] {
  return [
    ...healthSpaces(),
    {
      id: 'spc-work',
      slug: 'work',
      name: 'Work',
      archived: false,
      attention: 0,
      attentionRevision: 0,
      surfaces: [
        {
          id: 'srf-roadmap',
          spaceId: 'spc-work',
          title: 'Roadmap',
          tree: { id: 'root', type: 'Box' },
          state: {},
          freshness: { updatedAt: '2026-08-16T11:00:00.000Z', updatedBy: 'agent' },
          pinned: false,
          pinnable: true,
        },
      ],
    },
  ]
}

function interactiveHealthSpaces(): SpaceWithSurfaces[] {
  const [health] = healthSpaces()
  const hydration = health?.surfaces[0]
  if (!health || !hydration) throw new Error('Health route fixture is incomplete')

  return [
    {
      ...health,
      surfaces: [
        {
          ...hydration,
          tree: {
            id: 'root',
            type: 'Box',
            children: [
              { id: 'status', type: 'Stat', binding: 'status', props: { label: 'Status' } },
              {
                id: 'water',
                type: 'Checkbox',
                binding: 'water',
                props: { label: 'Drank water' },
                actions: [{ name: 'toggle', path: 'fast', stateKey: 'water', payload: {} }],
              },
            ],
          },
          state: { status: 'Needs water', water: false },
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

  it('renders only the routed Space and never leaks Surfaces from another Space', async () => {
    window.history.replaceState({}, '', '/app/space/health')
    mockReadyApp(healthAndWorkSpaces())

    render(<App />)

    expect(await screen.findByRole('button', { name: 'Focus Hydration' })).toBeDefined()
    expect(screen.queryByRole('button', { name: 'Focus Roadmap' })).toBeNull()
    expect(screen.getByRole('heading', { name: 'Health', level: 2 })).toBeDefined()
    expect(screen.queryByRole('heading', { name: 'Work', level: 2 })).toBeNull()
    expect(screen.getByRole('button', { name: /Work/ })).toBeDefined()
  })

  it.each([
    ['/app/space/missing', 'Space not found'],
    ['/app/space/health/surface/srf-roadmap', 'Surface not found'],
  ])('keeps %s visible as a recoverable route error', async (path, heading) => {
    window.history.replaceState({}, '', path)
    mockReadyApp(healthAndWorkSpaces())

    render(<App />)

    expect(await screen.findByRole('heading', { name: heading, level: 2 })).toBeDefined()
    expect(screen.getByRole('link', { name: 'Back to Home' })).toBeDefined()
    expect(screen.queryByRole('button', { name: 'Focus Hydration' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Focus Roadmap' })).toBeNull()
    expect(location.pathname).toBe(path)

    fireEvent.click(screen.getByRole('link', { name: 'Back to Home' }))
    await waitFor(() => expect(location.pathname).toBe('/'))
  })

  it('navigates laterally through the Space rail and returns through the Home breadcrumb', async () => {
    mockReadyApp(healthAndWorkSpaces())

    render(<App />)

    fireEvent.click(await screen.findByRole('button', { name: /Health/ }))
    await waitFor(() => expect(location.pathname).toBe('/app/space/health'))
    expect(screen.getByRole('button', { name: 'Focus Hydration' })).toBeDefined()
    expect(screen.queryByRole('button', { name: 'Focus Roadmap' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /Work/ }))
    await waitFor(() => expect(location.pathname).toBe('/app/space/work'))
    expect(screen.getByRole('button', { name: 'Focus Roadmap' })).toBeDefined()
    expect(screen.queryByRole('button', { name: 'Focus Hydration' })).toBeNull()

    act(() => history.back())
    await waitFor(() => expect(location.pathname).toBe('/app/space/health'))
    expect(screen.getByRole('button', { name: 'Focus Hydration' })).toBeDefined()

    act(() => history.forward())
    await waitFor(() => expect(location.pathname).toBe('/app/space/work'))
    expect(screen.getByRole('button', { name: 'Focus Roadmap' })).toBeDefined()

    fireEvent.click(screen.getByRole('link', { name: 'Home' }))
    await waitFor(() => expect(location.pathname).toBe('/'))
    expect(screen.getByRole('button', { name: 'Focus Hydration' })).toBeDefined()
    expect(screen.getByRole('button', { name: 'Focus Roadmap' })).toBeDefined()
  })

  it('visibly positions the Surface requested by the nested route', async () => {
    window.history.replaceState({}, '', '/app/space/health/surface/srf-hydration')
    mockReadyApp(healthSpaces())

    render(<App />)

    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Focus Hydration' }).getAttribute('aria-pressed'),
      ).toBe('true'),
    )
    expect(HTMLElement.prototype.scrollIntoView).toHaveBeenCalledWith({
      behavior: 'smooth',
      block: 'center',
    })
  })

  it('derives global and Space chat scope only from the active route', async () => {
    const sendChat = vi.fn(() => true)
    vi.mocked(connectGateway).mockReturnValue({ close: vi.fn(), sendChat })
    mockReadyApp(healthAndWorkSpaces())

    render(<App />)

    await waitFor(() => expect(connectGateway).toHaveBeenCalledOnce())
    fireEvent.change(screen.getByRole('textbox', { name: 'Message Veduta' }), {
      target: { value: 'Global question' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect(sendChat).toHaveBeenLastCalledWith('Global question', undefined)

    fireEvent.click(screen.getByRole('button', { name: /Health/ }))
    const spaceChat = await screen.findByRole('textbox', { name: 'Message Veduta in Health' })
    fireEvent.change(spaceChat, { target: { value: 'Space question' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect(sendChat).toHaveBeenLastCalledWith('Space question', 'spc-health')

    fireEvent.click(screen.getByRole('button', { name: 'Focus Hydration' }))
    await waitFor(() => expect(location.pathname).toBe('/app/space/health/surface/srf-hydration'))
    const surfaceChat = screen.getByRole('textbox', { name: 'Message Veduta in Health' })
    fireEvent.change(surfaceChat, { target: { value: 'Surface-route question' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect(sendChat).toHaveBeenLastCalledWith('Surface-route question', 'spc-health')
  })

  it('keeps catalog Surface actions active inside the routed Space', async () => {
    window.history.replaceState({}, '', '/app/space/health')
    const spaces = interactiveHealthSpaces()
    const hydration = spaces[0]!.surfaces[0]!
    vi.mocked(invokeFastAction).mockResolvedValue({
      ...hydration,
      state: { status: 'Needs water', water: true },
      freshness: { updatedAt: '2026-08-16T10:01:00.000Z', updatedBy: 'user' },
    })
    mockReadyApp(spaces)

    render(<App />)

    const checkbox = await screen.findByRole<HTMLInputElement>('checkbox', {
      name: 'Drank water',
    })
    fireEvent.click(checkbox)

    await waitFor(() => expect(checkbox.checked).toBe(true))
    expect(invokeFastAction).toHaveBeenCalledWith(
      'srf-hydration',
      'water',
      'toggle',
      true,
      undefined,
      expect.any(String),
    )
  })

  it('keeps a routed Surface live when a validated patch arrives', async () => {
    window.history.replaceState({}, '', '/app/space/health/surface/srf-hydration')
    mockReadyApp(interactiveHealthSpaces())

    render(<App />)

    expect(await screen.findByText('Needs water')).toBeDefined()
    await waitFor(() => expect(connectGateway).toHaveBeenCalledOnce())
    const handlers = vi.mocked(connectGateway).mock.calls[0]?.[0]
    if (!handlers) throw new Error('Gateway handlers were not registered')

    act(() => {
      handlers.onSurfacePatch(
        SurfacePatchEventSchema.parse({
          cursor: 1,
          at: '2026-08-16T10:01:00.000Z',
          spaceId: 'spc-health',
          patch: {
            surfaceId: 'srf-hydration',
            operations: [{ target: 'state', op: 'replace', path: '/status', value: 'On track' }],
          },
          freshness: { updatedAt: '2026-08-16T10:01:00.000Z', updatedBy: 'agent' },
        }),
      )
    })

    expect(await screen.findByText('On track')).toBeDefined()
    expect(screen.queryByText('Needs water')).toBeNull()
    expect(
      screen.getByRole('button', { name: 'Focus Hydration' }).getAttribute('aria-pressed'),
    ).toBe('true')
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
