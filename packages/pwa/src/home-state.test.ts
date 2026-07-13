import { SurfaceSnapshotSchema, type Surface } from '@veduta/protocol'
import { describe, expect, it } from 'vitest'
import type { SpaceWithSurfaces } from './api.ts'
import {
  applyBufferedSurfaceStreamEvents,
  applySurfaceArchivedToSpaces,
  applySurfaceCreatedToSpaces,
  applySurfacePatchToSpaces,
  applySurfaceStreamEvent,
  cachedSnapshot,
  mergeSurfaceOrder,
  moveSurfaceId,
  parseSurfaceDeepLink,
  saveSnapshot,
  surfaceDeepLink,
  type SurfaceStreamEvent,
} from './home-state.ts'

function testSurface(id: string, spaceId: string, updatedAt: string): Surface {
  return {
    id,
    spaceId,
    title: id,
    tree: { id: 'root', type: 'Box', children: [] },
    state: {},
    freshness: { updatedAt, updatedBy: 'agent' },
  }
}

function testSpace(id: string, surfaces: Surface[]): SpaceWithSurfaces {
  return { id, slug: id, name: id, archived: false, surfaces }
}

describe('Surface deep links', () => {
  it('round-trips app Space and Surface links', () => {
    const href = surfaceDeepLink('health', 'srf-meals')

    expect(href).toBe('/app/space/health/surface/srf-meals')
    expect(parseSurfaceDeepLink(href)).toEqual({
      spaceSlug: 'health',
      surfaceId: 'srf-meals',
    })
  })

  it('ignores unrelated paths', () => {
    expect(parseSurfaceDeepLink('/')).toBeUndefined()
  })
})

describe('Surface order', () => {
  it('keeps saved order, drops stale ids and appends new Surfaces once', () => {
    expect(mergeSurfaceOrder(['a', 'b', 'c'], ['c', 'missing', 'a', 'a'])).toEqual(['c', 'a', 'b'])
  })

  it('moves ids within bounds without duplicating them', () => {
    expect(moveSurfaceId(['a', 'b', 'c'], 'b', -1)).toEqual(['b', 'a', 'c'])
    expect(moveSurfaceId(['a', 'b', 'c'], 'b', 1)).toEqual(['a', 'c', 'b'])
    expect(moveSurfaceId(['a', 'b', 'c'], 'a', -1)).toEqual(['a', 'b', 'c'])
  })
})

describe('cachedSnapshot', () => {
  it('stores and restores only protocol-valid Home snapshots', () => {
    const storage = new MemoryStorage()
    const snapshot = SurfaceSnapshotSchema.parse({
      surfaceCursor: 7,
      spaces: [
        {
          id: 'spc-health',
          slug: 'health',
          name: 'Health',
          archived: false,
          surfaces: [
            {
              id: 'srf-meals',
              spaceId: 'spc-health',
              title: 'Meals',
              tree: { id: 'root', type: 'Box', children: [] },
              state: {},
              freshness: { updatedAt: '2026-07-03T12:00:00.000Z', updatedBy: 'agent' },
            },
          ],
        },
      ],
    })

    saveSnapshot(storage, 'home', snapshot)

    expect(cachedSnapshot(storage, 'home')).toEqual(snapshot)
    storage.setItem('home', '{"surfaceCursor":"wrong"}')
    expect(cachedSnapshot(storage, 'home')).toBeUndefined()
  })
})

describe('applySurfaceCreatedToSpaces', () => {
  it('inserts a new Surface into its Space', () => {
    const spaces = [testSpace('spc-health', [])]
    const surface = testSurface('srf-meals', 'spc-health', '2026-07-10T12:00:00.000Z')

    const result = applySurfaceCreatedToSpaces(spaces, {
      cursor: 1,
      at: '2026-07-10T12:00:00.000Z',
      spaceId: 'spc-health',
      surface,
    })

    expect(result.applied).toBe(true)
    expect(result.spaces[0]?.surfaces).toEqual([surface])
  })

  it('replaces rather than duplicates when the id already exists', () => {
    const original = testSurface('srf-meals', 'spc-health', '2026-07-10T12:00:00.000Z')
    const spaces = [testSpace('spc-health', [original])]
    const replacement = testSurface('srf-meals', 'spc-health', '2026-07-10T12:05:00.000Z')

    const result = applySurfaceCreatedToSpaces(spaces, {
      cursor: 2,
      at: '2026-07-10T12:05:00.000Z',
      spaceId: 'spc-health',
      surface: replacement,
    })

    expect(result.applied).toBe(true)
    expect(result.spaces[0]?.surfaces).toEqual([replacement])
  })

  it('reports not applied for an unknown Space', () => {
    const spaces = [testSpace('spc-health', [])]
    const surface = testSurface('srf-meals', 'spc-other', '2026-07-10T12:00:00.000Z')

    const result = applySurfaceCreatedToSpaces(spaces, {
      cursor: 1,
      at: '2026-07-10T12:00:00.000Z',
      spaceId: 'spc-other',
      surface,
    })

    expect(result.applied).toBe(false)
    expect(result.spaces).toEqual(spaces)
  })
})

describe('applySurfaceArchivedToSpaces', () => {
  it('removes the Surface from its Space', () => {
    const surface = testSurface('srf-meals', 'spc-health', '2026-07-10T12:00:00.000Z')
    const spaces = [testSpace('spc-health', [surface])]

    const result = applySurfaceArchivedToSpaces(spaces, {
      cursor: 2,
      at: '2026-07-10T12:10:00.000Z',
      spaceId: 'spc-health',
      surfaceId: 'srf-meals',
    })

    expect(result.applied).toBe(true)
    expect(result.spaces[0]?.surfaces).toEqual([])
  })

  it('reports not applied when the Surface is not in that Space', () => {
    const spaces = [testSpace('spc-health', [])]

    const result = applySurfaceArchivedToSpaces(spaces, {
      cursor: 2,
      at: '2026-07-10T12:10:00.000Z',
      spaceId: 'spc-health',
      surfaceId: 'srf-missing',
    })

    expect(result.applied).toBe(false)
  })
})

describe('applySurfacePatchToSpaces', () => {
  it('reports not applied for an unknown Surface', () => {
    const spaces = [testSpace('spc-health', [])]

    const result = applySurfacePatchToSpaces(spaces, {
      cursor: 1,
      at: '2026-07-10T12:00:00.000Z',
      spaceId: 'spc-health',
      patch: { surfaceId: 'srf-missing', operations: [] as never },
      freshness: { updatedAt: '2026-07-10T12:00:00.000Z', updatedBy: 'agent' },
    })

    expect(result.applied).toBe(false)
  })
})

describe('applyBufferedSurfaceStreamEvents', () => {
  it('applies buffered events in cursor order, skipping ones the snapshot already reflects', () => {
    const snapshotSpaces = [testSpace('spc-health', [])]
    const surfaceA = testSurface('srf-a', 'spc-health', '2026-07-10T12:00:00.000Z')
    const surfaceB = testSurface('srf-b', 'spc-health', '2026-07-10T12:01:00.000Z')

    // Arrives out of order and includes one event the snapshot (cursor 5)
    // already reflects, plus two events the snapshot predates.
    const buffered: SurfaceStreamEvent[] = [
      {
        type: 'surface.created',
        event: {
          cursor: 7,
          at: '2026-07-10T12:02:00.000Z',
          spaceId: 'spc-health',
          surface: surfaceB,
        },
      },
      {
        type: 'surface.created',
        event: {
          cursor: 3,
          at: '2026-07-10T12:00:00.000Z',
          spaceId: 'spc-health',
          surface: surfaceA,
        },
      },
    ]

    const result = applyBufferedSurfaceStreamEvents(snapshotSpaces, 5, buffered)

    expect(result.unresolved).toEqual([])
    expect(result.cursor).toBe(7)
    expect(result.spaces[0]?.surfaces).toEqual([surfaceB])
  })

  it('returns still-unknown events as unresolved instead of dropping them', () => {
    const snapshotSpaces = [testSpace('spc-health', [])]
    const buffered: SurfaceStreamEvent[] = [
      {
        type: 'surface.archived',
        event: {
          cursor: 9,
          at: '2026-07-10T12:03:00.000Z',
          spaceId: 'spc-other',
          surfaceId: 'srf-ghost',
        },
      },
    ]

    const result = applyBufferedSurfaceStreamEvents(snapshotSpaces, 5, buffered)

    expect(result.unresolved).toEqual(buffered)
    expect(result.cursor).toBe(5)
  })
})

describe('applySurfaceStreamEvent', () => {
  it('dispatches to the matching apply function by event type', () => {
    const spaces = [testSpace('spc-health', [])]
    const surface = testSurface('srf-meals', 'spc-health', '2026-07-10T12:00:00.000Z')

    const created = applySurfaceStreamEvent(spaces, {
      type: 'surface.created',
      event: { cursor: 1, at: '2026-07-10T12:00:00.000Z', spaceId: 'spc-health', surface },
    })
    expect(created.applied).toBe(true)

    const archived = applySurfaceStreamEvent(created.spaces, {
      type: 'surface.archived',
      event: {
        cursor: 2,
        at: '2026-07-10T12:01:00.000Z',
        spaceId: 'spc-health',
        surfaceId: 'srf-meals',
      },
    })
    expect(archived.applied).toBe(true)
    expect(archived.spaces[0]?.surfaces).toEqual([])
  })
})

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>()

  get length(): number {
    return this.values.size
  }

  clear(): void {
    this.values.clear()
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }

  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null
  }

  removeItem(key: string): void {
    this.values.delete(key)
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value)
  }
}
