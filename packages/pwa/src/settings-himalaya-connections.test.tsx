// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SettingsHimalayaConnections } from './settings-himalaya-connections.tsx'

const api = vi.hoisted(() => ({
  fetch: vi.fn(),
  create: vi.fn(),
  complete: vi.fn(),
  verify: vi.fn(),
  install: vi.fn(),
  rename: vi.fn(),
  remove: vi.fn(),
}))

vi.mock('./himalaya-connections-api.ts', () => ({
  fetchHimalayaConnections: api.fetch,
  createHimalayaConnection: api.create,
  completeLegacyHimalayaConnection: api.complete,
  verifyHimalayaConnection: api.verify,
  installHimalaya: api.install,
  renameHimalayaConnection: api.rename,
  removeHimalayaConnection: api.remove,
}))

beforeEach(() => {
  vi.resetAllMocks()
  api.fetch.mockResolvedValue({ connections: [] })
  api.create.mockResolvedValue({
    connections: [
      {
        id: 'svc-himalaya-example',
        name: 'Work',
        address: 'work@example.test',
        imapServer: 'imaps://imap.example.test:993',
        smtpServer: 'smtps://smtp.example.test:465',
        state: 'needs_verification',
        createdAt: '2026-10-01T10:00:00.000Z',
        updatedAt: '2026-10-01T10:00:00.000Z',
      },
    ],
  })
})

afterEach(cleanup)

describe('IMAP and SMTP connection settings', () => {
  it('collects credentials in the authenticated form then clears password fields', async () => {
    render(<SettingsHimalayaConnections token="session" onBack={() => {}} />)
    expect(await screen.findByText('No IMAP or SMTP account connected yet.')).toBeDefined()
    fireEvent.change(screen.getByLabelText('Connection name'), { target: { value: 'Work' } })
    fireEvent.change(screen.getByLabelText('Email address'), {
      target: { value: 'work@example.test' },
    })
    fireEvent.change(screen.getByLabelText('IMAP server URL'), {
      target: { value: 'imaps://imap.example.test:993' },
    })
    fireEvent.change(screen.getByLabelText('IMAP username'), {
      target: { value: 'work@example.test' },
    })
    fireEvent.change(screen.getByLabelText('IMAP password'), { target: { value: 'imap-private' } })
    fireEvent.change(screen.getByLabelText('SMTP server URL'), {
      target: { value: 'smtps://smtp.example.test:465' },
    })
    fireEvent.change(screen.getByLabelText('SMTP username'), {
      target: { value: 'work@example.test' },
    })
    fireEvent.change(screen.getByLabelText('SMTP password'), { target: { value: 'smtp-private' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add Mailbox' }))
    await waitFor(() =>
      expect(api.create).toHaveBeenCalledWith(
        {
          name: 'Work',
          address: 'work@example.test',
          imapServer: 'imaps://imap.example.test:993',
          imapUsername: 'work@example.test',
          imapPassword: 'imap-private',
          smtpServer: 'smtps://smtp.example.test:465',
          smtpUsername: 'work@example.test',
          smtpPassword: 'smtp-private',
        },
        'session',
      ),
    )
    expect((screen.getByLabelText('IMAP password') as HTMLInputElement).value).toBe('')
    expect((screen.getByLabelText('SMTP password') as HTMLInputElement).value).toBe('')
    expect(document.body.textContent).not.toContain('imap-private')
    expect(document.body.textContent).not.toContain('smtp-private')
    expect(await screen.findByText(/work@example.test.*imap.example.test/)).toBeDefined()
  })
})
