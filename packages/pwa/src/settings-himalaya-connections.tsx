import { HimalayaConnectionFields } from './connection-mailbox-setup.tsx'
import { Button } from '@veduta/catalog/ui/button'
import { Input } from '@veduta/catalog/ui/input'
import type {
  CreateHimalayaConnectionRequest,
  HimalayaConnection,
  HimalayaConnectionsSnapshot,
} from '@veduta/protocol'
import { useCallback, useEffect, useState, type FormEvent } from 'react'
import {
  completeLegacyHimalayaConnection,
  createHimalayaConnection,
  fetchHimalayaConnections,
  installHimalaya,
  removeHimalayaConnection,
  renameHimalayaConnection,
  verifyHimalayaConnection,
} from './himalaya-connections-api.ts'

function value(data: FormData, name: string): string {
  return String(data.get(name) ?? '').trim()
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : 'Mailbox setup failed'
}

export function HimalayaConnectionCard({
  connection,
  busy,
  onVerify,
  onCompleteLegacy,
  onRename,
  onRemove,
}: {
  connection: HimalayaConnection
  busy: boolean
  onVerify: (id: string) => void
  onCompleteLegacy: (
    id: string,
    input: {
      name: string
      address: string
      smtpServer: string
      smtpUsername: string
      smtpPassword: string
    },
  ) => void
  onRename: (id: string, name: string) => void
  onRemove: (id: string) => void
}) {
  const [name, setName] = useState(connection.name)
  const completeLegacy = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = event.currentTarget
    const data = new FormData(form)
    onCompleteLegacy(connection.id, {
      name: value(data, 'name'),
      address: value(data, 'address'),
      smtpServer: value(data, 'smtpServer'),
      smtpUsername: value(data, 'smtpUsername'),
      smtpPassword: String(data.get('smtpPassword') ?? ''),
    })
    form.reset()
  }
  return (
    <li className="model-connection-card">
      <div className="gmail-connection-heading">
        <strong>{connection.name}</strong>
        <span className="model-connection-lifecycle">{connection.state.replaceAll('_', ' ')}</span>
      </div>
      <p className="gmail-connection-detail">
        {connection.address ?? 'Address pending'} · {connection.imapServer}
        {connection.smtpServer ? ` · ${connection.smtpServer}` : ''}
      </p>
      {connection.reason && <p role="status">{connection.reason}</p>}
      {connection.state === 'needs_smtp' && (
        <form
          onSubmit={completeLegacy}
          className="wizard-step-form"
          aria-label={`Complete ${connection.name}`}
        >
          <label>
            Connection name
            <Input name="name" required defaultValue={connection.name} />
          </label>
          <label>
            Email address
            <Input name="address" type="email" required defaultValue={connection.address ?? ''} />
          </label>
          <label>
            SMTP server URL
            <Input
              name="smtpServer"
              type="url"
              placeholder="smtps://smtp.example.com:465"
              required
            />
          </label>
          <label>
            SMTP username
            <Input name="smtpUsername" required autoComplete="off" />
          </label>
          <label>
            SMTP password
            <Input name="smtpPassword" type="password" required autoComplete="off" />
          </label>
          <Button type="submit" disabled={busy}>
            Complete saved IMAP connection
          </Button>
        </form>
      )}
      <div className="gmail-connection-actions">
        {connection.state !== 'needs_smtp' && (
          <Button type="button" disabled={busy} onClick={() => onVerify(connection.id)}>
            {connection.state === 'ready' ? 'Test again' : 'Test IMAP and SMTP'}
          </Button>
        )}
        <label>
          Connection name
          <Input value={name} maxLength={100} onChange={(event) => setName(event.target.value)} />
        </label>
        <Button
          type="button"
          disabled={busy || !name.trim() || name.trim() === connection.name}
          onClick={() => onRename(connection.id, name.trim())}
        >
          Save name
        </Button>
        <Button type="button" disabled={busy} onClick={() => onRemove(connection.id)}>
          Remove
        </Button>
      </div>
    </li>
  )
}

export function SettingsHimalayaConnections({
  token,
  onBack,
}: {
  token?: string | undefined
  onBack: () => void
}) {
  const [snapshot, setSnapshot] = useState<HimalayaConnectionsSnapshot>()
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      setSnapshot(await fetchHimalayaConnections(token))
      setError(null)
    } catch (failure) {
      setError(errorText(failure))
    } finally {
      setLoading(false)
    }
  }, [token])

  useEffect(() => {
    queueMicrotask(() => void refresh())
  }, [refresh])

  const run = async (action: () => Promise<HimalayaConnectionsSnapshot>) => {
    setBusy(true)
    setError(null)
    setNotice(null)
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
    const form = event.currentTarget
    const data = new FormData(form)
    const input: CreateHimalayaConnectionRequest = {
      name: value(data, 'name'),
      address: value(data, 'address'),
      imapServer: value(data, 'imapServer'),
      imapUsername: value(data, 'imapUsername'),
      imapPassword: String(data.get('imapPassword') ?? ''),
      smtpServer: value(data, 'smtpServer'),
      smtpUsername: value(data, 'smtpUsername'),
      smtpPassword: String(data.get('smtpPassword') ?? ''),
    }
    form.reset()
    void run(() => createHimalayaConnection(input, token))
  }

  const install = async () => {
    setBusy(true)
    setError(null)
    setNotice('Installing Himalaya 2.1.0. This may take several minutes.')
    try {
      const outcome = await installHimalaya(token)
      if (outcome.state === 'failed') setError(outcome.reason ?? 'Himalaya installation failed')
      else setNotice('Himalaya is ready. Test each Mailbox connection now.')
      await refresh()
    } catch (failure) {
      setError(errorText(failure))
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="model-connections-settings gmail-connections-settings">
      <header className="model-connections-settings-header">
        <Button type="button" onClick={onBack}>
          Back
        </Button>
        <h1>IMAP and SMTP connections</h1>
      </header>
      <p>Connect a Mailbox for requested work. Setup and testing do not list or fetch messages.</p>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      {loading ? (
        <p role="status">Loading Mailbox connections…</p>
      ) : (
        <>
          {snapshot?.connections.length ? (
            <ul className="gmail-connection-list">
              {snapshot.connections.map((connection) => (
                <HimalayaConnectionCard
                  key={connection.id}
                  connection={connection}
                  busy={busy}
                  onVerify={(id) => void run(() => verifyHimalayaConnection(id, token))}
                  onCompleteLegacy={(id, input) =>
                    void run(() => completeLegacyHimalayaConnection(id, input, token))
                  }
                  onRename={(id, name) => void run(() => renameHimalayaConnection(id, name, token))}
                  onRemove={(id) => {
                    if (
                      window.confirm('Remove this Mailbox connection and its saved credentials?')
                    ) {
                      void run(() => removeHimalayaConnection(id, token))
                    }
                  }}
                />
              ))}
            </ul>
          ) : (
            <p role="status">No IMAP or SMTP account connected yet.</p>
          )}
          <section className="gmail-connection-add" aria-labelledby="add-himalaya-heading">
            <h2 id="add-himalaya-heading">Add IMAP and SMTP account</h2>
            <p>
              Use the server URLs and app passwords from your mail provider. Passwords are saved in
              the local vault.
            </p>
            <form onSubmit={create} className="wizard-step-form">
              <HimalayaConnectionFields />
              <Button type="submit" disabled={busy}>
                Add Mailbox
              </Button>
            </form>
          </section>
          <section className="gmail-connection-add" aria-labelledby="himalaya-install-heading">
            <h2 id="himalaya-install-heading">Himalaya CLI</h2>
            <p>
              Veduta uses the reviewed Himalaya 2.1.0 release for IMAP and SMTP accounts. If a
              connection reports that setup is needed, install it here and test the connection
              again.
            </p>
            <Button type="button" disabled={busy} onClick={() => void install()}>
              Install reviewed release
            </Button>
          </section>
        </>
      )}
    </main>
  )
}
