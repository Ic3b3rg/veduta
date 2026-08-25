// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it } from 'vitest'
import { ClientRouteTable, clientPath, useClientRouting } from './client-router.tsx'

afterEach(cleanup)

function RoutingProbe() {
  const { spaceSlug, surfaceId } = useClientRouting()
  return (
    <output aria-label="Route parameters">
      {JSON.stringify({ spaceSlug: spaceSlug ?? null, surfaceId: surfaceId ?? null })}
    </output>
  )
}

function renderRoute(path: string) {
  render(
    <MemoryRouter initialEntries={[path]}>
      <RoutingProbe />
      <ClientRouteTable
        home={<p>Home screen</p>}
        modelConnections={<p>Model connections screen</p>}
      />
    </MemoryRouter>,
  )
}

describe('client route table', () => {
  it.each([
    ['/', 'Home screen'],
    ['/setup', 'Home screen'],
    ['/app/settings/models', 'Model connections screen'],
    ['/app/space/health', 'Home screen'],
    ['/app/space/health/surface/srf-meals', 'Home screen'],
  ])('renders the fixed screen for %s', async (path, screenName) => {
    renderRoute(path)

    expect(await screen.findByText(screenName)).toBeDefined()
  })

  it.each([
    ['/app/space/health', { spaceSlug: 'health', surfaceId: null }],
    ['/app/space/health/surface/srf-meals', { spaceSlug: 'health', surfaceId: 'srf-meals' }],
  ])('derives route parameters from %s', async (path, expected) => {
    renderRoute(path)

    await waitFor(() =>
      expect(screen.getByLabelText('Route parameters').textContent).toBe(JSON.stringify(expected)),
    )
  })

  it('builds encoded Space and Surface paths from the route contract', () => {
    expect(clientPath.space('health records')).toBe('/app/space/health%20records')
    expect(clientPath.surface('health records', 'srf/meals')).toBe(
      '/app/space/health%20records/surface/srf%2Fmeals',
    )
  })
})
