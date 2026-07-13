import { SurfaceSchema, type Surface, type SurfaceSnapshot } from '@veduta/protocol'
import { describe, expect, it } from 'vitest'
import { SpacesEngine } from './spaces-engine.ts'
import { SYSTEM_SPACE_ID, appendSystemSurface, ensureSystemSpace } from './system-space.ts'

const emptySnapshot: SurfaceSnapshot = { surfaceCursor: 0, spaces: [] }

function systemSurface(id: string): Surface {
  return SurfaceSchema.parse({
    id,
    spaceId: SYSTEM_SPACE_ID,
    title: id,
    tree: { id: 'root', type: 'Box', children: [] },
    state: {},
    freshness: { updatedAt: '2026-07-08T10:00:00.000Z', updatedBy: 'system' },
  })
}

describe('appendSystemSurface', () => {
  it('creates the synthetic System Space on first use', () => {
    const snapshot = appendSystemSurface(emptySnapshot, systemSurface('srf-usage'))
    expect(snapshot.spaces).toHaveLength(1)
    expect(snapshot.spaces[0]).toMatchObject({ id: SYSTEM_SPACE_ID, slug: 'system' })
    expect(snapshot.spaces[0]?.surfaces.map((surface) => surface.id)).toEqual(['srf-usage'])
  })

  it('merges further daemon Surfaces into the one System Space', () => {
    const first = appendSystemSurface(emptySnapshot, systemSurface('srf-usage'))
    const second = appendSystemSurface(first, systemSurface('srf-connected-devices'))
    expect(second.spaces).toHaveLength(1)
    expect(second.spaces[0]?.surfaces.map((surface) => surface.id)).toEqual([
      'srf-usage',
      'srf-connected-devices',
    ])
  })
})

describe('ensureSystemSpace', () => {
  it('creates the persisted System Space when missing', () => {
    const spacesEngine = new SpacesEngine()
    expect(spacesEngine.getSpace(SYSTEM_SPACE_ID)).toBeUndefined()

    const space = ensureSystemSpace(spacesEngine)

    expect(space).toMatchObject({ id: SYSTEM_SPACE_ID, slug: 'system', name: 'System' })
    expect(spacesEngine.getSpace(SYSTEM_SPACE_ID)).toMatchObject({ archived: false })
  })

  it('restores the System Space when it exists but is archived', () => {
    const spacesEngine = new SpacesEngine()
    spacesEngine.createSpace({ name: 'System', slug: 'system' })
    spacesEngine.archiveSpace(SYSTEM_SPACE_ID)
    expect(spacesEngine.getSpace(SYSTEM_SPACE_ID)).toMatchObject({ archived: true })

    const space = ensureSystemSpace(spacesEngine)

    expect(space.archived).toBe(false)
    expect(spacesEngine.getSpace(SYSTEM_SPACE_ID)).toMatchObject({ archived: false })
  })

  it('leaves an existing, active System Space untouched', () => {
    const spacesEngine = new SpacesEngine()
    const created = ensureSystemSpace(spacesEngine)
    const eventsAfterCreate = spacesEngine.readRecent(SYSTEM_SPACE_ID, Number.MAX_SAFE_INTEGER)

    const second = ensureSystemSpace(spacesEngine)

    expect(second).toEqual(created)
    // No further lifecycle event (e.g. a spurious "Restored Space") was appended.
    expect(spacesEngine.readRecent(SYSTEM_SPACE_ID, Number.MAX_SAFE_INTEGER)).toEqual(
      eventsAfterCreate,
    )
  })

  it('keeps appendSystemSurface merging into the now-persisted System Space', () => {
    const spacesEngine = new SpacesEngine()
    ensureSystemSpace(spacesEngine)
    const snapshotWithSystemSpace: SurfaceSnapshot = {
      surfaceCursor: 0,
      spaces: spacesEngine.listSpaces().map((space) => ({ ...space, surfaces: [] })),
    }

    const merged = appendSystemSurface(snapshotWithSystemSpace, systemSurface('srf-usage'))

    expect(merged.spaces).toHaveLength(1)
    expect(merged.spaces[0]).toMatchObject({ id: SYSTEM_SPACE_ID, slug: 'system' })
    expect(merged.spaces[0]?.surfaces.map((surface) => surface.id)).toEqual(['srf-usage'])
  })
})
