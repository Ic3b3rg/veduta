import { Button } from '@veduta/catalog/ui/button'
import { Input } from '@veduta/catalog/ui/input'
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
  const [owner, setOwner] = useState('')
  const [repository, setRepository] = useState('')
  const submissionId = useRef(crypto.randomUUID())
  const create = () =>
    void controller.run(async () => {
      const snapshot = await createServiceConnectionAttempt(
        {
          submissionId: submissionId.current,
          service,
          ...(service === 'github'
            ? { repository: { owner: owner.trim(), name: repository.trim() } }
            : {}),
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
              Google OAuth · read-only mail. Have the OAuth client credentials for your Google Cloud
              project ready.
            </p>
          ) : (
            <>
              <p className="connection-note">
                Reviewed GitHub MCP Server · fine-grained token · one repository. Adding an account
                installs the reviewed server only after you confirm.
              </p>
              <label>
                Repository owner
                <Input
                  required
                  maxLength={39}
                  pattern="[A-Za-z0-9][A-Za-z0-9-]*"
                  value={owner}
                  onChange={(event) => setOwner(event.target.value)}
                  placeholder="your-account"
                />
              </label>
              <label>
                Repository name
                <Input
                  required
                  maxLength={100}
                  pattern="[A-Za-z0-9_.-]+"
                  value={repository}
                  onChange={(event) => setRepository(event.target.value)}
                  placeholder="your-repository"
                />
              </label>
            </>
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
