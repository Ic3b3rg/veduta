import { Button } from '@veduta/catalog/ui/button'
import { Input } from '@veduta/catalog/ui/input'
import { GMAIL_READ_SCOPE } from '@veduta/protocol'
import { useState } from 'react'

export function GmailOAuthSetupGuide({
  clientId,
  clientSecret,
  onClientId,
  onClientSecret,
}: {
  clientId: string
  clientSecret: string
  onClientId: (value: string) => void
  onClientSecret: (value: string) => void
}) {
  const [copyStatus, setCopyStatus] = useState('')
  const redirectUri = `${window.location.origin}/app/connections`
  return (
    <section className="connection-setup-guide" aria-label="Google OAuth setup guide">
      <h3>Set up Google once</h3>
      <p className="connection-note">
        This Google client is shared by the Gmail accounts on this installation. After this setup,
        each account connects with Google OAuth.
      </p>
      <ol>
        <li>
          <strong>Choose a Google Cloud project.</strong> Create or select a project in{' '}
          <a
            href="https://console.cloud.google.com/projectselector2/home/dashboard"
            target="_blank"
            rel="noreferrer"
          >
            Google Cloud
          </a>
          , then{' '}
          <a
            href="https://console.cloud.google.com/apis/library/gmail.googleapis.com"
            target="_blank"
            rel="noreferrer"
          >
            Enable Gmail API
          </a>{' '}
          in that same project.
        </li>
        <li>
          <strong>Configure Google Auth platform.</strong> In{' '}
          <a href="https://console.cloud.google.com/auth/branding" target="_blank" rel="noreferrer">
            Branding
          </a>
          , set the app name to Veduta and choose your support email. In{' '}
          <a href="https://console.cloud.google.com/auth/audience" target="_blank" rel="noreferrer">
            Audience
          </a>
          , use External for personal Gmail; Internal is for accounts in your Google Workspace
          organization. If the app is in Testing, add every account you will connect under Test
          users. In{' '}
          <a href="https://console.cloud.google.com/auth/scopes" target="_blank" rel="noreferrer">
            Data Access
          </a>
          , add only <code>{GMAIL_READ_SCOPE}</code>.
        </li>
        <li>
          <strong>Create a Web application client.</strong> Open{' '}
          <a href="https://console.cloud.google.com/auth/clients" target="_blank" rel="noreferrer">
            Clients
          </a>
          , choose Create client → Web application, and add this exact value under Authorized
          redirect URIs:
          <code className="connection-copy-value">{redirectUri}</code>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              void navigator.clipboard?.writeText(redirectUri).then(
                () => setCopyStatus('Redirect URI copied.'),
                () => setCopyStatus('Select and copy the redirect URI above.'),
              )
              if (!navigator.clipboard) setCopyStatus('Select and copy the redirect URI above.')
            }}
          >
            Copy redirect URI
          </Button>
          {copyStatus && <p role="status">{copyStatus}</p>}
        </li>
        <li>
          <strong>Enter the client credentials.</strong> Copy the Client ID and client secret from
          Google. Continue to Google to verify the selected account; saving these settings alone
          does not verify a Gmail account.
        </li>
      </ol>
      <label>
        Google OAuth client ID
        <Input
          required
          autoComplete="off"
          maxLength={500}
          value={clientId}
          onChange={(event) => onClientId(event.target.value)}
        />
      </label>
      <label>
        Google OAuth client secret
        <Input
          required
          type="password"
          autoComplete="off"
          maxLength={2000}
          value={clientSecret}
          onChange={(event) => onClientSecret(event.target.value)}
        />
      </label>
      <details>
        <summary>Google reports an error?</summary>
        <p>
          For redirect_uri_mismatch, register the exact redirect URI above, including its port and
          path. For access_denied, check the app's Audience and Test users in the same project.
        </p>
        <p>
          An app in Testing can require authorization again after seven days. Review Google's
          publishing requirements before switching it to In production.
        </p>
        <a
          href="https://developers.google.com/identity/protocols/oauth2/web-server"
          target="_blank"
          rel="noreferrer"
        >
          Google OAuth setup and troubleshooting
        </a>
      </details>
    </section>
  )
}
