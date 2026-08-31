import type { Surface, SurfaceMoveDirection } from '@veduta/protocol'
import { freshnessLabel, type SpaceWithSurfaces } from './api.ts'
import { AttentionBadge } from './attention-badge.tsx'
import type { QueuedFastAction } from './pwa-storage.ts'
import { SurfaceCard } from './surface-card.tsx'
import type { SurfaceUpdateFeedback } from './surface-motion.ts'

export function SpaceSection({
  space,
  authToken,
  focused,
  focusedSurfaceId,
  surfaceRevealFeedbackKeys,
  surfaceUpdateFeedbacks,
  onMoveSurface,
  onPatched,
  onQueueFastAction,
  onTogglePin,
  onSurfaceRevealFeedbackShown,
  onError,
}: {
  space: SpaceWithSurfaces
  authToken: string | undefined
  focused: boolean
  focusedSurfaceId: string | undefined
  surfaceRevealFeedbackKeys: Record<string, string>
  surfaceUpdateFeedbacks: Record<string, SurfaceUpdateFeedback>
  onMoveSurface: (
    space: SpaceWithSurfaces,
    surfaceId: string,
    direction: SurfaceMoveDirection,
  ) => void
  onPatched: (surface: Surface, affectedAtomIds?: readonly string[], surfaceCursor?: number) => void
  onQueueFastAction: (action: QueuedFastAction) => void
  onTogglePin: (surface: Surface, pinned: boolean) => void
  onSurfaceRevealFeedbackShown: (surfaceId: string, feedbackKey: string) => void
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
            revealFeedbackKey={surfaceRevealFeedbackKeys[surface.id]}
            updateFeedback={surfaceUpdateFeedbacks[surface.id]}
            canMoveUp={index > 0}
            canMoveDown={index < surfaces.length - 1}
            onMoveUp={() => onMoveSurface(space, surface.id, 'up')}
            onMoveDown={() => onMoveSurface(space, surface.id, 'down')}
            onPatched={onPatched}
            onQueueFastAction={onQueueFastAction}
            onTogglePin={(pinned) => onTogglePin(surface, pinned)}
            onRevealFeedbackShown={(feedbackKey) =>
              onSurfaceRevealFeedbackShown(surface.id, feedbackKey)
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
