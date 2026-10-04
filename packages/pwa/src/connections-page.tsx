import { Badge } from '@veduta/catalog/ui/badge'
import { Button } from '@veduta/catalog/ui/button'
import { useEffect } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import type { SpaceWithSurfaces } from './api.ts'
import { clientPath } from './client-router.tsx'
import { useConnectionsController } from './connections-controller.ts'
import { ConnectionsLayout, type ConnectionsSection } from './connections-layout.tsx'
import { ConnectionsServices } from './connections-services.tsx'
import { ConnectionsModels } from './connections-models.tsx'
import { ConnectionsAccess } from './connections-access.tsx'
import './styles/connections-page.css'

export function ConnectionsPage({
  token,
  spaces,
  initialSection = 'services',
}: {
  token?: string | undefined
  spaces: SpaceWithSurfaces[]
  initialSection?: ConnectionsSection
}) {
  const location = useLocation()
  const value = new URLSearchParams(location.search).get('section')
  const section =
    value === 'models' || value === 'extensions' || value === 'access' || value === 'services'
      ? value
      : initialSection
  const controller = useConnectionsController(token)
  const navigate = useNavigate()
  const { callbackAttemptId, acknowledgeCallback } = controller
  useEffect(() => {
    if (!callbackAttemptId) return
    navigate(`${clientPath.serviceConnections}?attempt=${encodeURIComponent(callbackAttemptId)}`, {
      replace: true,
    })
    acknowledgeCallback()
  }, [callbackAttemptId, acknowledgeCallback, navigate])
  return (
    <ConnectionsLayout section={section}>
      {section === 'services' && (
        <ConnectionsServices
          controller={controller}
          spaces={spaces}
          {...(token ? { token } : {})}
        />
      )}
      {section === 'models' && <ConnectionsModels {...(token ? { token } : {})} />}
      {section === 'access' && (
        <ConnectionsAccess controller={controller} spaces={spaces} {...(token ? { token } : {})} />
      )}
      {section === 'extensions' && <ConnectionsExtensions />}
    </ConnectionsLayout>
  )
}

function ConnectionsExtensions() {
  return (
    <section className="connections-section">
      <header className="connections-heading">
        <div>
          <h1>Extensions</h1>
          <p>Reviewed capabilities available in this Veduta version.</p>
        </div>
      </header>
      <div className="connections-row">
        <div>
          <h3>Mailbox</h3>
          <p>Gmail through Google OAuth; other providers through Himalaya 2.1.0.</p>
          <p>Connect and verify an account in Accounts & services.</p>
        </div>
        <Badge variant="outline">Included</Badge>
      </div>
      <div className="connections-row">
        <div>
          <h3>GitHub MCP Server</h3>
          <p>Reviewed v1.12.2 · local process on the Gateway.</p>
          <p>
            The server is installed during authorized setup. An account and repository grant are
            required to use it.
          </p>
        </div>
        <Badge variant="outline">Available to connect</Badge>
      </div>
      <p>
        <Button asChild variant="outline">
          <Link to={clientPath.serviceConnections}>Manage accounts</Link>
        </Button>
      </p>
    </section>
  )
}
