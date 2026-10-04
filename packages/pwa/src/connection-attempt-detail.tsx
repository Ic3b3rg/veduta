import { Button } from '@veduta/catalog/ui/button'
import { Checkbox } from '@veduta/catalog/ui/checkbox'
import type { ConnectionAttempt } from '@veduta/protocol'
import { useState } from 'react'
import type { SpaceWithSurfaces } from './api.ts'
import type { ConnectionsController } from './connections-controller.ts'
import { ConnectionDetailBody, ConnectionDetailFooter } from './connections-layout.tsx'
import { ConnectionAuthorizationForm } from './connection-authorization-form.tsx'
import { ConnectionReview } from './connection-review.tsx'
import { confirmSpaceCapabilityGrant, serviceConnectionAction } from './service-connections-api.ts'

export function ConnectionAttemptDetail({
  attempt,
  spaces,
  controller,
  token,
  onDone,
}: {
  attempt: ConnectionAttempt
  spaces: SpaceWithSurfaces[]
  controller: ConnectionsController
  token?: string
  onDone: (connectionId?: string) => void
}) {
  const [canAuthorize, setCanAuthorize] = useState(false)
  const [spaceIds, setSpaceIds] = useState<string[]>([])
  const { busy, error, services, gmail } = controller
  const space = spaces.find((item) => item.id === attempt.spaceId)
  const existing = services?.connections.find((item) => item.id === attempt.connectionId)
  const granted =
    attempt.origin === 'chat' &&
    services?.grants.some(
      (grant) =>
        grant.enabled &&
        grant.spaceId === attempt.spaceId &&
        grant.connectionId === attempt.connectionId &&
        grant.authorizationRevision === existing?.authorizationRevision,
    )
  const action = (name: string) =>
    void controller.run(() => serviceConnectionAction(`attempts/${attempt.id}/${name}`, token))
  const confirm = async () => {
    if (!attempt.verifiedAccount) return
    const succeeded = await controller.run(() =>
      confirmSpaceCapabilityGrant(
        attempt.id,
        attempt.verifiedAccount!,
        attempt.verifiedScopes ?? [],
        token,
        attempt.origin === 'management' ? spaceIds : undefined,
      ),
    )
    if (succeeded) onDone(attempt.connectionId)
  }
  return (
    <>
      <ConnectionDetailBody>
        {error && (
          <p role="alert" className="connections-alert">
            {error}
          </p>
        )}
        <p role="status">
          State: <strong>{attempt.state.replaceAll('_', ' ')}</strong>
        </p>
        {attempt.origin === 'chat' && (
          <p className="connection-note">
            {attempt.requestSummary}
            <br />
            Space: <strong>{space?.name ?? attempt.spaceId}</strong>
          </p>
        )}
        {attempt.reason && <p role="status">{attempt.reason}</p>}
        {attempt.nextAction && <p>{attempt.nextAction}</p>}
        <ConnectionReview review={attempt.review} />
        {attempt.state === 'reviewing' && (
          <ConnectionAuthorizationForm
            onValidityChange={setCanAuthorize}
            attempt={attempt}
            existing={existing}
            gmailAccounts={gmail?.connections ?? []}
            controller={controller}
            {...(token ? { token } : {})}
          />
        )}
        {['authorizing', 'verifying'].includes(attempt.state) && (
          <p role="status">
            {attempt.state === 'authorizing'
              ? 'Waiting for authorization…'
              : 'Verifying the connection…'}
          </p>
        )}
        {attempt.state === 'ready' && (
          <>
            <h3>Verified account</h3>
            <p>
              <strong>{attempt.verifiedAccount}</strong>
            </p>
            <p>{attempt.verifiedScopes?.join(', ')}</p>
            {granted ? (
              <p role="status">
                Granted to {space?.name}. Request continuation: {attempt.continuation}.
              </p>
            ) : attempt.origin === 'management' ? (
              <>
                <h3>Allow access in Spaces</h3>
                <p>
                  Choose where the Agent can use this connection. Leave all unchecked to save the
                  account without Space access.
                </p>
                {spaces.map((item) => (
                  <div className="connection-check" key={item.id}>
                    <Checkbox
                      id={`grant-${item.id}`}
                      checked={spaceIds.includes(item.id)}
                      onCheckedChange={(value) =>
                        setSpaceIds((current) =>
                          value === true
                            ? [...current, item.id]
                            : current.filter((id) => id !== item.id),
                        )
                      }
                    />
                    <label htmlFor={`grant-${item.id}`}>{item.name}</label>
                  </div>
                ))}
              </>
            ) : (
              <p>
                Confirm access for {space?.name ?? attempt.spaceId} to resume the original request
                once.
              </p>
            )}
          </>
        )}
        {attempt.state === 'cancelled' && <p role="status">Connection setup cancelled.</p>}
      </ConnectionDetailBody>
      <ConnectionDetailFooter>
        {['failed', 'unsupported', 'needs_reconnect'].includes(attempt.state) && (
          <Button disabled={busy} onClick={() => action('retry')}>
            Return to review
          </Button>
        )}
        {attempt.state === 'reviewing' && (
          <Button type="submit" form={`authorize-${attempt.id}`} disabled={!canAuthorize || busy}>
            {existing?.state === 'ready' && attempt.origin === 'management'
              ? 'Use verified account'
              : attempt.review.service === 'gmail'
                ? 'Continue to Google'
                : 'Verify GitHub'}
          </Button>
        )}
        {attempt.state === 'ready' && !granted && (
          <Button disabled={busy || !attempt.verifiedAccount} onClick={() => void confirm()}>
            {attempt.origin === 'chat'
              ? `Grant to ${space?.name ?? 'Space'} and resume`
              : 'Save access'}
          </Button>
        )}
        {!['cancelled', 'ready', 'failed', 'unsupported'].includes(attempt.state) && (
          <Button
            variant="outline"
            disabled={busy}
            onClick={async () => {
              if (
                await controller.run(() =>
                  serviceConnectionAction(`attempts/${attempt.id}/cancel`, token),
                )
              )
                onDone()
            }}
          >
            Cancel setup
          </Button>
        )}
        {granted && (
          <Button variant="outline" onClick={() => onDone(attempt.connectionId)}>
            Done
          </Button>
        )}
      </ConnectionDetailFooter>
    </>
  )
}
