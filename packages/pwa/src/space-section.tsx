import type { Surface } from '@veduta/protocol'
import { freshnessLabel, type SpaceWithSurfaces } from './api.ts'
import { AttentionBadge } from './attention-badge.tsx'
import { mergeSurfaceOrder } from './home-state.ts'
import type { QueuedFastAction } from './pwa-storage.ts'
import { SurfaceCard } from './surface-card.tsx'

export function SpaceSection({
  space,
  authToken,
  focused,
  focusedSurfaceId,
  surfaceOrder,
  onFocus,
  onMoveSurface,
  onPatched,
  onQueueFastAction,
  onError,
}: {
  space: SpaceWithSurfaces
  authToken: string | undefined
  focused: boolean
  focusedSurfaceId: string | undefined
  surfaceOrder: string[]
  onFocus: (space: SpaceWithSurfaces, surface?: Surface) => void
  onMoveSurface: (space: SpaceWithSurfaces, surfaceId: string, offset: -1 | 1) => void
  onPatched: (surface: Surface) => void
  onQueueFastAction: (action: QueuedFastAction) => void
  onError: (message: string) => void
}) {
  const ids = mergeSurfaceOrder(
    space.surfaces.map((surface) => surface.id),
    surfaceOrder,
  )
  const surfaces = ids
    .map((id) => space.surfaces.find((surface) => surface.id === id))
    .filter((surface): surface is Surface => Boolean(surface))

  return (
    <section
      className={focused ? 'space-section focused' : 'space-section'}
      aria-labelledby={`${space.id}-title`}
    >
      <div className="space-heading">
        <div>
          <h2 id={`${space.id}-title`}>{space.name}</h2>
          <p>{freshestLabel(surfaces)}</p>
        </div>
        <span className="badge-group">
          <AttentionBadge count={space.attention} />
          <span className="space-badge">{surfaces.length} Surfaces</span>
        </span>
      </div>
      <div className="surface-grid">
        {surfaces.map((surface, index) => (
          <SurfaceCard
            key={surface.id}
            surface={surface}
            token={authToken}
            selected={surface.id === focusedSurfaceId}
            canMoveUp={index > 0}
            canMoveDown={index < surfaces.length - 1}
            onFocus={() => onFocus(space, surface)}
            onMoveUp={() => onMoveSurface(space, surface.id, -1)}
            onMoveDown={() => onMoveSurface(space, surface.id, 1)}
            onPatched={onPatched}
            onQueueFastAction={onQueueFastAction}
            onError={onError}
          />
        ))}
      </div>
    </section>
  )
}

function freshestLabel(surfaces: Surface[]): string {
  const latest = surfaces
    .map((surface) => Date.parse(surface.freshness.updatedAt))
    .filter(Number.isFinite)
    .sort((left, right) => right - left)[0]
  return latest ? `freshest ${freshnessLabel(new Date(latest).toISOString())}` : 'no Surfaces'
}
