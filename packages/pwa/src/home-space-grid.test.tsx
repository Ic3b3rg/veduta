// @vitest-environment jsdom
import { SYSTEM_SPACE_ID, type Surface } from '@veduta/protocol'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SpaceWithSurfaces } from './api.ts'
import { HomeSpaceGrid, type HomeSpacesLoadState } from './home-space-grid.tsx'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('HomeSpaceGrid', () => {
  it('renders metadata-only user cards before the generic canonical System card', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-21T10:00:00.000Z'))
    const health = space('spc-health', 'health', 'Health', [
      surface(
        'srf-meals',
        'spc-health',
        '2026-08-21T09:30:00.000Z',
        'Atom content must stay hidden',
      ),
      surface('srf-water', 'spc-health', '2026-08-21T09:45:00.000Z'),
    ])
    const userNamedSystem = space('spc-user-system', 'personal-system', 'System')
    const canonicalSystem = {
      ...space(SYSTEM_SPACE_ID, 'maintenance', 'Maintenance'),
      attention: 3,
    }

    renderGrid([canonicalSystem, health, userNamedSystem])

    const groups = screen.getAllByRole('region')
    expect(groups.map((group) => group.getAttribute('aria-label'))).toEqual([
      'Your Spaces',
      'System',
    ])

    const userGroup = screen.getByRole('region', { name: 'Your Spaces' })
    const systemGroup = screen.getByRole('region', { name: 'System' })
    expect(
      within(userGroup)
        .getAllByRole('link')
        .map((link) => link.querySelector('h3')?.textContent),
    ).toEqual(['Health', 'System'])
    expect(
      within(systemGroup)
        .getAllByRole('link')
        .map((link) => link.querySelector('h3')?.textContent),
    ).toEqual(['Maintenance'])

    const healthCard = within(userGroup).getByRole('link', { name: /Health/ })
    expect(healthCard.getAttribute('href')).toBe('/app/space/health')
    expect(healthCard.textContent).toContain('2 Surfaces')
    expect(healthCard.textContent).toContain('15m ago')
    expect(healthCard.querySelector('time')?.getAttribute('datetime')).toBe(
      '2026-08-21T09:45:00.000Z',
    )
    expect(healthCard.querySelector('[data-space-description-slot]')?.textContent).toBe('')
    expect(screen.queryByText('Atom content must stay hidden')).toBeNull()

    const systemCard = within(systemGroup).getByRole('link', { name: /Maintenance/ })
    expect(systemCard.className).toBe(healthCard.className)
    expect(within(systemCard).getByLabelText('3 updates')).toBeDefined()
  })

  it('uses a native link so click and keyboard activation target the matching Space route', () => {
    renderGrid([space('spc-health', 'health', 'Health')], 'ready', vi.fn(), true)

    const card = screen.getByRole('link', { name: /Health/ })
    expect(card.tagName).toBe('A')
    card.focus()
    expect(document.activeElement).toBe(card)

    fireEvent.click(card)

    expect(screen.getByRole('heading', { name: 'Health route' })).toBeDefined()
  })

  it('invites a first user Space above the System group when System is the only Space', () => {
    renderGrid([space(SYSTEM_SPACE_ID, 'system', 'Veduta')])

    const invitation = screen.getByRole('region', { name: 'Create your first Space from chat' })
    const systemGroup = screen.getByRole('region', { name: 'System' })
    expect(invitation.compareDocumentPosition(systemGroup) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    )
    expect(screen.queryByRole('region', { name: 'Your Spaces' })).toBeNull()
  })

  it('keeps loading, failed, empty, and missing-System paths visible and retryable', () => {
    const onRetry = vi.fn()
    const { rerender } = render(
      <MemoryRouter>
        <HomeSpaceGrid spaces={[]} loadState="loading" onRetry={onRetry} />
      </MemoryRouter>,
    )

    expect(screen.getByRole('status', { name: 'Loading Spaces' }).getAttribute('aria-busy')).toBe(
      'true',
    )

    rerender(
      <MemoryRouter>
        <HomeSpaceGrid spaces={[]} loadState="error" onRetry={onRetry} />
      </MemoryRouter>,
    )
    expect(screen.getByRole('heading', { name: 'Spaces unavailable' })).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: 'Retry loading Spaces' }))
    expect(onRetry).toHaveBeenCalledOnce()

    rerender(
      <MemoryRouter>
        <HomeSpaceGrid spaces={[]} loadState="ready" onRetry={onRetry} />
      </MemoryRouter>,
    )
    expect(screen.getByRole('heading', { name: 'No active Spaces' })).toBeDefined()

    rerender(
      <MemoryRouter>
        <HomeSpaceGrid
          spaces={[space('spc-health', 'health', 'Health')]}
          loadState="ready"
          onRetry={onRetry}
        />
      </MemoryRouter>,
    )
    expect(screen.getByRole('link', { name: /Health/ })).toBeDefined()
    expect(screen.getByRole('heading', { name: 'System Space unavailable' })).toBeDefined()
  })
})

function renderGrid(
  spaces: SpaceWithSurfaces[],
  loadState: HomeSpacesLoadState = 'ready',
  onRetry = vi.fn(),
  withRoute = false,
) {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <Routes>
        <Route
          path="/"
          element={<HomeSpaceGrid spaces={spaces} loadState={loadState} onRetry={onRetry} />}
        />
        {withRoute && <Route path="/app/space/health" element={<h2>Health route</h2>} />}
      </Routes>
    </MemoryRouter>,
  )
}

function space(
  id: string,
  slug: string,
  name: string,
  surfaces: Surface[] = [],
): SpaceWithSurfaces {
  return {
    id,
    slug,
    name,
    archived: false,
    surfaces,
    attention: 0,
    attentionRevision: 0,
  }
}

function surface(id: string, spaceId: string, updatedAt: string, hiddenText = id): Surface {
  return {
    id,
    spaceId,
    title: id,
    tree: { id: `${id}-root`, type: 'Text', props: { text: hiddenText } },
    state: {},
    freshness: { updatedAt, updatedBy: 'agent' },
    pinned: false,
    pinnable: true,
  }
}
