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
  initialService = 'gmail',
}: {
  controller: ConnectionsController
  token?: string
  onAttempt: (id: string) => void
  onMailbox: () => void
  initialService?: 'gmail' | 'github'
}) {
  const [service, setService] = useState<'gmail' | 'github' | 'mailbox'>(initialService)
  const submissionId = useRef(crypto.randomUUID())
  const create = async () => {
    if (controller.busy) return
    if (service === 'mailbox') {
      onMailbox()
      return
    }
    let attemptId: string | undefined
    const succeeded = await controller.run(async () => {
      const snapshot = await createServiceConnectionAttempt(
        {
          submissionId: submissionId.current,
          service,
        },
        token,
      )
      const attempt = snapshot.attempts.find((item) => item.submissionId === submissionId.current)
      attemptId = attempt?.id
    })
    if (succeeded && attemptId) onAttempt(attemptId)
  }
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
            void create()
          }}
        >
          <label>
            Service
            <NativeSelect
              aria-label="Service"
              value={service}
              onChange={(event) => {
                const value = event.target.value
                setService(value === 'github' || value === 'mailbox' ? value : 'gmail')
                controller.clearError()
                submissionId.current = crypto.randomUUID()
              }}
            >
              <option value="gmail">Gmail</option>
              <option value="github">GitHub</option>
              <option value="mailbox">Other email (IMAP and SMTP)</option>
            </NativeSelect>
          </label>
          {service === 'gmail' ? (
            <p className="connection-note">
              Google OAuth · read-only mail.{' '}
              {controller.gmail?.oauthClient?.configured
                ? 'Google is configured. Continue to connect an account.'
                : 'A short guide will help you configure Google once for this installation.'}
            </p>
          ) : service === 'github' ? (
            <p className="connection-note">
              List repositories, read files and open issues using a fine-grained GitHub token. Each
              Space can use all repositories authorized by that token, or a smaller selection. Setup
              checks your account and installs the reviewed server after you confirm; repository
              content is read only when requested.
            </p>
          ) : (
            <p className="connection-note">
              Connect your email provider using its IMAP and SMTP settings and an app password.
            </p>
          )}
        </form>
      </ConnectionDetailBody>
      <ConnectionDetailFooter>
        <Button type="submit" form="create-service" disabled={controller.busy}>
          {service === 'mailbox' ? 'Continue' : 'Review access'}
        </Button>
      </ConnectionDetailFooter>
    </>
  )
}
