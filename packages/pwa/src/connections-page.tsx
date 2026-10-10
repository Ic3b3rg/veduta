import { useEffect } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import type { SpaceWithSurfaces } from './api.ts'
import { clientPath } from './client-router.tsx'
import { useConnectionsController } from './connections-controller.ts'
import { ConnectionsLayout, type ConnectionsSection } from './connections-layout.tsx'
import { ConnectionsServices } from './connections-services.tsx'
import { ConnectionsModels } from './connections-models.tsx'
import { ConnectionsAccess } from './connections-access.tsx'
import { ConnectionsExtensions } from './connections-extensions.tsx'
import { ConnectionsDevices } from './connections-devices.tsx'
import { ConnectionsSpaces } from './connections-spaces.tsx'
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
    value === 'models' ||
    value === 'extensions' ||
    value === 'access' ||
    value === 'services' ||
    value === 'devices' ||
    value === 'spaces' ||
    value === 'automations'
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
      {section === 'devices' && <ConnectionsDevices token={token} />}
      {(section === 'spaces' || section === 'automations') && (
        <ConnectionsSpaces key={section} section={section} token={token} />
      )}
    </ConnectionsLayout>
  )
}
