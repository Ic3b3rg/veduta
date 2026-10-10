// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { BrowserRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('./api.ts', () => ({
  loginWithPasskey: vi.fn(),
  registerPasskey: vi.fn(),
}))

import { registerPasskey } from './api.ts'
import { AuthGate } from './auth-gate.tsx'

afterEach(() => {
  cleanup()
  window.history.replaceState({}, '', '/')
  vi.resetAllMocks()
})

function AuthGateHarness({ bootstrapRequired = true }: { bootstrapRequired?: boolean }) {
  const [authenticated, setAuthenticated] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (authenticated) return <p>Authenticated</p>

  return (
    <AuthGate
      bootstrapRequired={bootstrapRequired}
      passkeyRegistered={!bootstrapRequired}
      error={error}
      onAuthenticated={() => setAuthenticated(true)}
      onError={setError}
    />
  )
}

function renderAuthGate(bootstrapRequired = true) {
  render(
    <BrowserRouter>
      <AuthGateHarness bootstrapRequired={bootstrapRequired} />
    </BrowserRouter>,
  )
}

describe('AuthGate first-boot code', () => {
  it('offers registration on a pairing link after another device registered the first passkey', async () => {
    window.history.replaceState({}, '', '/setup?code=phone-pairing-code')
    vi.mocked(registerPasskey).mockResolvedValue({
      token: 'vdt_tok_phone',
      device: {
        id: 'dev-phone',
        name: 'Phone',
        credentialId: 'credential-phone',
        createdAt: '2026-10-08T00:00:00.000Z',
      },
    })
    renderAuthGate(false)
    fireEvent.change(screen.getByLabelText('Device name'), { target: { value: 'Phone' } })
    fireEvent.click(screen.getByRole('button', { name: 'Register passkey' }))
    expect(await screen.findByText('Authenticated')).toBeDefined()
    expect(registerPasskey).toHaveBeenCalledWith({
      oneTimeCode: 'phone-pairing-code',
      deviceName: 'Phone',
    })
    expect(window.location.search).toBe('')
  })

  it('keeps the setup code in the URL after passkey registration fails', async () => {
    window.history.replaceState({}, '', '/setup?code=first-boot-code')
    vi.mocked(registerPasskey).mockRejectedValue(
      new Error('The operation either timed out or was not allowed.'),
    )

    renderAuthGate()
    fireEvent.click(screen.getByRole('button', { name: 'Register passkey' }))

    expect((await screen.findByRole('alert')).textContent).toBe(
      'The operation either timed out or was not allowed.',
    )
    expect(window.location.search).toBe('?code=first-boot-code')
  })

  it('removes the setup code from the URL after passkey registration succeeds', async () => {
    window.history.replaceState({}, '', '/setup?code=first-boot-code&next=home#finish')
    vi.mocked(registerPasskey).mockResolvedValue({
      token: 'vdt_tok_registered',
      device: {
        id: 'dev-1',
        name: 'Computer',
        credentialId: 'credential-1',
        createdAt: '2026-08-10T14:00:00.000Z',
        lastSeenAt: '2026-08-10T14:00:00.000Z',
      },
    })

    renderAuthGate()
    fireEvent.click(screen.getByRole('button', { name: 'Register passkey' }))

    expect(await screen.findByText('Authenticated')).toBeDefined()
    expect(window.location.pathname + window.location.search + window.location.hash).toBe(
      '/setup?next=home#finish',
    )
  })
})
