import type { RenderableSurface, SurfaceMoveDirection } from '@veduta/protocol'
import { freshnessLabel, type SpaceWithSurfaces } from './api.ts'
import { AttentionBadge } from './attention-badge.tsx'
import { SurfaceCard } from './surface-card.tsx'
import type { SurfaceUpdateFeedback } from './surface-motion.ts'
import { usePresentation } from './presentation-context.ts'

export function SpaceSection({
  space,
  focused,
  focusedSurfaceId,
  surfaceRevealFeedbackKeys,
  surfaceUpdateFeedbacks,
  onFocus,
  onMoveSurface,
  onTogglePin,
  onSurfaceRevealFeedbackShown,
}: {
  space: SpaceWithSurfaces
  focused: boolean
  focusedSurfaceId: string | undefined
  surfaceRevealFeedbackKeys: Record<string, string>
  surfaceUpdateFeedbacks: Record<string, SurfaceUpdateFeedback>
  onFocus: (space: SpaceWithSurfaces, surface?: RenderableSurface) => void
  onMoveSurface: (
    space: SpaceWithSurfaces,
    surfaceId: string,
    direction: SurfaceMoveDirection,
  ) => void
  onTogglePin: (surface: RenderableSurface, pinned: boolean) => void
  onSurfaceRevealFeedbackShown: (surfaceId: string, feedbackKey: string) => void
}) {
  const { now } = usePresentation()
  const surfaces = space.surfaces

  return (
    <section
      className={focused ? 'space-section focused' : 'space-section'}
      aria-labelledby={`${space.id}-title`}
    >
      <div className="space-heading">
        <div>
          <h2 id={`${space.id}-title`}>{space.name}</h2>
          <p>{freshestLabel(surfaces, now)}</p>
        </div>
        <span className="badge-group">
          <AttentionBadge count={space.attention} />
          <span className="space-badge">{surfaces.length} Surfaces</span>
        </span>
      </div>
      <div className="surface-grid" data-presentation={space.presentation ?? 'auto'}>
        {surfaces.map((surface, index) => (
          <SurfaceCard
            key={surface.id}
            surface={surface}
            selected={surface.id === focusedSurfaceId}
            revealFeedbackKey={surfaceRevealFeedbackKeys[surface.id]}
            updateFeedback={surfaceUpdateFeedbacks[surface.id]}
            canMoveUp={index > 0}
            canMoveDown={index < surfaces.length - 1}
            onFocus={() => onFocus(space, surface)}
            onMoveUp={() => onMoveSurface(space, surface.id, 'up')}
            onMoveDown={() => onMoveSurface(space, surface.id, 'down')}
            onTogglePin={(pinned) => onTogglePin(surface, pinned)}
            onRevealFeedbackShown={(feedbackKey) =>
              onSurfaceRevealFeedbackShown(surface.id, feedbackKey)
            }
          />
        ))}
      </div>
    </section>
  )
}

function freshestLabel(surfaces: RenderableSurface[], now?: number): string {
  const latest = surfaces
    .map((surface) => Date.parse(surface.freshness.updatedAt))
    .filter(Number.isFinite)
    .sort((left, right) => right - left)[0]
  return latest ? `freshest ${freshnessLabel(new Date(latest).toISOString(), now)}` : 'no Surfaces'
}
