import { Button } from '@veduta/catalog/ui/button'
import { Badge } from '@veduta/catalog/ui/badge'
import { Item, ItemActions, ItemContent, ItemDescription, ItemTitle } from '@veduta/catalog/ui/item'
import type { ServiceConnection, SpaceCapabilityGrant } from '@veduta/protocol'
import { Link } from 'react-router-dom'
import { clientPath } from './client-router.tsx'
import type { ConnectionsController } from './connections-controller.ts'
import { serviceConnectionAction } from './service-connections-api.ts'
import { serviceActionLabel } from './service-action-label.ts'

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
  const title =
    spaceName ??
    (connection
      ? `${connection.service === 'github' ? 'GitHub' : 'Gmail'} · ${connection.account}`
      : 'Unavailable account')
  const repositories =
    grant.repositoryScope?.mode === 'authorized'
      ? 'All authorized repositories'
      : grant.repositoryScope?.mode === 'selected'
        ? grant.repositoryScope.repositories.map((repo) => `${repo.owner}/${repo.name}`).join(', ')
        : grant.repository
          ? `${grant.repository.owner}/${grant.repository.name}`
          : undefined
  return (
    <Item role="listitem" aria-label={title} className="connection-access-row">
      <ItemContent className="min-w-0">
        <ItemTitle className="w-full flex-wrap">
          <h3>{title}</h3>
          <Badge variant="outline" className={active ? 'connection-status-enabled' : undefined}>
            {active ? 'Enabled' : grant.enabled ? 'Needs review' : 'Disabled'}
          </Badge>
        </ItemTitle>
        <ItemDescription>{grant.actions.map(serviceActionLabel).join(', ')}</ItemDescription>
        {repositories && <ItemDescription>{repositories}</ItemDescription>}
        {grant.enabled && !active && (
          <ItemDescription>
            Review the account connection before this Space can use it.
          </ItemDescription>
        )}
      </ItemContent>
      <ItemActions className="flex-wrap">
        {!spaceName && connection && connection.state !== 'removed' && (
          <Button asChild variant="ghost" size="sm">
            <Link
              to={`${clientPath.serviceConnections}?detail=${encodeURIComponent(`service:${connection.id}`)}`}
            >
              Review access
            </Link>
          </Button>
        )}
        {grant.enabled && (
          <Button
            variant="outline"
            size="sm"
            disabled={controller.busy}
            onClick={() =>
              void controller.run(() =>
                serviceConnectionAction(`grants/${grant.id}/disable`, token),
              )
            }
          >
            Disable access
          </Button>
        )}
      </ItemActions>
    </Item>
  )
}
