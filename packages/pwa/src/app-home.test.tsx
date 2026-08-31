// @vitest-environment jsdom
import {
  SYSTEM_SPACE_ID,
  SurfaceArchivedEventSchema,
  SurfaceCreatedEventSchema,
  type OnboardingStatus,
} from '@veduta/protocol'
import { fromPartial } from '@total-typescript/shoehorn'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ApiModule from './api.ts'
import {
  appTestSurface,
  authStatus,
  connectedModelConnectionsSnapshot,
  installAppTestBrowser,
  resetAppTestBrowser,
} from './app-test-support.ts'
import { saveSnapshot } from './home-state.ts'
import { HOME_CACHE_KEY } from './pwa-storage.ts'

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
} from './api.ts'

beforeEach(() => {
  installAppTestBrowser()
})

afterEach(resetAppTestBrowser)

describe('App Home', () => {
  it('keeps the product wordmark free of environment implementation details', async () => {
    vi.mocked(fetchAuthStatus).mockResolvedValue(authStatus({ mode: 'dev' }))
    vi.mocked(fetchSpaces).mockResolvedValue({
      surfaceCursor: 0,
      spaces: [
        {
          id: SYSTEM_SPACE_ID,
          slug: 'system',
          name: 'System',
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

    const banner = await screen.findByRole('banner')
    expect(within(banner).getByRole('heading', { name: 'Veduta' })).toBeDefined()
    expect(within(banner).queryByText('Loopback profile')).toBeNull()
    expect(within(banner).queryByText('Passkey session')).toBeNull()
  })

  it('renders metadata-only Space cards that converge on live Surface lifecycle', async () => {
    vi.mocked(fetchAuthStatus).mockResolvedValue(authStatus({ mode: 'dev' }))
    vi.mocked(fetchSpaces).mockResolvedValue({
      surfaceCursor: 0,
      spaces: [
        {
          id: SYSTEM_SPACE_ID,
          slug: 'maintenance',
          name: 'Maintenance',
          archived: false,
          attention: 0,
          attentionRevision: 0,
          surfaces: [],
        },
        {
          id: 'spc-health',
          slug: 'health',
          name: 'Health',
          archived: false,
          attention: 1,
          attentionRevision: 1,
          surfaces: [
            {
              ...appTestSurface('srf-overview', 'Overview'),
              tree: { id: 'root', type: 'Title', props: { text: 'Private Surface detail' } },
              freshness: { updatedAt: '2026-08-21T09:00:00.000Z', updatedBy: 'agent' },
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

    const home = await screen.findByRole('main', { name: 'Home' })
    const groups = within(home).getAllByRole('region')
    expect(groups.map((group) => group.getAttribute('aria-label'))).toEqual([
      'Your Spaces',
      'System',
    ])
    const healthCard = within(home).getByRole('link', { name: /Health/ })
    expect(healthCard.getAttribute('href')).toBe('/app/space/health')
    expect(healthCard.textContent).toContain('1 Surface')
    expect(healthCard.querySelector('time')?.getAttribute('datetime')).toBe(
      '2026-08-21T09:00:00.000Z',
    )
    expect(within(home).queryByText('Private Surface detail')).toBeNull()
    expect(within(home).queryByRole('button', { name: 'Focus Overview' })).toBeNull()

    await waitFor(() => expect(connectGateway).toHaveBeenCalledOnce())
    const handlers = vi.mocked(connectGateway).mock.calls[0]?.[0]
    if (!handlers) throw new Error('Gateway handlers were not registered')

    const created = SurfaceCreatedEventSchema.parse({
      cursor: 1,
      at: '2026-08-21T10:00:00.000Z',
      spaceId: 'spc-health',
      surface: {
        ...appTestSurface('srf-new', 'New Surface'),
        tree: { id: 'root', type: 'Title', props: { text: 'New private detail' } },
        freshness: { updatedAt: '2026-08-21T10:00:00.000Z', updatedBy: 'agent' },
      },
      order: {
        cursor: 1,
        spaceId: 'spc-health',
        pinnedSurfaceIds: [],
        regularSurfaceIds: ['srf-overview', 'srf-new'],
      },
    })

    act(() => handlers.onSurfaceCreated({ type: 'surface.created', event: created }))

    expect(within(home).getByRole('link', { name: /Health/ }).textContent).toContain('2 Surfaces')
    expect(
      within(home)
        .getByRole('link', { name: /Health/ })
        .querySelector('time')
        ?.getAttribute('datetime'),
    ).toBe('2026-08-21T10:00:00.000Z')
    expect(within(home).queryByText('New private detail')).toBeNull()

    const archived = SurfaceArchivedEventSchema.parse({
      cursor: 2,
      at: '2026-08-21T10:01:00.000Z',
      spaceId: 'spc-health',
      surfaceId: 'srf-new',
      order: {
        cursor: 2,
        spaceId: 'spc-health',
        pinnedSurfaceIds: [],
        regularSurfaceIds: ['srf-overview'],
      },
    })

    act(() => handlers.onSurfaceArchived(archived))

    expect(within(home).getByRole('link', { name: /Health/ }).textContent).toContain('1 Surface')
    expect(
      within(home)
        .getByRole('link', { name: /Health/ })
        .querySelector('time')
        ?.getAttribute('datetime'),
    ).toBe('2026-08-21T09:00:00.000Z')
  })

  it('keeps a protocol-valid cached Home visible when the Gateway is offline', async () => {
    saveSnapshot(localStorage, HOME_CACHE_KEY, {
      surfaceCursor: 4,
      spaces: [
        {
          id: SYSTEM_SPACE_ID,
          slug: 'system',
          name: 'Veduta',
          archived: false,
          attention: 0,
          attentionRevision: 0,
          surfaces: [],
        },
        {
          id: 'spc-health',
          slug: 'health',
          name: 'Health',
          archived: false,
          attention: 0,
          attentionRevision: 0,
          surfaces: [appTestSurface('srf-cached', 'Cached Surface')],
        },
      ],
    })
    vi.mocked(fetchAuthStatus).mockRejectedValue(new Error('Gateway unavailable'))
    vi.mocked(fetchModelConnections).mockResolvedValue(connectedModelConnectionsSnapshot())

    render(<App />)

    expect(await screen.findByRole('link', { name: /Health/ })).toBeDefined()
    expect(screen.getByRole('alert').textContent).toContain('Offline: showing cached Home')
    expect(screen.queryByRole('button', { name: 'Focus Cached Surface' })).toBeNull()
  })

  it('shows loading while the first valid snapshot is in flight', async () => {
    let resolveSpaces: ((snapshot: Awaited<ReturnType<typeof fetchSpaces>>) => void) | undefined
    vi.mocked(fetchAuthStatus).mockResolvedValue(authStatus({ mode: 'dev' }))
    vi.mocked(fetchSpaces).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSpaces = resolve
        }),
    )
    vi.mocked(fetchOnboardingStatus).mockResolvedValue(
      fromPartial<OnboardingStatus>({ required: false, completed: true }),
    )
    vi.mocked(fetchModelConnections).mockResolvedValue(connectedModelConnectionsSnapshot())

    render(<App />)

    expect(await screen.findByRole('status', { name: 'Loading Spaces' })).toBeDefined()

    await act(async () =>
      resolveSpaces?.({
        surfaceCursor: 0,
        spaces: [
          {
            id: SYSTEM_SPACE_ID,
            slug: 'system',
            name: 'Veduta',
            archived: false,
            attention: 0,
            attentionRevision: 0,
            surfaces: [],
          },
        ],
      }),
    )

    expect(
      await screen.findByRole('region', { name: 'Create your first Space from chat' }),
    ).toBeDefined()
  })

  it('recovers a malformed local cache by retrying the validated Gateway snapshot', async () => {
    localStorage.setItem(HOME_CACHE_KEY, '{malformed')
    vi.mocked(fetchAuthStatus).mockResolvedValue(authStatus({ mode: 'dev' }))
    vi.mocked(fetchSpaces)
      .mockRejectedValueOnce(new Error('Gateway unavailable'))
      .mockResolvedValueOnce({
        surfaceCursor: 1,
        spaces: [
          {
            id: SYSTEM_SPACE_ID,
            slug: 'system',
            name: 'Veduta',
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

    expect(await screen.findByRole('heading', { name: 'Spaces unavailable' })).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: 'Retry loading Spaces' }))

    expect(
      await screen.findByRole('region', { name: 'Create your first Space from chat' }),
    ).toBeDefined()
    expect(fetchSpaces).toHaveBeenCalledTimes(2)
    expect(localStorage.getItem(HOME_CACHE_KEY)).not.toBe('{malformed')
  })
})
