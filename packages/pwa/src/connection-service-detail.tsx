import { Button } from '@veduta/catalog/ui/button'
import { ItemGroup } from '@veduta/catalog/ui/item'
import type { ServiceConnection } from '@veduta/protocol'
import type { SpaceWithSurfaces } from './api.ts'
import type { ConnectionsController } from './connections-controller.ts'
import { ConnectionDetailBody, ConnectionDetailFooter } from './connections-layout.tsx'
import { removeServiceConnection, serviceConnectionAction } from './service-connections-api.ts'
import { ConnectionGrantRow, isSpaceGrantActive } from './connection-grant-row.tsx'

export function ConnectionServiceDetail({
  connection,
  controller,
  spaces,
  token,
  onReview,
  onUpgrade,
  onRemoved,
}: {
  connection: ServiceConnection
  controller: ConnectionsController
  spaces: SpaceWithSurfaces[]
  token?: string
  onReview: () => void
  onUpgrade: () => void
  onRemoved: () => void
}) {
  const grants =
    controller.services?.grants.filter((item) => item.connectionId === connection.id) ?? []
  return (
    <>
      <ConnectionDetailBody>
        {controller.error && (
          <p role="alert" className="connections-alert">
            {controller.error}
          </p>
        )}
        <dl className="connection-review">
          <div>
            <dt>Account</dt>
            <dd>{connection.account}</dd>
          </div>
          <div>
            <dt>Status</dt>
            <dd>{connection.state.replaceAll('_', ' ')}</dd>
          </div>
          <div>
            <dt>Access</dt>
            <dd>{connection.scopes.join(', ')}</dd>
          </div>
          <div>
            <dt>Runs on</dt>
            <dd>{connection.executionHost}</dd>
          </div>
        </dl>
        {connection.reason && <p role="status">{connection.reason}</p>}
        <h3>Space access</h3>
        {grants.filter((grant) => isSpaceGrantActive(grant, connection)).length === 0 && (
          <p>This account has no enabled Space access.</p>
        )}
        <ItemGroup>
          {grants.map((grant) => (
            <ConnectionGrantRow
              key={grant.id}
              grant={grant}
              connection={connection}
              spaceName={spaces.find((space) => space.id === grant.spaceId)?.name ?? grant.spaceId}
              controller={controller}
              {...(token ? { token } : {})}
            />
          ))}
        </ItemGroup>
        <p className="connection-note">
          The Agent uses this connection only for requested work in authorized Spaces.
        </p>
      </ConnectionDetailBody>
      <ConnectionDetailFooter>
        {connection.state === 'ready' ? (
          <>
            <Button disabled={controller.busy} onClick={onReview}>
              Review Space access
            </Button>
            <Button
              variant="outline"
              disabled={controller.busy}
              onClick={() =>
                void controller.run(() =>
                  serviceConnectionAction(`${connection.id}/disable`, token),
                )
              }
            >
              Disable
            </Button>
          </>
        ) : (
          <Button disabled={controller.busy} onClick={onReview}>
            Reconnect
          </Button>
        )}
        {connection.service === 'github' &&
          !connection.scopes.includes('GitHub Contents: read') && (
            <Button variant="outline" disabled={controller.busy} onClick={onUpgrade}>
              Enable repository discovery and files
            </Button>
          )}
        <Button
          variant="outline"
          disabled={controller.busy}
          onClick={async () => {
            if (
              window.confirm(`Remove ${connection.account} and its saved authorization?`) &&
              (await controller.run(() => removeServiceConnection(connection.id, token)))
            )
              onRemoved()
          }}
        >
          Remove
        </Button>
      </ConnectionDetailFooter>
    </>
  )
}
