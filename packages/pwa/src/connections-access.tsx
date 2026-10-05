import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@veduta/catalog/ui/accordion'
import { Badge } from '@veduta/catalog/ui/badge'
import { Button } from '@veduta/catalog/ui/button'
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from '@veduta/catalog/ui/item'
import { Skeleton } from '@veduta/catalog/ui/skeleton'
import { Link } from 'react-router-dom'
import type { SpaceWithSurfaces } from './api.ts'
import { clientPath } from './client-router.tsx'
import type { ConnectionsController } from './connections-controller.ts'
import { ConnectionGrantRow, isSpaceGrantActive } from './connection-grant-row.tsx'
import { ConnectionsSection } from './connections-section.tsx'

function ManageAccounts() {
  return (
    <Button asChild variant="outline">
      <Link to={clientPath.serviceConnections}>Manage accounts</Link>
    </Button>
  )
}

export function ConnectionsAccess({
  controller,
  spaces,
  token,
}: {
  controller: ConnectionsController
  spaces: SpaceWithSurfaces[]
  token?: string
}) {
  const { services, error } = controller
  const connectionsById = new Map(
    services?.connections.map((connection) => [connection.id, connection]),
  )
  const groups = spaces
    .map((space) => ({
      space,
      grants: services?.grants.filter((grant) => grant.spaceId === space.id) ?? [],
    }))
    .sort((left, right) => Number(right.grants.length > 0) - Number(left.grants.length > 0))
  const firstSpace = groups[0]?.space
  return (
    <ConnectionsSection
      title="Space access"
      description="Choose a Space to review the accounts and permissions it can use."
      actions={<ManageAccounts />}
    >
      {error && (
        <div className="connections-load-error">
          <p role="alert" className="connections-alert">
            {error}
          </p>
          {!services && (
            <Button variant="outline" onClick={() => void controller.refresh()}>
              Try again
            </Button>
          )}
        </div>
      )}
      {!services && !error && (
        <div role="status" className="connections-loading">
          <span className="sr-only">Loading Space access…</span>
          {[0, 1, 2].map((item) => (
            <Skeleton key={item} className="h-20 w-full rounded-lg" />
          ))}
        </div>
      )}
      {services && spaces.length === 0 && (
        <Item variant="outline">
          <ItemContent>
            <ItemTitle>No Spaces yet</ItemTitle>
            <ItemDescription>
              Create a Space from Home, then choose which accounts it can use.
            </ItemDescription>
          </ItemContent>
          <ItemActions>
            <Button asChild variant="outline">
              <Link to={clientPath.home}>Go to Home</Link>
            </Button>
          </ItemActions>
        </Item>
      )}
      {services && spaces.length > 0 && (
        <Accordion
          type="multiple"
          defaultValue={firstSpace ? [firstSpace.id] : []}
          className="connections-spaces"
        >
          {groups.map(({ space, grants }) => {
            const activeCount = grants.filter((grant) =>
              isSpaceGrantActive(grant, connectionsById.get(grant.connectionId)),
            ).length
            const unavailableCount = grants.filter((grant) => grant.enabled).length - activeCount
            return (
              <AccordionItem key={space.id} value={space.id} className="connections-space">
                <AccordionTrigger className="connections-space-trigger">
                  <span className="connections-space-summary">
                    <span className="connections-space-name">{space.name}</span>
                    <span className="connections-space-count">
                      {grants.length === 0
                        ? 'No service access'
                        : `${activeCount} enabled · ${grants.length} ${grants.length === 1 ? 'permission' : 'permissions'}`}
                    </span>
                  </span>
                  {unavailableCount > 0 && (
                    <Badge variant="outline">{unavailableCount} to review</Badge>
                  )}
                </AccordionTrigger>
                <AccordionContent className="connections-space-content">
                  {grants.length === 0 ? (
                    <Item className="connection-access-row">
                      <ItemContent>
                        <ItemTitle>No accounts available in {space.name}</ItemTitle>
                        <ItemDescription>
                          Open an account, review its access and select this Space to grant
                          permission.
                        </ItemDescription>
                      </ItemContent>
                      <ItemActions>
                        <ManageAccounts />
                      </ItemActions>
                    </Item>
                  ) : (
                    <ItemGroup>
                      {grants.map((grant) => (
                        <ConnectionGrantRow
                          key={grant.id}
                          grant={grant}
                          connection={connectionsById.get(grant.connectionId)}
                          controller={controller}
                          {...(token ? { token } : {})}
                        />
                      ))}
                    </ItemGroup>
                  )}
                </AccordionContent>
              </AccordionItem>
            )
          })}
        </Accordion>
      )}
    </ConnectionsSection>
  )
}
