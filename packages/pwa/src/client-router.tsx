import type { ReactNode } from 'react'
import {
  Navigate,
  Route,
  Routes,
  useLocation,
  useMatch,
  useNavigate,
  type NavigateFunction,
} from 'react-router-dom'

const CLIENT_ROUTE_PATTERN = {
  home: '/',
  setup: '/setup',
  modelConnections: '/app/settings/models',
  space: '/app/space/:spaceSlug',
  surface: '/app/space/:spaceSlug/surface/:surfaceId',
} as const

export const clientPath = {
  home: CLIENT_ROUTE_PATTERN.home,
  setup: CLIENT_ROUTE_PATTERN.setup,
  modelConnections: CLIENT_ROUTE_PATTERN.modelConnections,
  space: (spaceSlug: string) =>
    pathFromPattern(CLIENT_ROUTE_PATTERN.space, {
      spaceSlug,
    }),
  surface: (spaceSlug: string, surfaceId: string) =>
    pathFromPattern(CLIENT_ROUTE_PATTERN.surface, {
      spaceSlug,
      surfaceId,
    }),
} as const

function pathFromPattern(pattern: string, parameters: Record<string, string>): string {
  return Object.entries(parameters).reduce(
    (path, [name, value]) => path.replace(`:${name}`, encodeURIComponent(value)),
    pattern,
  )
}

export function useClientRouting(): {
  navigate: NavigateFunction
  locationKey: string
  spaceSlug: string | undefined
  surfaceId: string | undefined
} {
  const navigate = useNavigate()
  const location = useLocation()
  const surfaceMatch = useMatch(CLIENT_ROUTE_PATTERN.surface)
  const spaceMatch = useMatch(CLIENT_ROUTE_PATTERN.space)

  return {
    navigate,
    locationKey: location.key,
    spaceSlug: surfaceMatch?.params.spaceSlug ?? spaceMatch?.params.spaceSlug,
    surfaceId: surfaceMatch?.params.surfaceId,
  }
}

export function ClientRouteTable({
  appShell,
  modelConnections,
}: {
  appShell: ReactNode
  modelConnections: ReactNode
}) {
  return (
    <Routes>
      <Route path={CLIENT_ROUTE_PATTERN.home} element={appShell} />
      <Route
        path={CLIENT_ROUTE_PATTERN.setup}
        element={<Navigate to={clientPath.home} replace />}
      />
      <Route path={CLIENT_ROUTE_PATTERN.modelConnections} element={modelConnections} />
      <Route path={CLIENT_ROUTE_PATTERN.space} element={appShell} />
      <Route path={CLIENT_ROUTE_PATTERN.surface} element={appShell} />
      <Route path="*" element={<Navigate to={clientPath.home} replace />} />
    </Routes>
  )
}
