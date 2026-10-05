// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, expect, it, vi } from 'vitest'

afterEach(() => {
  cleanup()
  vi.doUnmock('./connections-page.tsx')
  vi.restoreAllMocks()
  vi.resetModules()
})

it('keeps the requested section while the Connections chunk loads', async () => {
  type LoadedModule = {
    ConnectionsPage: (props: { initialSection?: string }) => React.ReactNode
  }
  let resolveModule: (value: LoadedModule) => void = () => {}
  const module = new Promise<LoadedModule>((resolve) => {
    resolveModule = resolve
  })
  vi.doMock('./connections-page.tsx', () => module)
  const { ConnectionsRoute } = await import('./connections-route.tsx')
  render(
    <MemoryRouter>
      <ConnectionsRoute spaces={[]} initialSection="models" />
    </MemoryRouter>,
  )
  expect(screen.getByRole('status').textContent).toContain('Loading Connections')
  await act(async () => {
    resolveModule({ ConnectionsPage: ({ initialSection }) => <h1>{initialSection}</h1> })
  })
  expect(await screen.findByRole('heading', { name: 'models' })).toBeTruthy()
  expect(screen.queryByRole('status')).toBeNull()
})

it('offers reload and a working return to Home after a Connections chunk fails', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.doMock('./connections-page.tsx', () => {
    throw new Error('Chunk unavailable')
  })
  const { ConnectionsRoute } = await import('./connections-route.tsx')
  render(
    <MemoryRouter initialEntries={['/app/connections']}>
      <Routes>
        <Route path="/app/connections" element={<ConnectionsRoute spaces={[]} />} />
        <Route path="/" element={<h1>Veduta Home</h1>} />
      </Routes>
    </MemoryRouter>,
  )
  expect((await screen.findByRole('alert')).textContent).toContain('Connections could not load')
  expect(screen.getByRole('button', { name: 'Reload Connections' })).toBeTruthy()
  fireEvent.click(screen.getByRole('link', { name: 'Back to Veduta' }))
  expect(await screen.findByRole('heading', { name: 'Veduta Home' })).toBeTruthy()
})
