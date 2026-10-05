import { Button } from '@veduta/catalog/ui/button'
import type { CreateServiceConnectionAttemptRequest, ServiceConnection } from '@veduta/protocol'
import { useRef } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import type { SpaceWithSurfaces } from './api.ts'
import type { ConnectionsController } from './connections-controller.ts'
import { ConnectionDetail, ConnectionListItem } from './connections-layout.tsx'
import { ConnectionAttemptDetail } from './connection-attempt-detail.tsx'
import { ConnectionCreate } from './connection-create.tsx'
import { ConnectionMailboxDetail } from './connection-mailbox-detail.tsx'
import { ConnectionMailboxSetup } from './connection-mailbox-setup.tsx'
import { ConnectionServiceDetail } from './connection-service-detail.tsx'
import {
  createServiceConnectionAttempt,
  serviceConnectionAction,
} from './service-connections-api.ts'

type Selection = {
  kind: 'new' | 'mailbox-setup' | 'attempt' | 'service' | 'gmail' | 'himalaya'
  id: string
}

export function ConnectionsServices({
  controller,
  spaces,
  token,
}: {
  controller: ConnectionsController
  spaces: SpaceWithSurfaces[]
  token?: string
}) {
  const location = useLocation()
  const navigate = useNavigate()
  const params = new URLSearchParams(location.search)
  const attemptId = params.get('attempt')
  const [kind, id = ''] = (params.get('detail') ?? '').split(':')
  const selection: Selection | null = attemptId
    ? { kind: 'attempt', id: attemptId }
    : kind === 'new' ||
        kind === 'mailbox-setup' ||
        kind === 'service' ||
        kind === 'gmail' ||
        kind === 'himalaya'
      ? { kind, id }
      : null
  const setSelection = (next: Selection | null) => {
    controller.clearError()
    const query = new URLSearchParams(location.search)
    for (const key of [
      'attempt',
      'detail',
      'code',
      'state',
      'error',
      'scope',
      'authuser',
      'prompt',
    ])
      query.delete(key)
    if (next?.kind === 'attempt') query.set('attempt', next.id)
    else if (next) query.set('detail', `${next.kind}:${next.id}`)
    navigate(`${location.pathname}${query.size ? `?${query}` : ''}`, { replace: true })
  }
  const opener = useRef<HTMLElement | null>(null)
  const addButton = useRef<HTMLButtonElement | null>(null)
  const { services, gmail, himalaya, busy, error } = controller
  const open = (kind: Selection['kind'], id = '') => {
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    setSelection({ kind, id })
  }
  const attempt =
    selection?.kind === 'attempt'
      ? services?.attempts.find((item) => item.id === selection.id)
      : undefined
  const connection =
    selection?.kind === 'service'
      ? services?.connections.find((item) => item.id === selection.id && item.state !== 'removed')
      : undefined
  const gmailAccount =
    selection?.kind === 'gmail'
      ? gmail?.connections.find((item) => item.id === selection.id)
      : undefined
  const mailbox =
    selection?.kind === 'himalaya'
      ? himalaya?.connections.find((item) => item.id === selection.id)
      : undefined
  const connections = services?.connections.filter((item) => item.state !== 'removed') ?? []
  const legacyGmail =
    gmail?.connections
      .filter((item) => !connections.some((connection) => connection.id === item.id))
      .filter(
        (item) => !services?.attempts.some((attempt) => attempt.createdConnectionId === item.id),
      ) ?? []
  const close = async () => {
    if (busy) return
    if (
      attempt?.origin === 'management' &&
      attempt.state !== 'ready' &&
      !(await controller.run(() => serviceConnectionAction(`attempts/${attempt.id}/cancel`, token)))
    )
      return
    setSelection(null)
  }
  const review = async (input: Omit<CreateServiceConnectionAttemptRequest, 'submissionId'>) => {
    let attemptId: string | undefined
    const succeeded = await controller.run(async () => {
      const submissionId = crypto.randomUUID()
      const snapshot = await createServiceConnectionAttempt({ ...input, submissionId }, token)
      const created = snapshot.attempts.find((item) => item.submissionId === submissionId)
      attemptId = created?.id
    })
    if (succeeded && attemptId) setSelection({ kind: 'attempt', id: attemptId })
  }
  const reviewConnection = (connection: ServiceConnection) => {
    const previousReview = services?.attempts
      .filter((item) => item.connectionId === connection.id)
      .at(-1)?.review
    review({
      service: connection.service,
      connectionId: connection.id,
      ...(previousReview?.repository ? { repository: previousReview.repository } : {}),
    })
  }
  const selectedTitle = attempt
    ? `${attempt.review.service === 'gmail' ? 'Gmail' : 'GitHub'} setup`
    : (connection?.account ??
      gmailAccount?.name ??
      mailbox?.name ??
      (selection?.kind === 'mailbox-setup' ? 'Connect a mailbox' : 'Add account'))
  const hasDetail =
    selection?.kind === 'new' ||
    selection?.kind === 'mailbox-setup' ||
    attempt ||
    connection ||
    gmailAccount ||
    mailbox

  return (
    <>
      <header className="connections-heading">
        <div>
          <h1>Accounts & services</h1>
          <p>Connected accounts and the Spaces that can use them.</p>
        </div>
        <Button ref={addButton} disabled={!services || busy} onClick={() => open('new')}>
          Add account
        </Button>
      </header>
      {error && !hasDetail && (
        <p className="connections-alert" role="alert">
          {error}
        </p>
      )}
      {services && selection?.kind === 'attempt' && !attempt && (
        <p role="alert">This connection setup request is no longer available.</p>
      )}
      {!services && !error && <p role="status">Loading connections…</p>}
      <div className="connections-workspace">
        <div className="connections-list">
          <h2 className="connections-group-title">Your accounts</h2>
          <div className="connections-grid">
            {connections.map((item) => (
              <ConnectionListItem
                key={item.id}
                title={item.service === 'gmail' ? 'Gmail' : 'GitHub'}
                subtitle={item.account}
                state={item.state}
                selected={selection?.kind === 'service' && selection.id === item.id}
                returnFocusRef={opener}
                onClick={() => open('service', item.id)}
              >
                {services?.grants
                  .filter((grant) => grant.connectionId === item.id && grant.enabled)
                  .map(
                    (grant) =>
                      spaces.find((space) => space.id === grant.spaceId)?.name ?? grant.spaceId,
                  )
                  .join(', ') || 'No Space access'}
              </ConnectionListItem>
            ))}
            {legacyGmail.map((item) => (
              <ConnectionListItem
                key={item.id}
                title={item.name}
                subtitle={item.accountEmail ?? 'Gmail · account not verified'}
                state={item.state}
                selected={selection?.kind === 'gmail' && selection.id === item.id}
                returnFocusRef={opener}
                onClick={() => open('gmail', item.id)}
              >
                Gmail · review Space access in details
              </ConnectionListItem>
            ))}
            {himalaya?.connections.map((item) => (
              <ConnectionListItem
                key={item.id}
                title={item.name}
                subtitle={item.address ?? item.imapServer}
                state={item.state}
                selected={selection?.kind === 'himalaya' && selection.id === item.id}
                returnFocusRef={opener}
                onClick={() => open('himalaya', item.id)}
              >
                IMAP and SMTP
              </ConnectionListItem>
            ))}
          </div>
          {services &&
            gmail &&
            himalaya &&
            connections.length + legacyGmail.length + himalaya.connections.length === 0 && (
              <div className="connections-empty">
                <p>No accounts connected yet.</p>
                <Button variant="outline" onClick={() => open('new')}>
                  Connect your first account
                </Button>
              </div>
            )}
        </div>
        {hasDetail && (
          <ConnectionDetail
            title={selectedTitle}
            description={
              attempt
                ? 'Review → authorize → choose Space access'
                : selection?.kind === 'new'
                  ? 'Gmail, GitHub or another mail provider.'
                  : 'Account settings and access.'
            }
            onClose={() => void close()}
            opener={opener}
            fallbackOpener={addButton}
            modal={
              selection?.kind === 'new' || selection?.kind === 'mailbox-setup' || Boolean(attempt)
            }
            busy={busy}
          >
            {selection?.kind === 'new' && (
              <ConnectionCreate
                controller={controller}
                {...(token ? { token } : {})}
                onAttempt={(id) => setSelection({ kind: 'attempt', id })}
                onMailbox={() => setSelection({ kind: 'mailbox-setup', id: '' })}
              />
            )}
            {selection?.kind === 'mailbox-setup' && (
              <ConnectionMailboxSetup
                controller={controller}
                {...(token ? { token } : {})}
                onCreated={() => setSelection(null)}
              />
            )}
            {attempt && (
              <ConnectionAttemptDetail
                key={`${attempt.id}:${attempt.updatedAt}`}
                attempt={attempt}
                spaces={spaces}
                controller={controller}
                {...(token ? { token } : {})}
                onDone={() => setSelection(null)}
              />
            )}
            {connection && (
              <ConnectionServiceDetail
                connection={connection}
                controller={controller}
                spaces={spaces}
                {...(token ? { token } : {})}
                onReview={() => reviewConnection(connection)}
                onUpgrade={() =>
                  review({
                    service: 'github',
                    connectionId: connection.id,
                    renewAuthorization: true,
                  })
                }
                onRemoved={() => setSelection(null)}
              />
            )}
            {(gmailAccount || mailbox) && (
              <ConnectionMailboxDetail
                {...(gmailAccount ? { gmail: gmailAccount } : {})}
                {...(mailbox ? { himalaya: mailbox } : {})}
                controller={controller}
                {...(token ? { token } : {})}
                onReview={() => {
                  if (gmailAccount) review({ service: 'gmail', connectionId: gmailAccount.id })
                }}
                onAuthorize={() => {
                  if (gmailAccount)
                    review({
                      service: 'gmail',
                      connectionId: gmailAccount.id,
                      renewAuthorization: true,
                    })
                }}
                onRemoved={() => setSelection(null)}
              />
            )}
          </ConnectionDetail>
        )}
      </div>
    </>
  )
}
