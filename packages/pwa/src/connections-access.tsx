import type { SpaceWithSurfaces } from './api.ts'
import type { ConnectionsController } from './connections-controller.ts'
import { ConnectionGrantRow } from './connection-grant-row.tsx'

export function ConnectionsAccess({
  controller,
  spaces,
  token,
}: {
  controller: ConnectionsController
  spaces: SpaceWithSurfaces[]
  token?: string
}) {
  return (
    <section className="connections-section">
      <header className="connections-heading">
        <div>
          <h1>Space access</h1>
          <p>Explicit permissions for each Space.</p>
        </div>
      </header>
      {controller.error && (
        <p role="alert" className="connections-alert">
          {controller.error}
        </p>
      )}
      {!controller.services && !controller.error && <p role="status">Loading Space access…</p>}
      {spaces.map((space) => {
        const grants =
          controller.services?.grants.filter((grant) => grant.spaceId === space.id) ?? []
        return (
          <section key={space.id}>
            <h2 className="connections-group-title">{space.name}</h2>
            {grants.length === 0 && (
              <p>No service access granted. Open an account's details to add access.</p>
            )}
            {grants.map((grant) => (
              <ConnectionGrantRow
                key={grant.id}
                grant={grant}
                connection={controller.services?.connections.find(
                  (item) => item.id === grant.connectionId,
                )}
                controller={controller}
                {...(token ? { token } : {})}
              />
            ))}
          </section>
        )
      })}
    </section>
  )
}
