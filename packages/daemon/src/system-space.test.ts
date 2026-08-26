import { SurfaceSchema, type Surface } from '@veduta/protocol'
import { describe, expect, it } from 'vitest'
import { SpacesEngine } from './spaces-engine.ts'
import { Store } from './store.ts'
import { SYSTEM_SPACE_ID, ensureSystemSpace } from './system-space.ts'

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

describe('ensureSystemSpace', () => {
  it('does not let a Store snapshot materialize a missing System Space', () => {
    const store = new Store()
    expect(store.getSpace(SYSTEM_SPACE_ID)).toBeUndefined()

    const snapshot = store.snapshot()

    expect(snapshot.spaces.some((space) => space.id === SYSTEM_SPACE_ID)).toBe(false)
    expect(store.getSpace(SYSTEM_SPACE_ID)).toBeUndefined()
  })

  it('keeps projected FACTS out of the System snapshot and Store read paths', () => {
    const store = new Store()
    ensureSystemSpace(store.spacesEngine)
    store.createSurface(systemSurface('srf-system-daemon'), 'job', { daemonOwned: true })

    const system = store.snapshot().spaces.find((space) => space.id === SYSTEM_SPACE_ID)

    expect(system?.surfaces.map((surface) => surface.id)).toEqual(['srf-system-daemon'])
    expect(store.listSurfaces(SYSTEM_SPACE_ID).map((surface) => surface.id)).toEqual([
      'srf-system-daemon',
    ])
    expect(store.getSurface('srf-system-facts')).toBeUndefined()
  })

  it('reserves the canonical identity from ordinary creation before boot materializes it', () => {
    const spacesEngine = new SpacesEngine()

    const userAuthored = spacesEngine.createSpace({ name: 'System', slug: 'system' })
    const proposal = spacesEngine.proposeSpace({
      name: 'System',
      reason: 'The user chose this presentation name.',
    })
    const system = ensureSystemSpace(spacesEngine)

    expect(userAuthored).toMatchObject({ id: 'spc-system-2', slug: 'system-2', name: 'System' })
    expect(proposal.spaceId).not.toBe(SYSTEM_SPACE_ID)
    expect(proposal.slug).not.toBe('system')
    expect(system).toMatchObject({ id: SYSTEM_SPACE_ID, slug: 'system', name: 'System' })
    expect(
      spacesEngine.listAllSpaces().filter((space) => space.id === SYSTEM_SPACE_ID),
    ).toHaveLength(1)
  })

  it('creates the persisted System Space when missing', () => {
    const spacesEngine = new SpacesEngine()
    expect(spacesEngine.getSpace(SYSTEM_SPACE_ID)).toBeUndefined()

    const space = ensureSystemSpace(spacesEngine)

    expect(space).toMatchObject({ id: SYSTEM_SPACE_ID, slug: 'system', name: 'System' })
    expect(spacesEngine.getSpace(SYSTEM_SPACE_ID)).toMatchObject({ archived: false })
  })

  it('restores the System Space when it exists but is archived', () => {
    const spacesEngine = new SpacesEngine({
      seed: {
        spaces: [{ id: SYSTEM_SPACE_ID, name: 'System', slug: 'system', archived: true }],
        surfaces: [],
      },
    })
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

  it('refuses ordinary lifecycle mutations by identity despite changed presentation values', () => {
    const spacesEngine = new SpacesEngine({
      seed: {
        spaces: [
          {
            id: SYSTEM_SPACE_ID,
            name: 'Controls',
            slug: 'controls',
            archived: false,
          },
        ],
        surfaces: [],
      },
    })
    const system = ensureSystemSpace(spacesEngine)
    const health = spacesEngine.createSpace({ name: 'Health' })
    const systemEvents = spacesEngine.readRecent(SYSTEM_SPACE_ID, Number.MAX_SAFE_INTEGER)

    for (const mutation of [
      () => spacesEngine.archiveSpace(SYSTEM_SPACE_ID),
      () => spacesEngine.restoreSpace(SYSTEM_SPACE_ID),
      () => spacesEngine.mergeSpaces(SYSTEM_SPACE_ID, health.id),
      () => spacesEngine.mergeSpaces(health.id, SYSTEM_SPACE_ID),
    ]) {
      expect(mutation).toThrow(/System Space lifecycle is Gateway-owned/)
    }

    expect(system).toMatchObject({ name: 'Controls', slug: 'controls', archived: false })
    expect(spacesEngine.getSpace(health.id)).toMatchObject({ archived: false })
    expect(spacesEngine.readRecent(SYSTEM_SPACE_ID, Number.MAX_SAFE_INTEGER)).toEqual(systemEvents)
  })
})
