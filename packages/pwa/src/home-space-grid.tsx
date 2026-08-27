import { Link } from 'react-router-dom'
import type { SpaceWithSurfaces } from './api.ts'
import { AttentionBadge } from './attention-badge.tsx'
import { clientPath } from './client-router.tsx'
import { homeSpaceGroups, type HomeSpaceSummary } from './home-state.ts'
import { freshnessLabel } from './time-labels.ts'

export type HomeSpacesLoadState = 'loading' | 'ready' | 'error'

export function HomeSpaceGrid({
  spaces,
  loadState,
  onRetry,
}: {
  spaces: SpaceWithSurfaces[]
  loadState: HomeSpacesLoadState
  onRetry: () => void
}) {
  const groups = homeSpaceGroups(spaces)
  const hasSpaces = groups.userSpaces.length > 0 || groups.systemSpaces.length > 0

  if (!hasSpaces) {
    if (loadState === 'loading') {
      return (
        <section className="home-state-panel" role="status" aria-label="Loading Spaces" aria-busy>
          <p>Loading Spaces…</p>
        </section>
      )
    }

    return (
      <HomeRecovery
        heading={loadState === 'error' ? 'Spaces unavailable' : 'No active Spaces'}
        message={
          loadState === 'error'
            ? 'Veduta could not load a valid Space snapshot. Check the connection and try again.'
            : 'Veduta has no active Spaces to show yet. Reload the snapshot to recover.'
        }
        onRetry={onRetry}
      />
    )
  }

  return (
    <div className="home-space-groups">
      {groups.userSpaces.length > 0 && (
        <SpaceGroup label="Your Spaces" spaces={groups.userSpaces} />
      )}

      {groups.userSpaces.length === 0 && groups.systemSpaces.length > 0 && (
        <section className="first-space-invitation" aria-label="Create your first Space from chat">
          <p className="home-eyebrow">Make Home yours</p>
          <h2>Create your first Space from chat</h2>
          <p>Tell Veduta which part of life you want to see at a glance.</p>
        </section>
      )}

      {groups.systemSpaces.length > 0 ? (
        <SpaceGroup label="System" spaces={groups.systemSpaces} secondary />
      ) : (
        <HomeRecovery
          heading="System Space unavailable"
          message="This snapshot has no canonical System Space. Reload it to recover Gateway status."
          onRetry={onRetry}
        />
      )}
    </div>
  )
}

function SpaceGroup({
  label,
  spaces,
  secondary = false,
}: {
  label: string
  spaces: HomeSpaceSummary[]
  secondary?: boolean
}) {
  return (
    <section
      className={secondary ? 'home-space-group secondary' : 'home-space-group'}
      aria-label={label}
    >
      <div className="home-space-group-heading">
        <h2>{label}</h2>
        <span>{spaces.length}</span>
      </div>
      <ul className="home-space-grid" role="list">
        {spaces.map((space) => (
          <li key={space.id}>
            <SpaceCard space={space} />
          </li>
        ))}
      </ul>
    </section>
  )
}

function SpaceCard({ space }: { space: HomeSpaceSummary }) {
  return (
    <Link className="space-card" to={clientPath.space(space.slug)}>
      <div className="space-card-heading">
        <h3>{space.name}</h3>
        <span aria-hidden="true">→</span>
      </div>

      <span className="space-card-description" data-space-description-slot aria-hidden="true" />

      <div className="space-card-metadata">
        <p>
          <span>Surfaces</span>
          <strong>
            {space.surfaceCount} {space.surfaceCount === 1 ? 'Surface' : 'Surfaces'}
          </strong>
        </p>
        <p>
          <span>Freshness</span>
          {space.freshestUpdatedAt === undefined ? (
            <strong>No Surface updates</strong>
          ) : (
            <time dateTime={space.freshestUpdatedAt}>
              {freshnessLabel(space.freshestUpdatedAt)}
            </time>
          )}
        </p>
      </div>

      <div className="space-card-attention">
        <span>Attention</span>
        {space.attention > 0 ? <AttentionBadge count={space.attention} /> : <span>Clear</span>}
      </div>
    </Link>
  )
}

function HomeRecovery({
  heading,
  message,
  onRetry,
}: {
  heading: string
  message: string
  onRetry: () => void
}) {
  return (
    <section className="home-state-panel" role="status">
      <h2>{heading}</h2>
      <p>{message}</p>
      <button type="button" onClick={onRetry}>
        Retry loading Spaces
      </button>
    </section>
  )
}
