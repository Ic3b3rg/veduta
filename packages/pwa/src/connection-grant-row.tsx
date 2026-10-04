import { Button } from '@veduta/catalog/ui/button'
import type { ServiceConnection, SpaceCapabilityGrant } from '@veduta/protocol'
import type { ConnectionsController } from './connections-controller.ts'
import { serviceConnectionAction } from './service-connections-api.ts'

export function isSpaceGrantActive(
  grant: SpaceCapabilityGrant,
  connection: ServiceConnection | undefined,
): boolean {
  return (
    grant.enabled &&
    connection?.state === 'ready' &&
    grant.authorizationRevision === connection.authorizationRevision
  )
}

export function ConnectionGrantRow({
  grant,
  connection,
  spaceName,
  controller,
  token,
}: {
  grant: SpaceCapabilityGrant
  connection: ServiceConnection | undefined
  spaceName?: string
  controller: ConnectionsController
  token?: string
}) {
  const active = isSpaceGrantActive(grant, connection)
  return (
    <div className="connections-row">
      <div>
        <h3>
          {spaceName ??
            `${connection?.service === 'github' ? 'GitHub' : 'Gmail'} · ${connection?.account ?? grant.connectionId}`}
        </h3>
        <p>
          {grant.repository ? `${grant.repository.owner}/${grant.repository.name} · ` : ''}
          {grant.actions.join(', ')}
        </p>
        <p>
          {active ? 'Enabled' : grant.enabled ? 'Unavailable — review the connection' : 'Disabled'}
        </p>
      </div>
      {grant.enabled && (
        <Button
          variant="outline"
          size="sm"
          disabled={controller.busy}
          onClick={() =>
            void controller.run(() => serviceConnectionAction(`grants/${grant.id}/disable`, token))
          }
        >
          Disable access
        </Button>
      )}
    </div>
  )
}
