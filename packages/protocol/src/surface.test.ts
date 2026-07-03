import { describe, expect, it } from 'vitest'
import { ActionSchema, SurfaceSchema } from './index.ts'

const groceries = {
  id: 'srf-groceries',
  spaceId: 'spc-health',
  title: 'Groceries',
  tree: {
    id: 'root',
    type: 'Box',
    children: [
      { id: 'title', type: 'Title', props: { text: 'Groceries' } },
      {
        id: 'milk',
        type: 'Checkbox',
        binding: 'milk',
        props: { label: 'Milk' },
        actions: [{ name: 'toggle', path: 'fast', stateKey: 'milk' }],
      },
    ],
  },
  state: { milk: false },
  freshness: { updatedAt: '2026-07-03T10:00:00.000Z', updatedBy: 'seed' },
}

describe('SurfaceSchema', () => {
  it('accepts a valid surface and round-trips it', () => {
    const parsed = SurfaceSchema.parse(groceries)
    expect(SurfaceSchema.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed)
  })

  it('rejects an unknown atom type with a readable error', () => {
    const bad = JSON.parse(JSON.stringify(groceries)) as typeof groceries
    ;(bad.tree.children![0]! as { type: string }).type = 'Carousel'
    const result = SurfaceSchema.safeParse(bad)
    expect(result.success).toBe(false)
  })

  it('rejects a surface without freshness metadata', () => {
    const { freshness: _freshness, ...withoutFreshness } = groceries
    expect(SurfaceSchema.safeParse(withoutFreshness).success).toBe(false)
  })
})

describe('ActionSchema', () => {
  it('defaults the path to "agent" (fail-safe)', () => {
    expect(ActionSchema.parse({ name: 'regenerate' }).path).toBe('agent')
  })
})
