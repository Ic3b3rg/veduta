import type { Surface, SurfaceMoveDirection } from '@veduta/protocol'
import { freshnessLabel, type SpaceWithSurfaces } from './api.ts'
import { AttentionBadge } from './attention-badge.tsx'
import type { QueuedFastAction } from './pwa-storage.ts'
import { SurfaceCard } from './surface-card.tsx'

export function SpaceSection({
  space,
  authToken,
  focused,
  focusedSurfaceId,
  surfaceCreationFeedbackKeys,
  onFocus,
  onMoveSurface,
  onPatched,
  onQueueFastAction,
  onTogglePin,
  onSurfaceCreationFeedbackShown,
  onError,
}: {
  space: SpaceWithSurfaces
  authToken: string | undefined
  focused: boolean
  focusedSurfaceId: string | undefined
  surfaceCreationFeedbackKeys: Record<string, string>
  onFocus: (space: SpaceWithSurfaces, surface?: Surface) => void
  onMoveSurface: (
    space: SpaceWithSurfaces,
    surfaceId: string,
    direction: SurfaceMoveDirection,
  ) => void
  onPatched: (surface: Surface) => void
  onQueueFastAction: (action: QueuedFastAction) => void
  onTogglePin: (surface: Surface, pinned: boolean) => void
  onSurfaceCreationFeedbackShown: (surfaceId: string, feedbackKey: string) => void
  onError: (message: string) => void
}) {
  const surfaces = space.surfaces

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
            creationFeedbackKey={surfaceCreationFeedbackKeys[surface.id]}
            canMoveUp={index > 0}
            canMoveDown={index < surfaces.length - 1}
            onFocus={() => onFocus(space, surface)}
            onMoveUp={() => onMoveSurface(space, surface.id, 'up')}
            onMoveDown={() => onMoveSurface(space, surface.id, 'down')}
            onPatched={onPatched}
            onQueueFastAction={onQueueFastAction}
            onTogglePin={(pinned) => onTogglePin(surface, pinned)}
            onCreationFeedbackShown={(feedbackKey) =>
              onSurfaceCreationFeedbackShown(surface.id, feedbackKey)
            }
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
