import {
  GMAIL_READ_SCOPE,
  type GmailConnection,
  type GmailConnectionsSnapshot,
} from '@veduta/protocol'
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import {
  beginGmailAuthorization,
  completeGmailAuthorization,
  createGmailConnection,
  failGmailAuthorization,
  fetchGmailConnections,
  removeGmailConnection,
  renameGmailConnection,
  verifyLegacyGmailConnection,
} from './gmail-connections-api.ts'

function callbackFromUrl():
  { id: string; state: string; code?: string; error?: string } | undefined {
  const params = new URLSearchParams(window.location.search)
  const state = params.get('state')
  const code = params.get('code')
  const error = params.get('error')
  if (!state && !code && !error) return undefined
  // OAuth parameters must leave browser history before any network call or render.
  window.history.replaceState(window.history.state, '', window.location.pathname)
  const id = state?.split('.')[0]
  if (!id || !/^svc-gmail-[a-z0-9-]+$/.test(id)) return undefined
  return { id, state: state!, ...(code ? { code } : {}), ...(error ? { error } : {}) }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : 'Gmail connection request failed'
}

function ConnectionCard({
  connection,
  busy,
  onAuthorize,
  onVerifyLegacy,
  onRename,
  onRemove,
}: {
  connection: GmailConnection
  busy: boolean
  onAuthorize: (id: string) => void
  onVerifyLegacy: (id: string) => void
  onRename: (id: string, name: string) => void
  onRemove: (id: string) => void
}) {
  const [name, setName] = useState(connection.name)
  return (
    <li className="model-connection-card">
      <div className="gmail-connection-heading">
        <strong>{connection.name}</strong>
        <span className="model-connection-lifecycle">{connection.state.replaceAll('_', ' ')}</span>
      </div>
      <p className="gmail-connection-detail">
        {connection.accountEmail ?? 'Account not verified'} · Read-only mail access
      </p>
      {connection.reason && <p role="status">{connection.reason}</p>}
      <div className="gmail-connection-actions">
        {connection.id === 'svc-gmail-legacy' && connection.state !== 'ready' && (
          <button type="button" disabled={busy} onClick={() => onVerifyLegacy(connection.id)}>
            Verify saved account
          </button>
        )}
        <button type="button" disabled={busy} onClick={() => onAuthorize(connection.id)}>
          {connection.state === 'ready' ? 'Reconnect' : 'Authorize with Google'}
        </button>
        <label>
          Connection name
          <input value={name} maxLength={80} onChange={(event) => setName(event.target.value)} />
        </label>
        <button
          type="button"
          disabled={busy || !name.trim() || name.trim() === connection.name}
          onClick={() => onRename(connection.id, name.trim())}
        >
          Save name
        </button>
        <button type="button" disabled={busy} onClick={() => onRemove(connection.id)}>
          Remove
        </button>
      </div>
    </li>
  )
}

export function SettingsGmailConnections({
  token,
  onBack,
}: {
  token?: string | undefined
  onBack: () => void
}) {
  const [snapshot, setSnapshot] = useState<GmailConnectionsSnapshot>()
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [clientId, setClientId] = useState('')
  const [clientSecret, setClientSecret] = useState('')
  const callbackStarted = useRef(false)

  const refresh = useCallback(async () => {
    try {
      setSnapshot(await fetchGmailConnections(token))
      setError(null)
    } catch (failure) {
      setError(errorText(failure))
    } finally {
      setLoading(false)
    }
  }, [token])

  useEffect(() => {
    if (callbackStarted.current) return
    callbackStarted.current = true
    const callback = callbackFromUrl()
    if (!callback) {
      queueMicrotask(() => void refresh())
      return
    }
    const finish = async () => {
      setBusy(true)
      try {
        const next = callback.code
          ? await completeGmailAuthorization(callback.id, callback.code, callback.state, token)
          : await failGmailAuthorization(
              callback.id,
              callback.state,
              callback.error === 'access_denied' ? 'access_denied' : 'other',
              token,
            )
        setSnapshot(next)
        setError(callback.error ? 'Gmail authorization was not completed.' : null)
      } catch (failure) {
        setError(errorText(failure))
        await refresh()
      } finally {
        setBusy(false)
        setLoading(false)
      }
    }
    void finish()
  }, [refresh, token])

  const run = async (action: () => Promise<GmailConnectionsSnapshot>) => {
    setBusy(true)
    setError(null)
    try {
      setSnapshot(await action())
    } catch (failure) {
      setError(errorText(failure))
    } finally {
      setBusy(false)
    }
  }

  const create = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const input = { name: name.trim(), clientId: clientId.trim(), clientSecret }
    setClientSecret('')
    void run(() => createGmailConnection(input, token))
  }

  const authorize = (id: string) => {
    setBusy(true)
    setError(null)
    void beginGmailAuthorization(id, token)
      .then((url) => window.location.assign(url))
      .catch((failure: unknown) => {
        setError(errorText(failure))
        setBusy(false)
      })
  }

  return (
    <main className="model-connections-settings gmail-connections-settings">
      <header className="model-connections-settings-header">
        <button type="button" onClick={onBack}>
          Back
        </button>
        <h1>Gmail connections</h1>
      </header>
      <p>
        Connect an account for requested mail work. Connecting does not read or monitor messages.
      </p>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {loading ? (
        <p role="status">Loading Gmail connections…</p>
      ) : (
        <>
          {snapshot?.connections.length ? (
            <ul className="gmail-connection-list">
              {snapshot.connections.map((connection) => (
                <ConnectionCard
                  key={connection.id}
                  connection={connection}
                  busy={busy}
                  onAuthorize={authorize}
                  onVerifyLegacy={(id) => void run(() => verifyLegacyGmailConnection(id, token))}
                  onRename={(id, nextName) =>
                    void run(() => renameGmailConnection(id, nextName, token))
                  }
                  onRemove={(id) => {
                    if (
                      window.confirm('Remove this Gmail connection and its saved authorization?')
                    ) {
                      void run(() => removeGmailConnection(id, token))
                    }
                  }}
                />
              ))}
            </ul>
          ) : (
            <p role="status">No Gmail account connected yet.</p>
          )}
          <section className="gmail-connection-add" aria-labelledby="add-gmail-heading">
            <h2 id="add-gmail-heading">Add Gmail account</h2>
            <p>
              Enter the OAuth client credentials from your Google Cloud project, then authorize the
              account in Google. Veduta requests only <code>{GMAIL_READ_SCOPE}</code> for mail
              search and summaries.
            </p>
            <form onSubmit={create} className="wizard-step-form">
              <label htmlFor="gmail-name">Connection name</label>
              <input
                id="gmail-name"
                required
                maxLength={80}
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
              <label htmlFor="gmail-client-id">OAuth client ID</label>
              <input
                id="gmail-client-id"
                required
                value={clientId}
                onChange={(event) => setClientId(event.target.value)}
                autoComplete="off"
              />
              <label htmlFor="gmail-client-secret">OAuth client secret</label>
              <input
                id="gmail-client-secret"
                required
                type="password"
                value={clientSecret}
                onChange={(event) => setClientSecret(event.target.value)}
                autoComplete="off"
              />
              <p className="gmail-connection-detail">
                Register <code>{window.location.origin}/app/settings/gmail</code> as an authorized
                redirect URI for this OAuth client.
              </p>
              <button type="submit" disabled={busy}>
                Add account
              </button>
            </form>
          </section>
        </>
      )}
    </main>
  )
}
