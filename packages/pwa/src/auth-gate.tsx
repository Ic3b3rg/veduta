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
}: {
  bootstrapRequired: boolean
  passkeyRegistered: boolean
  error: string | null
  onAuthenticated: (token: string) => void
  onError: (message: string) => void
}) {
  const location = useLocation()
  const navigate = useNavigate()
  const [oneTimeCode, setOneTimeCode] = useState(
    () => new URLSearchParams(location.search).get('code') ?? '',
  )
  const [deviceName, setDeviceName] = useState(defaultDeviceName())
  const [busy, setBusy] = useState(false)

  const run = async (fn: () => Promise<{ token: string }>) => {
    setBusy(true)
    try {
      const session = await fn()
      onAuthenticated(session.token)
    } catch (e) {
      onError(e instanceof Error ? e.message : 'passkey authentication failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="auth-shell">
      <h1>Veduta</h1>
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
        {bootstrapRequired && (
          <>
            <label htmlFor="one-time-code">One-time code</label>
            <input
              id="one-time-code"
              value={oneTimeCode}
              onChange={(e) => setOneTimeCode(e.target.value)}
            />
          </>
        )}
        {bootstrapRequired && (
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              run(async () => {
                const session = await registerPasskey({
                  oneTimeCode,
                  deviceName: deviceName.trim(),
                })
                const searchParams = new URLSearchParams(location.search)
                searchParams.delete('code')
                navigate(
                  {
                    pathname: location.pathname,
                    search: searchParams.toString(),
                    hash: location.hash,
                  },
                  { replace: true },
                )
                return session
              })
            }
          >
            Register passkey
          </button>
        )}
        {passkeyRegistered && (
          <button
            type="button"
            disabled={busy}
            onClick={() => run(() => loginWithPasskey(deviceName.trim()))}
          >
            Sign in with passkey
          </button>
        )}
      </div>
    </main>
  )
}
