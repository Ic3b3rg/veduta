import { Button } from '@veduta/catalog/ui/button'
import { NativeSelect } from '@veduta/catalog/ui/native-select'
import { useRef, useState } from 'react'
import type { ConnectionsController } from './connections-controller.ts'
import { ConnectionDetailBody, ConnectionDetailFooter } from './connections-layout.tsx'
import { createServiceConnectionAttempt } from './service-connections-api.ts'

export function ConnectionCreate({
  controller,
  token,
  onAttempt,
  onMailbox,
}: {
  controller: ConnectionsController
  token?: string
  onAttempt: (id: string) => void
  onMailbox: () => void
}) {
  const [service, setService] = useState<'gmail' | 'github'>('gmail')
  const submissionId = useRef(crypto.randomUUID())
  const create = () =>
    void controller.run(async () => {
      const snapshot = await createServiceConnectionAttempt(
        {
          submissionId: submissionId.current,
          service,
        },
        token,
      )
      const attempt = snapshot.attempts.find((item) => item.submissionId === submissionId.current)
      if (attempt) onAttempt(attempt.id)
    })
  return (
    <>
      <ConnectionDetailBody>
        {controller.error && (
          <p role="alert" className="connections-alert">
            {controller.error}
          </p>
        )}
        <p>Connect an account, verify it, then choose which Spaces can use it.</p>
        <form
          id="create-service"
          className="connection-fields"
          onSubmit={(event) => {
            event.preventDefault()
            create()
          }}
        >
          <label>
            Service
            <NativeSelect
              value={service}
              onChange={(event) => {
                setService(event.target.value === 'github' ? 'github' : 'gmail')
                submissionId.current = crypto.randomUUID()
              }}
            >
              <option value="gmail">Gmail</option>
              <option value="github">GitHub</option>
            </NativeSelect>
          </label>
          {service === 'gmail' ? (
            <p className="connection-note">
              Google OAuth · read-only mail.{' '}
              {controller.gmail?.oauthClient?.configured
                ? 'Google is configured. Continue to connect an account.'
                : 'A short guide will help you configure Google once for this installation.'}
            </p>
          ) : (
            <p className="connection-note">
              List repositories, read files and open issues using a fine-grained GitHub token. Each
              Space can use all repositories authorized by that token, or a smaller selection. Setup
              checks your account and installs the reviewed server after you confirm; repository
              content is read only when requested.
            </p>
          )}
        </form>
        <h3>Another email provider?</h3>
        <p>Use your provider's IMAP and SMTP settings and app password.</p>
        <Button variant="outline" disabled={controller.busy} onClick={onMailbox}>
          Connect IMAP and SMTP
        </Button>
      </ConnectionDetailBody>
      <ConnectionDetailFooter>
        <Button type="submit" form="create-service" disabled={controller.busy}>
          Review access
        </Button>
      </ConnectionDetailFooter>
    </>
  )
}
