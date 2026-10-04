import { Button } from '@veduta/catalog/ui/button'
import { Input } from '@veduta/catalog/ui/input'
import type { CreateHimalayaConnectionRequest } from '@veduta/protocol'
import { useState } from 'react'
import type { ConnectionsController } from './connections-controller.ts'
import { ConnectionDetailBody, ConnectionDetailFooter } from './connections-layout.tsx'
import { createHimalayaConnection, installHimalaya } from './himalaya-connections-api.ts'

const fields = [
  { name: 'name', label: 'Connection name', type: 'text', placeholder: 'Personal mail' },
  { name: 'address', label: 'Email address', type: 'email', placeholder: 'you@example.com' },
  {
    name: 'imapServer',
    label: 'IMAP server URL',
    type: 'url',
    placeholder: 'imaps://imap.example.com:993',
  },
  { name: 'imapUsername', label: 'IMAP username', type: 'text', placeholder: 'you@example.com' },
  { name: 'imapPassword', label: 'IMAP password', type: 'password', placeholder: '' },
  {
    name: 'smtpServer',
    label: 'SMTP server URL',
    type: 'url',
    placeholder: 'smtps://smtp.example.com:465',
  },
  { name: 'smtpUsername', label: 'SMTP username', type: 'text', placeholder: 'you@example.com' },
  { name: 'smtpPassword', label: 'SMTP password', type: 'password', placeholder: '' },
] as const

export function HimalayaConnectionFields() {
  return (
    <>
      {fields.map((field) => (
        <label key={field.name} htmlFor={`himalaya-${field.name}`}>
          {field.label}
          <Input
            id={`himalaya-${field.name}`}
            name={field.name}
            type={field.type}
            placeholder={field.placeholder}
            autoComplete="off"
            required
            {...(field.name === 'name' ? { maxLength: 100 } : {})}
          />
        </label>
      ))}
    </>
  )
}

export function ConnectionMailboxSetup({
  controller,
  token,
  onCreated,
}: {
  controller: ConnectionsController
  token?: string
  onCreated: (id: string) => void
}) {
  const [notice, setNotice] = useState<string | null>(null)
  return (
    <>
      <ConnectionDetailBody>
        {controller.error && (
          <p role="alert" className="connections-alert">
            {controller.error}
          </p>
        )}
        {notice && <p role="status">{notice}</p>}
        <p>
          Get the IMAP and SMTP server URLs from your mail provider. Use an app password if your
          account requires one.
        </p>
        <form
          id="create-mailbox"
          className="connection-fields"
          onSubmit={(event) => {
            event.preventDefault()
            const form = event.currentTarget,
              data = new FormData(form)
            const input: CreateHimalayaConnectionRequest = {
              name: String(data.get('name') ?? '').trim(),
              address: String(data.get('address') ?? '').trim(),
              imapServer: String(data.get('imapServer') ?? '').trim(),
              imapUsername: String(data.get('imapUsername') ?? '').trim(),
              imapPassword: String(data.get('imapPassword') ?? ''),
              smtpServer: String(data.get('smtpServer') ?? '').trim(),
              smtpUsername: String(data.get('smtpUsername') ?? '').trim(),
              smtpPassword: String(data.get('smtpPassword') ?? ''),
            }
            form.reset()
            void controller.run(async () => {
              const result = await createHimalayaConnection(input, token)
              const created = result.connections.at(-1)
              if (created) onCreated(created.id)
            })
          }}
        >
          <HimalayaConnectionFields />
        </form>
        <p className="connection-note">
          Credentials are saved in the Gateway vault. Test both servers after adding the account.
          Setup does not fetch messages.
        </p>
        <details>
          <summary>Himalaya CLI setup</summary>
          <p>IMAP and SMTP require the reviewed Himalaya 2.1.0 release on the Gateway.</p>
          <Button
            variant="outline"
            disabled={controller.busy}
            onClick={() =>
              void controller.run(async () => {
                setNotice('Installing Himalaya 2.1.0…')
                const result = await installHimalaya(token)
                setNotice(null)
                if (result.state === 'failed')
                  throw new Error(result.reason ?? 'Himalaya installation failed')
                setNotice('Himalaya is ready. Test the mailbox connection next.')
              })
            }
          >
            Install reviewed release
          </Button>
        </details>
      </ConnectionDetailBody>
      <ConnectionDetailFooter>
        <Button type="submit" form="create-mailbox" disabled={controller.busy}>
          Add Mailbox
        </Button>
      </ConnectionDetailFooter>
    </>
  )
}
