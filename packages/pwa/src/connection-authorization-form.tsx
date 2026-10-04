import { Input } from '@veduta/catalog/ui/input'
import { Button } from '@veduta/catalog/ui/button'
import { NativeSelect } from '@veduta/catalog/ui/native-select'
import type { ConnectionAttempt, GmailConnection, ServiceConnection } from '@veduta/protocol'
import { useEffect, useState } from 'react'
import { configureGmailOAuthClient } from './gmail-connections-api.ts'
import { GmailOAuthSetupGuide } from './gmail-oauth-setup-guide.tsx'
import { GithubTokenGuide } from './github-token-guide.tsx'
import type { ConnectionsController } from './connections-controller.ts'
import {
  authorizeGithubAttempt,
  authorizeGmailAttempt,
  serviceConnectionAction,
} from './service-connections-api.ts'

export function ConnectionAuthorizationForm({
  attempt,
  existing,
  gmailAccounts,
  controller,
  token,
  onValidityChange,
}: {
  attempt: ConnectionAttempt
  existing: ServiceConnection | undefined
  gmailAccounts: GmailConnection[]
  controller: ConnectionsController
  token?: string
  onValidityChange: (valid: boolean) => void
}) {
  const [githubToken, setGithubToken] = useState('')
  const [gmailId, setGmailId] = useState(attempt.connectionId ?? '')
  const [name, setName] = useState('Gmail')
  const [clientId, setClientId] = useState('')
  const [clientSecret, setClientSecret] = useState('')
  const [editingClient, setEditingClient] = useState(false)
  const configured = controller.gmail?.oauthClient?.configured === true
  const needsClient = !configured || editingClient
  const reusable = attempt.origin === 'management' && existing?.state === 'ready'
  const valid =
    reusable ||
    (attempt.review.service === 'github'
      ? /^github_pat_[A-Za-z0-9_]{20,}$/.test(githubToken)
      : Boolean(
          gmailId || (name.trim() && (!needsClient || (clientId.trim() && clientSecret.trim()))),
        ))
  useEffect(() => onValidityChange(valid), [valid, onValidityChange])
  const submit = () => {
    if (!valid || controller.busy) return
    if (reusable) {
      void controller.run(() =>
        serviceConnectionAction(`attempts/${attempt.id}/use-connection`, token),
      )
      return
    }
    if (attempt.review.service === 'github') {
      const secret = githubToken
      setGithubToken('')
      void controller.run(() => authorizeGithubAttempt(attempt.id, secret, token))
    } else {
      const input = gmailId ? { gmailConnectionId: gmailId } : { name: name.trim() }
      const credentials = { clientId: clientId.trim(), clientSecret }
      setClientSecret('')
      void controller.run(async () => {
        if (!gmailId && needsClient) {
          await configureGmailOAuthClient(credentials, token)
          setEditingClient(false)
        }
        const result = await authorizeGmailAttempt(attempt.id, input, token)
        if (result.authorizationUrl) window.location.assign(result.authorizationUrl)
      })
    }
  }
  return (
    <form
      id={`authorize-${attempt.id}`}
      className="connection-fields"
      onSubmit={(event) => {
        event.preventDefault()
        submit()
      }}
    >
      {reusable ? (
        <p className="connection-note">
          Use the verified account {existing.account}. You will choose Space access next.
        </p>
      ) : attempt.review.service === 'github' ? (
        <>
          <GithubTokenGuide review={attempt.review} />
          <label>
            Fine-grained GitHub token
            <Input
              type="password"
              autoComplete="off"
              required
              minLength={31}
              maxLength={300}
              pattern="github_pat_[A-Za-z0-9_]{20,}"
              value={githubToken}
              onChange={(event) => setGithubToken(event.target.value)}
            />
          </label>
        </>
      ) : (
        <>
          <h3>Authorize Gmail</h3>
          {gmailAccounts.length > 0 && (
            <label>
              Gmail account
              <NativeSelect value={gmailId} onChange={(event) => setGmailId(event.target.value)}>
                <option value="">Connect a new account</option>
                {gmailAccounts.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.accountEmail ?? account.name} ({account.state.replaceAll('_', ' ')})
                  </option>
                ))}
              </NativeSelect>
            </label>
          )}
          {!gmailId && (
            <>
              <label>
                Connection name
                <Input
                  required
                  maxLength={80}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
              </label>
              {needsClient ? (
                <GmailOAuthSetupGuide
                  clientId={clientId}
                  clientSecret={clientSecret}
                  onClientId={setClientId}
                  onClientSecret={setClientSecret}
                />
              ) : (
                <>
                  <p role="status">Google OAuth is configured for this installation.</p>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setEditingClient(true)}
                  >
                    Change Google setup
                  </Button>
                </>
              )}
              {editingClient && (
                <p className="connection-note">
                  New accounts will use this configuration. Existing authorized accounts keep their
                  original Google client.
                </p>
              )}
            </>
          )}
          <p className="connection-note">
            Google verifies the selected account. Credentials stay in the Gateway vault. Connecting
            does not read or monitor mail.
          </p>
        </>
      )}
    </form>
  )
}
