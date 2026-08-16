import { SurfaceSchema, SurfaceSnapshotSchema, type Surface } from '@veduta/protocol'
import { describe, expect, it } from 'vitest'
import type { SpaceWithSurfaces } from './api.ts'
import {
  applyBufferedSurfaceStreamEvents,
  applySpaceAttention,
  applySurfaceArchivedToSpaces,
  applySurfaceCreatedToSpaces,
  applySurfacePatchToSpaces,
  applySurfacePinnedToSpaces,
  applySurfaceOrderToSpaces,
  applySurfaceStreamEvent,
  cachedSnapshot,
  mergeSpaceAttention,
  parseSurfaceDeepLink,
  saveSnapshot,
  surfaceDeepLink,
  surfaceStreamEventCursor,
  type SurfaceStreamEvent,
} from './home-state.ts'

function testSurface(id: string, spaceId: string, updatedAt: string): Surface {
  return SurfaceSchema.parse({
    id,
    spaceId,
    title: id,
    tree: { id: 'root', type: 'Box', children: [] },
    state: {},
    freshness: { updatedAt, updatedBy: 'agent' },
  })
}

function testSpace(
  id: string,
  surfaces: Surface[],
  attention: { attention?: number; attentionRevision?: number } = {},
): SpaceWithSurfaces {
  return {
    id,
    slug: id,
    name: id,
    archived: false,
    surfaces,
    attention: attention.attention ?? 0,
    attentionRevision: attention.attentionRevision ?? 0,
  }
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
  it('applies the Gateway order exactly and retains snapshot-only projected Surfaces afterward', () => {
    const pinned = SurfaceSchema.parse({
      ...testSurface('srf-pinned', 'spc-health', '2026-07-10T12:00:00.000Z'),
      pinned: true,
    })
    const regular = testSurface('srf-regular', 'spc-health', '2026-07-10T12:00:00.000Z')
    const projected = SurfaceSchema.parse({
      ...testSurface('srf-facts', 'spc-health', '2026-07-10T12:00:00.000Z'),
      pinnable: false,
    })
    const spaces = [testSpace('spc-health', [regular, projected, pinned])]

    const result = applySurfaceOrderToSpaces(spaces, {
      cursor: 8,
      spaceId: 'spc-health',
      pinnedSurfaceIds: ['srf-pinned'],
      regularSurfaceIds: ['srf-regular'],
    })

    expect(result.applied).toBe(true)
    expect(result.spaces[0]?.surfaces.map((surface) => surface.id)).toEqual([
      'srf-pinned',
      'srf-regular',
      'srf-facts',
    ])
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

    storage.setItem('home', JSON.stringify(snapshot))
    expect(cachedSnapshot(storage, 'home')).toBeUndefined()

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
      order: testOrder(1, [], ['srf-meals']),
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
      order: testOrder(2, [], ['srf-meals']),
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
      order: testOrder(1, [], ['srf-meals'], 'spc-other'),
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
      order: testOrder(2),
    })

    expect(result.applied).toBe(true)
    expect(result.spaces[0]?.surfaces).toEqual([])
  })

  it('applies an authoritative duplicate archive without fabricating a Surface', () => {
    const spaces = [testSpace('spc-health', [])]

    const result = applySurfaceArchivedToSpaces(spaces, {
      cursor: 2,
      at: '2026-07-10T12:10:00.000Z',
      spaceId: 'spc-health',
      surfaceId: 'srf-missing',
      order: testOrder(2),
    })

    expect(result.applied).toBe(true)
    expect(result.spaces).toEqual(spaces)
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

describe('applySurfacePinnedToSpaces', () => {
  it('flips pinned on the matching Surface, converges its freshness on the event’s own, and reports the event cursor', () => {
    const surface = testSurface('srf-meals', 'spc-health', '2026-07-10T12:00:00.000Z')
    const streamEvent: SurfaceStreamEvent = {
      type: 'surface.pinned',
      event: {
        cursor: 4,
        at: '2026-07-10T12:05:00.000Z',
        spaceId: 'spc-health',
        surfaceId: 'srf-meals',
        pinned: true,
        freshness: { updatedAt: '2026-07-10T12:05:00.000Z', updatedBy: 'user' },
        order: testOrder(4, ['srf-meals']),
      },
    }
    const spaces = [testSpace('spc-health', [surface])]

    const result = applySurfacePinnedToSpaces(spaces, streamEvent.event)

    expect(result.applied).toBe(true)
    // Both `pinned` and `freshness` converge on the event's own values — a
    // pin is a change to the Surface, and the daemon already stamps a fresh
    // `freshness` on it; `tree`/`state` are the only things left untouched.
    expect(result.spaces[0]?.surfaces[0]).toEqual({
      ...surface,
      pinned: true,
      freshness: { updatedAt: '2026-07-10T12:05:00.000Z', updatedBy: 'user' },
    })
    expect(surfaceStreamEventCursor(streamEvent)).toBe(4)
  })

  it('ignores an event for an unknown surfaceId, leaving the snapshot untouched', () => {
    const surface = testSurface('srf-meals', 'spc-health', '2026-07-10T12:00:00.000Z')
    const spaces = [testSpace('spc-health', [surface])]

    const result = applySurfacePinnedToSpaces(spaces, {
      cursor: 4,
      at: '2026-07-10T12:05:00.000Z',
      spaceId: 'spc-health',
      surfaceId: 'srf-ghost',
      pinned: true,
      freshness: { updatedAt: '2026-07-10T12:05:00.000Z', updatedBy: 'user' },
      order: testOrder(4, ['srf-ghost']),
    })

    expect(result.applied).toBe(false)
    expect(result.spaces).toEqual(spaces)
  })

  it('dispatches through applySurfaceStreamEvent like the other stream events', () => {
    const surface = testSurface('srf-meals', 'spc-health', '2026-07-10T12:00:00.000Z')
    const spaces = [testSpace('spc-health', [surface])]

    const result = applySurfaceStreamEvent(spaces, {
      type: 'surface.pinned',
      event: {
        cursor: 5,
        at: '2026-07-10T12:06:00.000Z',
        spaceId: 'spc-health',
        surfaceId: 'srf-meals',
        pinned: true,
        freshness: { updatedAt: '2026-07-10T12:06:00.000Z', updatedBy: 'user' },
        order: testOrder(5, ['srf-meals']),
      },
    })

    expect(result.applied).toBe(true)
    expect(result.spaces[0]?.surfaces[0]?.pinned).toBe(true)
    expect(result.spaces[0]?.surfaces[0]?.freshness).toEqual({
      updatedAt: '2026-07-10T12:06:00.000Z',
      updatedBy: 'user',
    })
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
          order: testOrder(7, [], ['srf-b']),
        },
      },
      {
        type: 'surface.created',
        event: {
          cursor: 3,
          at: '2026-07-10T12:00:00.000Z',
          spaceId: 'spc-health',
          surface: surfaceA,
          order: testOrder(3, [], ['srf-a']),
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
          order: testOrder(9, [], [], 'spc-other'),
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
      event: {
        cursor: 1,
        at: '2026-07-10T12:00:00.000Z',
        spaceId: 'spc-health',
        surface,
        order: testOrder(1, [], ['srf-meals']),
      },
    })
    expect(created.applied).toBe(true)

    const archived = applySurfaceStreamEvent(created.spaces, {
      type: 'surface.archived',
      event: {
        cursor: 2,
        at: '2026-07-10T12:01:00.000Z',
        spaceId: 'spc-health',
        surfaceId: 'srf-meals',
        order: testOrder(2),
      },
    })
    expect(archived.applied).toBe(true)
    expect(archived.spaces[0]?.surfaces).toEqual([])
  })

  it('dispatches a surface.moved event by applying only its authoritative order', () => {
    const first = testSurface('srf-first', 'spc-health', '2026-07-10T12:00:00.000Z')
    const second = testSurface('srf-second', 'spc-health', '2026-07-10T12:00:00.000Z')

    const moved = applySurfaceStreamEvent([testSpace('spc-health', [first, second])], {
      type: 'surface.moved',
      event: {
        cursor: 3,
        at: '2026-07-10T12:01:00.000Z',
        spaceId: 'spc-health',
        surfaceId: 'srf-second',
        direction: 'up',
        order: testOrder(3, [], ['srf-second', 'srf-first']),
      },
    })

    expect(moved.applied).toBe(true)
    expect(moved.spaces[0]?.surfaces.map((surface) => surface.id)).toEqual([
      'srf-second',
      'srf-first',
    ])
  })
})

describe('applySpaceAttention', () => {
  it('applies a frame with a strictly higher revision', () => {
    const spaces = [testSpace('spc-health', [], { attention: 1, attentionRevision: 3 })]

    const next = applySpaceAttention(spaces, { spaceId: 'spc-health', count: 4, revision: 5 })

    expect(next[0]).toMatchObject({ attention: 4, attentionRevision: 5 })
  })

  it('ignores a stale frame (lower or equal revision)', () => {
    const spaces = [testSpace('spc-health', [], { attention: 4, attentionRevision: 5 })]

    const equal = applySpaceAttention(spaces, { spaceId: 'spc-health', count: 9, revision: 5 })
    const lower = applySpaceAttention(spaces, { spaceId: 'spc-health', count: 9, revision: 2 })

    expect(equal[0]).toMatchObject({ attention: 4, attentionRevision: 5 })
    expect(lower[0]).toMatchObject({ attention: 4, attentionRevision: 5 })
  })

  it('leaves unrelated Spaces untouched', () => {
    const spaces = [testSpace('spc-other', [], { attention: 1, attentionRevision: 1 })]

    const next = applySpaceAttention(spaces, { spaceId: 'spc-health', count: 9, revision: 9 })

    expect(next).toEqual(spaces)
  })

  it('defaults new/legacy Spaces to revision 0, so any first frame applies', () => {
    const spaces = [testSpace('spc-health', [])]

    const next = applySpaceAttention(spaces, { spaceId: 'spc-health', count: 1, revision: 1 })

    expect(next[0]).toMatchObject({ attention: 1, attentionRevision: 1 })
  })
})

describe('mergeSpaceAttention', () => {
  it('keeps the fresher revision when the previously-held state is newer than the refetch', () => {
    // Simulates the stale-refetch race: a space.attention WS frame lands
    // (revision 5) while an /api/spaces refetch triggered by an unrelated
    // Surface event is still in flight and comes back with the older
    // revision 3 snapshot value.
    const fresh = [testSpace('spc-health', [], { attention: 0, attentionRevision: 3 })]
    const previous = [testSpace('spc-health', [], { attention: 2, attentionRevision: 5 })]

    const merged = mergeSpaceAttention(fresh, previous)

    expect(merged[0]).toMatchObject({ attention: 2, attentionRevision: 5 })
  })

  it('keeps the fresh snapshot value when it is the newer revision', () => {
    const fresh = [testSpace('spc-health', [], { attention: 3, attentionRevision: 7 })]
    const previous = [testSpace('spc-health', [], { attention: 2, attentionRevision: 5 })]

    const merged = mergeSpaceAttention(fresh, previous)

    expect(merged[0]).toMatchObject({ attention: 3, attentionRevision: 7 })
  })

  it('leaves a Space with no previous counterpart as-is', () => {
    const fresh = [testSpace('spc-new', [], { attention: 1, attentionRevision: 1 })]

    const merged = mergeSpaceAttention(fresh, [])

    expect(merged).toEqual(fresh)
  })
})

function testOrder(
  cursor: number,
  pinnedSurfaceIds: string[] = [],
  regularSurfaceIds: string[] = [],
  spaceId = 'spc-health',
) {
  return { cursor, spaceId, pinnedSurfaceIds, regularSurfaceIds }
}

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
