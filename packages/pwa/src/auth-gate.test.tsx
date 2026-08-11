// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
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

function AuthGateHarness() {
  const [authenticated, setAuthenticated] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (authenticated) return <p>Authenticated</p>

  return (
    <AuthGate
      bootstrapRequired
      passkeyRegistered={false}
      error={error}
      onAuthenticated={() => setAuthenticated(true)}
      onError={setError}
    />
  )
}

describe('AuthGate first-boot code', () => {
  it('keeps the setup code in the URL after passkey registration fails', async () => {
    window.history.replaceState({}, '', '/setup?code=first-boot-code')
    vi.mocked(registerPasskey).mockRejectedValue(
      new Error('The operation either timed out or was not allowed.'),
    )

    render(<AuthGateHarness />)
    fireEvent.click(screen.getByRole('button', { name: 'Register passkey' }))

    expect((await screen.findByRole('alert')).textContent).toBe(
      'The operation either timed out or was not allowed.',
    )
    expect(window.location.search).toBe('?code=first-boot-code')
  })

  it('removes the setup code from the URL after passkey registration succeeds', async () => {
    window.history.replaceState({}, '', '/setup?code=first-boot-code')
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

    render(<AuthGateHarness />)
    fireEvent.click(screen.getByRole('button', { name: 'Register passkey' }))

    expect(await screen.findByText('Authenticated')).toBeDefined()
    expect(window.location.search).toBe('')
  })
})
