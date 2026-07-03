import { SurfaceSnapshotSchema } from '@veduta/protocol'
import { describe, expect, it } from 'vitest'
import {
  cachedSnapshot,
  mergeSurfaceOrder,
  moveSurfaceId,
  parseSurfaceDeepLink,
  saveSnapshot,
  surfaceDeepLink,
} from './home-state.ts'

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
