// @vitest-environment jsdom
import { GMAIL_READ_SCOPE, type GmailConnectionsSnapshot } from '@veduta/protocol'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SettingsGmailConnections } from './settings-gmail-connections.tsx'

const api = vi.hoisted(() => ({
  fetch: vi.fn(),
  create: vi.fn(),
  begin: vi.fn(),
  complete: vi.fn(),
  fail: vi.fn(),
  verify: vi.fn(),
  rename: vi.fn(),
  remove: vi.fn(),
}))

vi.mock('./gmail-connections-api.ts', () => ({
  fetchGmailConnections: api.fetch,
  createGmailConnection: api.create,
  beginGmailAuthorization: api.begin,
  completeGmailAuthorization: api.complete,
  failGmailAuthorization: api.fail,
  verifyLegacyGmailConnection: api.verify,
  renameGmailConnection: api.rename,
  removeGmailConnection: api.remove,
}))

const empty: GmailConnectionsSnapshot = { connections: [] }
const ready: GmailConnectionsSnapshot = {
  connections: [
    {
      id: 'svc-gmail-example',
      name: 'Personal',
      accountEmail: 'user@gmail.test',
      state: 'ready',
      scopes: [GMAIL_READ_SCOPE],
      createdAt: '2026-10-01T10:00:00.000Z',
      updatedAt: '2026-10-01T10:00:00.000Z',
    },
  ],
}

beforeEach(() => {
  vi.resetAllMocks()
  api.fetch.mockResolvedValue(empty)
  api.create.mockResolvedValue(ready)
  api.complete.mockResolvedValue(ready)
  window.history.replaceState(null, '', '/app/settings/gmail')
})

afterEach(cleanup)

describe('Gmail connection settings', () => {
  it('creates a passive connection without displaying or retaining its secret', async () => {
    render(<SettingsGmailConnections token="session" onBack={() => {}} />)
    expect(await screen.findByText('No Gmail account connected yet.')).toBeDefined()
    fireEvent.change(screen.getByLabelText('Connection name'), { target: { value: 'Personal' } })
    fireEvent.change(screen.getByLabelText('OAuth client ID'), { target: { value: 'client-id' } })
    fireEvent.change(screen.getByLabelText('OAuth client secret'), {
      target: { value: 'private-value' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Add account' }))

    await waitFor(() =>
      expect(api.create).toHaveBeenCalledWith(
        { name: 'Personal', clientId: 'client-id', clientSecret: 'private-value' },
        'session',
      ),
    )
    expect(await screen.findByText('user@gmail.test · Read-only mail access')).toBeDefined()
    expect((screen.getByLabelText('OAuth client secret') as HTMLInputElement).value).toBe('')
    expect(document.body.textContent).not.toContain('private-value')
  })

  it('scrubs the OAuth code from history before submitting it', async () => {
    window.history.replaceState(
      null,
      '',
      '/app/settings/gmail?code=one-time-code&state=svc-gmail-example.random-state',
    )
    render(<SettingsGmailConnections token="session" onBack={() => {}} />)
    await waitFor(() =>
      expect(api.complete).toHaveBeenCalledWith(
        'svc-gmail-example',
        'one-time-code',
        'svc-gmail-example.random-state',
        'session',
      ),
    )
    expect(window.location.search).toBe('')
    expect(await screen.findByText('user@gmail.test · Read-only mail access')).toBeDefined()
  })
})
