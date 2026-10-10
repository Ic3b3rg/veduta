import { useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { loginWithPasskey, registerPasskey } from './api.ts'
import { defaultDeviceName } from './pwa-storage.ts'

export function AuthGate({
  bootstrapRequired,
  passkeyRegistered,
  error,
  onAuthenticated,
  onError,
  onCancel,
}: {
  bootstrapRequired: boolean
  passkeyRegistered: boolean
  error: string | null
  onAuthenticated: (token: string) => void
  onError: (message: string) => void
  onCancel?: () => void
}) {
  const location = useLocation()
  const navigate = useNavigate()
  const [oneTimeCode, setOneTimeCode] = useState(
    () => new URLSearchParams(location.search).get('code') ?? '',
  )
  const [deviceName, setDeviceName] = useState(defaultDeviceName())
  const [busy, setBusy] = useState(false)
  const [pairing, setPairing] = useState(
    () => location.pathname === '/setup' && new URLSearchParams(location.search).has('code'),
  )
  const showRegistration = bootstrapRequired || pairing

  const run = async (fn: () => Promise<{ token: string }>) => {
    setBusy(true)
    try {
      const session = await fn()
      const searchParams = new URLSearchParams(location.search)
      if (searchParams.has('code')) {
        searchParams.delete('code')
        navigate(
          { pathname: location.pathname, search: searchParams.toString(), hash: location.hash },
          { replace: true },
        )
      }
      onAuthenticated(session.token)
    } catch (e) {
      onError(
        e instanceof Error && e.name === 'NotAllowedError'
          ? showRegistration
            ? 'Passkey registration was cancelled or timed out. Try again on this device.'
            : 'No passkey was selected. Try again, or link this device from a browser where you are already signed in.'
          : e instanceof Error
            ? e.message
            : 'Passkey authentication failed. Please try again.',
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="auth-shell">
      <h1>Veduta</h1>
      {onCancel && (
        <button type="button" disabled={busy} onClick={onCancel}>
          Keep my current access
        </button>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="auth-form">
        <label htmlFor="device-name">Device name</label>
        <input
          id="device-name"
          value={deviceName}
          onChange={(e) => setDeviceName(e.target.value)}
        />
        {showRegistration && (
          <>
            <label htmlFor="one-time-code">One-time code</label>
            <input
              id="one-time-code"
              value={oneTimeCode}
              onChange={(e) => setOneTimeCode(e.target.value)}
            />
          </>
        )}
        {showRegistration && (
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              run(() =>
                registerPasskey({
                  oneTimeCode,
                  deviceName: deviceName.trim(),
                }),
              )
            }
          >
            Register passkey
          </button>
        )}
        {passkeyRegistered && !showRegistration && (
          <button
            type="button"
            disabled={busy}
            onClick={() => run(() => loginWithPasskey(deviceName.trim()))}
          >
            Sign in with passkey
          </button>
        )}
        {passkeyRegistered && (
          <>
            <p>
              To add a phone or another computer, open Connections → Devices on a browser where you
              are already signed in. Choose Link a device and scan the QR code here to create a
              passkey for this device.
            </p>
            <button type="button" disabled={busy} onClick={() => setPairing(!pairing)}>
              {pairing ? 'Use an existing passkey' : 'Enter a device linking code'}
            </button>
          </>
        )}
      </div>
    </main>
  )
}
