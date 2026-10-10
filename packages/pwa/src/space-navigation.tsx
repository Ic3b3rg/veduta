import { Button } from '@veduta/catalog/ui/button'
import { NativeSelect } from '@veduta/catalog/ui/native-select'
import { useNavigate } from 'react-router-dom'
import type { SpaceWithSurfaces } from './api.ts'
import { AttentionBadge } from './attention-badge.tsx'
import { clientPath } from './client-router.tsx'

/** Both responsive controls read the router's selection and dispatch the same Space command. */
export function SpaceNavigation({
  spaces,
  selectedSpace,
  onFocusSpace,
}: {
  spaces: SpaceWithSurfaces[]
  selectedSpace: SpaceWithSurfaces | undefined
  onFocusSpace: (space: SpaceWithSurfaces) => void
}) {
  const navigate = useNavigate()
  return (
    <aside className="space-navigation" aria-label="Spaces">
      <div className="space-rail recipe-menu">
        {spaces.map((space) => (
          <Button
            key={space.id}
            className={`space-button recipe-control${space.id === selectedSpace?.id ? ' selected' : ''}`}
            aria-pressed={space.id === selectedSpace?.id}
            onClick={() => onFocusSpace(space)}
          >
            <span className="space-navigation-name">{space.name}</span>
            <span className="badge-group">
              <AttentionBadge count={space.attention} />
              <span className="space-badge" aria-label={`${space.surfaces.length} Surfaces`}>
                {space.surfaces.length}
              </span>
            </span>
          </Button>
        ))}
      </div>
      <label className="space-picker">
        <span>Space</span>
        <NativeSelect
          className="recipe-input"
          aria-label="Change Space"
          value={selectedSpace?.id ?? ''}
          onChange={(event) => {
            const next = spaces.find((space) => space.id === event.target.value)
            if (next) onFocusSpace(next)
            else if (event.target.value === '') navigate(clientPath.home)
          }}
        >
          <option value="">Home</option>
          {spaces.map((space) => (
            <option key={space.id} value={space.id}>
              {space.name}
              {space.attention > 0 ? ` · ${space.attention} updates` : ''}
            </option>
          ))}
        </NativeSelect>
      </label>
    </aside>
  )
}
