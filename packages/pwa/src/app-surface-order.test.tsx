// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { fromPartial } from '@total-typescript/shoehorn'
import type { OnboardingStatus } from '@veduta/protocol'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type * as ApiModule from './api.ts'
import {
  appTestSurface,
  authStatus,
  connectedModelConnectionsSnapshot,
  installAppTestBrowser,
  resetAppTestBrowser,
} from './app-test-support.ts'

vi.mock('./api.ts', async (importOriginal) => {
  const { createAppApiMock } = await import('./app-test-support.ts')
  return { ...createAppApiMock(await importOriginal<typeof ApiModule>()), pinSurface: vi.fn() }
})

import { App } from './app.tsx'
import {
  connectGateway,
  fetchAuthStatus,
  fetchSpaces,
  fetchOnboardingStatus,
  fetchModelConnections,
  pinSurface,
} from './api.ts'

beforeEach(() => {
  installAppTestBrowser()
})
afterEach(resetAppTestBrowser)

it('exposes Surface-scoped pending, failure, offline refusal and explicit reconnect retry', async () => {
  const first = appTestSurface('srf-first', 'First')
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
        surfaces: [first, appTestSurface('srf-second', 'Second')],
      },
    ],
  })
  vi.mocked(fetchOnboardingStatus).mockResolvedValue(
    fromPartial<OnboardingStatus>({ required: false, completed: true }),
  )
  vi.mocked(fetchModelConnections).mockResolvedValue(connectedModelConnectionsSnapshot())
  let reject!: (reason: Error) => void
  vi.mocked(pinSurface).mockReturnValue(
    new Promise((_resolve, failed) => {
      reject = failed
    }),
  )
  render(<App />)
  await waitFor(() => expect(connectGateway).toHaveBeenCalledOnce())
  act(() => vi.mocked(connectGateway).mock.calls[0]![0].onHello(0, 'client-order'))
  const pin = await screen.findByRole('button', { name: 'Pin First' })
  fireEvent.click(pin)
  fireEvent.click(pin)
  expect(pinSurface).toHaveBeenCalledOnce()
  expect(pin).toHaveProperty('disabled', true)
  expect(pin.getAttribute('aria-pressed')).toBe('false')
  expect(screen.getByRole('button', { name: 'Move First down' })).toHaveProperty('disabled', true)
  expect(screen.getByRole('button', { name: 'Pin Second' })).toHaveProperty('disabled', false)
  expect(screen.getByRole('button', { name: 'Focus First' })).toHaveProperty('disabled', false)
  expect(screen.getByText('Pin "First" in progress…').getAttribute('role')).toBe('status')
  expect(screen.queryByRole('heading', { name: /^Pinned \(/ })).toBeNull()
  await act(async () => {
    reject(new Error('request refused'))
    await Promise.resolve()
  })
  expect(screen.getByRole('alert').textContent).toBe('Pin "First" failed: request refused')
  expect(pin).toHaveProperty('disabled', false)
  expect(screen.queryByRole('heading', { name: /^Pinned \(/ })).toBeNull()
  act(() => vi.mocked(connectGateway).mock.calls[0]![0].onClose())
  expect(pin).toHaveProperty('disabled', true)
  expect(screen.getByRole('button', { name: 'Pin Second' })).toHaveProperty('disabled', true)
  expect(screen.getByText('Pin and Move are unavailable while offline.').getAttribute('role')).toBe(
    'status',
  )
  fireEvent.click(pin)
  expect(pinSurface).toHaveBeenCalledOnce()
  await waitFor(() => expect(connectGateway).toHaveBeenCalledTimes(2), { timeout: 3000 })
  act(() => vi.mocked(connectGateway).mock.calls[1]![0].onHello(0, 'client-order'))
  expect(pin).toHaveProperty('disabled', false)
  expect(pinSurface).toHaveBeenCalledOnce()
  vi.mocked(pinSurface).mockResolvedValue({
    changed: true,
    surface: { ...first, pinned: true },
    order: {
      cursor: 1,
      spaceId: 'spc-health',
      pinnedSurfaceIds: [first.id],
      regularSurfaceIds: ['srf-second'],
    },
  })
  fireEvent.click(pin)
  await screen.findByRole('heading', { name: 'Pinned (1)' })
  expect(pinSurface).toHaveBeenCalledTimes(2)
  expect(screen.queryByRole('alert')).toBeNull()
  expect(
    within(screen.getByRole('main', { name: 'Health Space' })).getAllByRole('article'),
  ).toHaveLength(2)
})
