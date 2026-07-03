import { useState } from 'react'
import { loginWithPasskey, registerPasskey } from './api.ts'
import { defaultDeviceName, readSetupCode } from './pwa-storage.ts'

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
  const [oneTimeCode, setOneTimeCode] = useState(readSetupCode())
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
              run(() => registerPasskey({ oneTimeCode, deviceName: deviceName.trim() }))
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
