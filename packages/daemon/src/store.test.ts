import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { seedSpaces } from './seed.ts'
import { SpacesEngine } from './spaces-engine.ts'
import { Store } from './store.ts'

const roots: string[] = []
const stores: Store[] = []
const now = () => new Date('2026-10-05T12:00:00.000Z')

function rootDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'veduta-store-seed-'))
  roots.push(root)
  return root
}

function openStore(root: string): Store {
  const store = new Store({ rootDir: root, now })
  stores.push(store)
  return store
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('Store fallback seeding (issue #35)', () => {
  it('boots a root with an existing user Space without inventing fallback Spaces or Surfaces', () => {
    const root = rootDir()
    const spaces = new SpacesEngine({ rootDir: root, now })
    const fitness = spaces.createSpace({ name: 'Fitness' })

    const store = openStore(root)

    expect(store.listSpaces().map((space) => space.id)).toEqual([fitness.id])
    expect(store.snapshot().spaces[0]?.surfaces).toHaveLength(1)
    expect(store.getStoredSurface('srf-meals')).toBeUndefined()
    expect(store.getStoredSurface('srf-goal')).toBeUndefined()
    expect(store.getStoredSurface('srf-groceries')).toBeUndefined()
  })

  it('seeds fallback Surfaces when their owning fallback Space already exists', () => {
    const root = rootDir()
    const spaces = new SpacesEngine({ rootDir: root, now })
    spaces.createSpace({ name: 'Health' })

    const store = openStore(root)

    expect(store.listSpaces().map((space) => space.id)).toEqual(['spc-health'])
    expect(store.getStoredSurface('srf-meals')?.spaceId).toBe('spc-health')
    expect(store.getStoredSurface('srf-goal')?.spaceId).toBe('spc-health')
    expect(store.getStoredSurface('srf-groceries')?.spaceId).toBe('spc-health')
  })

  it('rebuilds from persisted Surface files instead of fallback data', () => {
    const root = rootDir()
    const spaces = new SpacesEngine({ rootDir: root, now })
    const fitness = spaces.createSpace({ name: 'Fitness' })
    const [fallback] = seedSpaces({ relativeTimeNow: now }).surfaces
    if (!fallback) throw new Error('missing seed fixture')
    const restored = spaces.saveSurface({
      ...fallback,
      id: 'srf-restored',
      spaceId: fitness.id,
      title: 'Restored fitness goal',
    })

    const store = openStore(root)

    expect(store.getStoredSurface(restored.id)).toMatchObject(restored)
    expect(store.getStoredSurface('srf-goal')).toBeUndefined()
    expect(store.getStoredSurface('srf-meals')).toBeUndefined()
    expect(store.listSpaces().map((space) => space.id)).toEqual([fitness.id])
  })

  it('retains first-run seeds and persisted state when an ordinary root reopens', () => {
    const root = rootDir()
    const first = openStore(root)
    first.patchState(
      'srf-goal',
      [{ target: 'state', op: 'add', path: '/fixture', value: 'retained' }],
      {
        updatedBy: 'user',
      },
    )
    const original = first.getStoredSurface('srf-goal')
    first.close()
    stores.pop()

    const reopened = openStore(root)

    expect(reopened.listSpaces().map((space) => space.id)).toEqual(['spc-health'])
    expect(reopened.getStoredSurface('srf-goal')).toEqual(original)
    expect(reopened.getStoredSurface('srf-groceries')).toBeDefined()
    expect(reopened.getStoredSurface('srf-meals')).toBeDefined()
  })
})
