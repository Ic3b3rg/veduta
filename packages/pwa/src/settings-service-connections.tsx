import type {
  ConnectionAttempt,
  GmailConnection,
  ServiceConnectionsSnapshot,
} from '@veduta/protocol'
import { useEffect, useRef, useState } from 'react'
import type { SpaceWithSurfaces } from './api.ts'
import { fetchGmailConnections } from './gmail-connections-api.ts'
import { clientPath } from './client-router.tsx'
import {
  authorizeGithubAttempt,
  authorizeGmailAttempt,
  completeServiceGmailCallback,
  confirmSpaceCapabilityGrant,
  fetchServiceConnections,
  removeServiceConnection,
  serviceConnectionAction,
} from './service-connections-api.ts'
import './styles/service-connections.css'

export function SettingsServiceConnections({
  token,
  spaces,
  onBack,
}: {
  token: string | undefined
  spaces: SpaceWithSurfaces[]
  onBack: () => void
}) {
  const [snapshot, setSnapshot] = useState<ServiceConnectionsSnapshot | null>(null)
  const [gmailAccounts, setGmailAccounts] = useState<GmailConnection[]>([])
  const [selectedGmailId, setSelectedGmailId] = useState('')
  const [name, setName] = useState('Gmail')
  const [clientId, setClientId] = useState('')
  const [clientSecret, setClientSecret] = useState('')
  const [githubToken, setGithubToken] = useState('')
  const [reviewedIds, setReviewedIds] = useState<Set<string>>(() => new Set())
  const [busy, setBusy] = useState(() => {
    const params = new URLSearchParams(window.location.search)
    return Boolean(params.get('state') && (params.get('code') || params.get('error')))
  })
  const [error, setError] = useState<string | null>(null)
  const callbackStarted = useRef(false)
  const selectedAttemptId = new URLSearchParams(window.location.search).get('attempt')

  useEffect(() => {
    let active = true
    const refresh = async () => {
      try {
        const [connections, gmail] = await Promise.all([
          fetchServiceConnections(token),
          fetchGmailConnections(token),
        ])
        if (!active) return
        setSnapshot(connections)
        setGmailAccounts(gmail.connections)
      } catch (cause) {
        if (active) setError(messageOf(cause))
      }
    }
    void refresh()
    const interval = window.setInterval(() => void refresh(), 3000)
    return () => {
      active = false
      window.clearInterval(interval)
    }
  }, [token])

  useEffect(() => {
    if (callbackStarted.current) return
    const params = new URLSearchParams(window.location.search)
    const state = params.get('state')
    const code = params.get('code')
    const providerError = params.get('error')
    if (!state || (!code && !providerError)) return
    callbackStarted.current = true
    const attemptId = params.get('attempt')
    window.history.replaceState(
      {},
      '',
      `${clientPath.serviceConnections}${attemptId ? `?attempt=${encodeURIComponent(attemptId)}` : ''}`,
    )
    void completeServiceGmailCallback(
      { state, ...(code ? { code } : {}), ...(providerError ? { error: providerError } : {}) },
      token,
    )
      .then(setSnapshot)
      .catch((cause) => setError(messageOf(cause)))
      .finally(() => setBusy(false))
  }, [token])

  const run = async (action: () => Promise<ServiceConnectionsSnapshot>) => {
    setBusy(true)
    setError(null)
    try {
      setSnapshot(await action())
    } catch (cause) {
      setError(messageOf(cause))
    } finally {
      setBusy(false)
    }
  }
  const attempts = snapshot?.attempts ?? []
  const selected = attempts.find((attempt) => attempt.id === selectedAttemptId)
  const shown = selected
    ? [selected, ...attempts.filter((attempt) => attempt.id !== selected.id)]
    : attempts

  return (
    <main className="model-connections-settings settings-service-connections">
      <header className="model-connections-settings-header">
        <button type="button" onClick={onBack}>
          Back to Home
        </button>
        <h1>Service connections</h1>
        <p>Review service access here before a Space request continues.</p>
      </header>
      {error && <p role="alert">{error}</p>}
      {!snapshot && !error && <p>Loading service connections…</p>}

      <section aria-label="Connection attempts">
        <h2>Requests waiting for a connection</h2>
        {shown.length === 0 && <p>No requests are waiting.</p>}
        {shown.map((attempt) => {
          const reviewKey = `${attempt.id}:${attempt.updatedAt}`
          const reviewed = reviewedIds.has(reviewKey)
          const spaceName = spaces.find((space) => space.id === attempt.spaceId)?.name
          const grant = snapshot?.grants.find(
            (item) =>
              item.spaceId === attempt.spaceId &&
              item.connectionId === attempt.connectionId &&
              item.enabled,
          )
          return (
            <article key={attempt.id} id={`attempt-${attempt.id}`}>
              <h3>
                {attempt.review.service === 'github' ? 'GitHub' : 'Gmail'} for{' '}
                {spaceName ?? attempt.spaceId}
              </h3>
              <p>{attempt.requestSummary}</p>
              <p>
                State: <strong>{attempt.state}</strong>
              </p>
              {attempt.reason && <p role="status">{attempt.reason}</p>}
              {attempt.nextAction && <p>Next: {attempt.nextAction}</p>}
              <ReviewDetails attempt={attempt} />
              {attempt.state === 'reviewing' && (
                <>
                  <label>
                    <input
                      type="checkbox"
                      checked={reviewed}
                      onChange={(event) =>
                        setReviewedIds((previous) => {
                          const next = new Set(previous)
                          if (event.target.checked) next.add(reviewKey)
                          else next.delete(reviewKey)
                          return next
                        })
                      }
                    />
                    I reviewed this Space, account, provider scope, actions, and execution host.
                  </label>
                  {attempt.review.service === 'github' ? (
                    <form
                      onSubmit={(event) => {
                        event.preventDefault()
                        void run(() => authorizeGithubAttempt(attempt.id, githubToken, token))
                        setGithubToken('')
                      }}
                    >
                      <label>
                        Fine-grained GitHub token for the reviewed repository
                        <input
                          type="password"
                          autoComplete="off"
                          value={githubToken}
                          onChange={(event) => setGithubToken(event.target.value)}
                        />
                      </label>
                      <button type="submit" disabled={!reviewed || !githubToken || busy}>
                        Verify GitHub connection
                      </button>
                    </form>
                  ) : (
                    <form
                      onSubmit={(event) => {
                        event.preventDefault()
                        void (async () => {
                          setBusy(true)
                          setError(null)
                          try {
                            const result = await authorizeGmailAttempt(
                              attempt.id,
                              selectedGmailId
                                ? { gmailConnectionId: selectedGmailId }
                                : { name, clientId, clientSecret },
                              token,
                            )
                            setSnapshot(result.snapshot)
                            setClientSecret('')
                            if (result.authorizationUrl)
                              window.location.assign(result.authorizationUrl)
                          } catch (cause) {
                            setError(messageOf(cause))
                          } finally {
                            setBusy(false)
                          }
                        })()
                      }}
                    >
                      {gmailAccounts.length > 0 && (
                        <label>
                          Existing Gmail account
                          <select
                            value={selectedGmailId}
                            onChange={(event) => setSelectedGmailId(event.target.value)}
                          >
                            <option value="">Connect a new account</option>
                            {gmailAccounts.map((account) => (
                              <option key={account.id} value={account.id}>
                                {account.accountEmail ?? account.name} ({account.state})
                              </option>
                            ))}
                          </select>
                        </label>
                      )}
                      {!selectedGmailId && (
                        <>
                          <label>
                            Connection name
                            <input value={name} onChange={(event) => setName(event.target.value)} />
                          </label>
                          <label>
                            Google OAuth client ID
                            <input
                              value={clientId}
                              onChange={(event) => setClientId(event.target.value)}
                            />
                          </label>
                          <label>
                            Google OAuth client secret
                            <input
                              type="password"
                              autoComplete="off"
                              value={clientSecret}
                              onChange={(event) => setClientSecret(event.target.value)}
                            />
                          </label>
                        </>
                      )}
                      <button
                        type="submit"
                        disabled={
                          !reviewed || busy || (!selectedGmailId && (!clientId || !clientSecret))
                        }
                      >
                        Continue to Gmail authorization
                      </button>
                    </form>
                  )}
                </>
              )}
              {attempt.state === 'ready' && !grant && attempt.verifiedAccount && (
                <div>
                  <h4>Confirm the verified Space grant</h4>
                  <p>Verified account: {attempt.verifiedAccount}</p>
                  <p>Granted provider scopes: {attempt.verifiedScopes?.join(', ')}</p>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void run(() =>
                        confirmSpaceCapabilityGrant(
                          attempt.id,
                          attempt.verifiedAccount!,
                          attempt.verifiedScopes ?? [],
                          token,
                        ),
                      )
                    }
                  >
                    Grant to {spaceName ?? attempt.spaceId} and resume request
                  </button>
                </div>
              )}
              {grant && <p>Granted to this Space. Continuation: {attempt.continuation}.</p>}
              {['failed', 'unsupported', 'needs_reconnect'].includes(attempt.state) && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void run(() =>
                      serviceConnectionAction(
                        `attempts/${encodeURIComponent(attempt.id)}/retry`,
                        token,
                      ),
                    )
                  }
                >
                  Return to review
                </button>
              )}
              {!['cancelled', 'failed', 'unsupported'].includes(attempt.state) &&
                attempt.continuation === 'unclaimed' && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void run(() =>
                        serviceConnectionAction(
                          `attempts/${encodeURIComponent(attempt.id)}/cancel`,
                          token,
                        ),
                      )
                    }
                  >
                    Cancel this request
                  </button>
                )}
            </article>
          )
        })}
      </section>

      <section aria-label="Connected services">
        <h2>Connected services</h2>
        {snapshot?.connections.length === 0 && <p>No connected services yet.</p>}
        {snapshot?.connections.map((connection) => (
          <article key={connection.id}>
            <h3>
              {connection.service === 'github' ? 'GitHub' : 'Gmail'} · {connection.account}
            </h3>
            <p>State: {connection.state}</p>
            <p>Scopes: {connection.scopes.join(', ')}</p>
            <p>Execution host: {connection.executionHost}</p>
            {connection.reason && <p>{connection.reason}</p>}
            {connection.state === 'ready' && (
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  void run(() =>
                    serviceConnectionAction(`${encodeURIComponent(connection.id)}/disable`, token),
                  )
                }
              >
                Disable connection
              </button>
            )}
            {connection.state !== 'removed' && (
              <button
                type="button"
                disabled={busy}
                onClick={() => void run(() => removeServiceConnection(connection.id, token))}
              >
                Remove connection
              </button>
            )}
          </article>
        ))}
      </section>

      <section aria-label="Space capability grants">
        <h2>Space capability grants</h2>
        {snapshot?.grants.map((grant) => (
          <article key={grant.id}>
            <p>
              {spaces.find((space) => space.id === grant.spaceId)?.name ?? grant.spaceId} ·{' '}
              {grant.repository
                ? `${grant.repository.owner}/${grant.repository.name}`
                : 'Mailbox account'}
            </p>
            <p>Actions: {grant.actions.join(', ')}</p>
            <p>{grant.enabled ? 'Enabled' : 'Disabled'}</p>
            {grant.enabled && (
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  void run(() =>
                    serviceConnectionAction(
                      `grants/${encodeURIComponent(grant.id)}/disable`,
                      token,
                    ),
                  )
                }
              >
                Disable this Space grant
              </button>
            )}
          </article>
        ))}
      </section>
    </main>
  )
}

function ReviewDetails({ attempt }: { attempt: ConnectionAttempt }) {
  const review = attempt.review
  return (
    <dl>
      <dt>Account hint</dt>
      <dd>{review.accountHint ?? 'No account selected yet'}</dd>
      <dt>Provider scopes</dt>
      <dd>{review.scopes.join(', ')}</dd>
      <dt>Allowed actions</dt>
      <dd>{review.actions.join(', ')}</dd>
      <dt>Execution host</dt>
      <dd>{review.executionHost}</dd>
      {review.repository && (
        <>
          <dt>Repository restriction</dt>
          <dd>
            {review.repository.owner}/{review.repository.name}
          </dd>
        </>
      )}
      {review.serverVersion && (
        <>
          <dt>Reviewed server</dt>
          <dd>{review.serverVersion}</dd>
        </>
      )}
      {review.serverSource && (
        <>
          <dt>Source</dt>
          <dd>
            <a href={review.serverSource} rel="noreferrer noopener">
              Official GitHub MCP release
            </a>
          </dd>
        </>
      )}
      {review.archiveSha256 && (
        <>
          <dt>Archive SHA-256</dt>
          <dd>
            <code>{review.archiveSha256}</code>
          </dd>
        </>
      )}
      {review.executableSha256 && (
        <>
          <dt>Executable SHA-256</dt>
          <dd>
            <code>{review.executableSha256}</code>
          </dd>
        </>
      )}
      {review.toolSchemaSha256 && (
        <>
          <dt>Tool schema SHA-256</dt>
          <dd>
            <code>{review.toolSchemaSha256}</code>
          </dd>
        </>
      )}
    </dl>
  )
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'Service connection request failed'
}
