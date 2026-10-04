import { Input } from '@veduta/catalog/ui/input'
import { NativeSelect } from '@veduta/catalog/ui/native-select'
import type { ConnectionAttempt, GmailConnection, ServiceConnection } from '@veduta/protocol'
import { useState } from 'react'
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
  reviewed,
}: {
  attempt: ConnectionAttempt
  existing: ServiceConnection | undefined
  gmailAccounts: GmailConnection[]
  controller: ConnectionsController
  token?: string
  reviewed: boolean
}) {
  const [githubToken, setGithubToken] = useState('')
  const [gmailId, setGmailId] = useState(attempt.connectionId ?? '')
  const [name, setName] = useState('Gmail')
  const [clientId, setClientId] = useState('')
  const [clientSecret, setClientSecret] = useState('')
  const reusable = attempt.origin === 'management' && existing?.state === 'ready'
  const submit = () => {
    if (!reviewed || controller.busy) return
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
      const input = gmailId ? { gmailConnectionId: gmailId } : { name, clientId, clientSecret }
      setClientSecret('')
      void controller.run(async () => {
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
          <h3>Authorize GitHub</h3>
          <ol>
            <li>
              In GitHub, create a{' '}
              <a
                href="https://github.com/settings/personal-access-tokens/new"
                target="_blank"
                rel="noreferrer"
              >
                fine-grained personal access token
              </a>
              .
            </li>
            <li>
              Select only{' '}
              <strong>
                {attempt.review.repository?.owner}/{attempt.review.repository?.name}
              </strong>{' '}
              and grant Issues{' '}
              {attempt.review.actions.includes('issue_write') ? 'read and write' : 'read'} access.
            </li>
            <li>Paste the token below to verify your account and the reviewed server.</li>
          </ol>
          <p className="connection-note">
            This connection currently uses a token. Verification checks your identity and tool
            availability.
          </p>
          <label>
            Fine-grained GitHub token
            <Input
              type="password"
              autoComplete="off"
              required
              minLength={20}
              maxLength={300}
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
              <ol>
                <li>
                  In{' '}
                  <a
                    href="https://console.cloud.google.com/apis/credentials"
                    target="_blank"
                    rel="noreferrer"
                  >
                    Google Cloud
                  </a>
                  , enable the Gmail API and configure the OAuth consent screen. Add your account as
                  a test user if the app is in testing.
                </li>
                <li>
                  Create a Web application OAuth client. Add this exact redirect URI:{' '}
                  <code>{window.location.origin}/app/connections</code>.
                </li>
                <li>
                  Enter the client credentials below, then continue to Google to choose your
                  account.
                </li>
              </ol>
              <label>
                Connection name
                <Input
                  required
                  maxLength={80}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
              </label>
              <label>
                Google OAuth client ID
                <Input
                  required
                  autoComplete="off"
                  maxLength={500}
                  value={clientId}
                  onChange={(event) => setClientId(event.target.value)}
                />
              </label>
              <label>
                Google OAuth client secret
                <Input
                  required
                  type="password"
                  autoComplete="off"
                  maxLength={500}
                  value={clientSecret}
                  onChange={(event) => setClientSecret(event.target.value)}
                />
              </label>
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
