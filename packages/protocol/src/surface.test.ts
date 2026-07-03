import { describe, expect, it } from 'vitest'
import { ActionSchema, SurfaceSchema, SurfaceValidationError, parseSurface } from './index.ts'

const shoppingChecklistWithChart = {
  id: 'srf-groceries',
  spaceId: 'spc-home',
  title: 'Shopping checklist',
  tree: {
    id: 'root',
    type: 'Box',
    children: [
      { id: 'title', type: 'Title', props: { text: 'Shopping checklist' } },
      {
        id: 'milk',
        type: 'Checkbox',
        binding: 'milk',
        props: { label: 'Milk' },
        actions: [{ name: 'toggle', path: 'fast', stateKey: 'milk' }],
      },
      {
        id: 'eggs',
        type: 'Checkbox',
        binding: 'eggs',
        props: { label: 'Eggs' },
        actions: [{ name: 'toggle', path: 'fast', stateKey: 'eggs' }],
      },
      {
        id: 'spend',
        type: 'Chart',
        binding: 'spendByCategory',
        props: { label: 'Spend by category', variant: 'bar' },
      },
    ],
  },
  state: {
    milk: false,
    eggs: true,
    spendByCategory: [
      { label: 'Dairy', value: 12 },
      { label: 'Produce', value: 19 },
    ],
  },
  freshness: { updatedAt: '2026-07-03T10:00:00.000Z', updatedBy: 'seed' },
}

describe('SurfaceSchema', () => {
  it('accepts a shopping checklist with a chart and round-trips it', () => {
    const parsed = SurfaceSchema.parse(shoppingChecklistWithChart)
    expect(SurfaceSchema.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed)
  })

  it('rejects an unknown Atom with an actionable message', () => {
    const bad = JSON.parse(JSON.stringify(shoppingChecklistWithChart))
    bad.tree.children[0].type = 'Carousel'

    expect(() => parseSurface(bad)).toThrow(SurfaceValidationError)
    expect(() => parseSurface(bad)).toThrow('tree.children.0.type: unknown Atom "Carousel"')
  })

  it('rejects a broken binding with an actionable message', () => {
    const bad = JSON.parse(JSON.stringify(shoppingChecklistWithChart))
    bad.tree.children[1].binding = 'missing'

    expect(() => parseSurface(bad)).toThrow(SurfaceValidationError)
    expect(() => parseSurface(bad)).toThrow(
      'tree.children.1.binding: binding "missing" does not exist in Surface state',
    )
  })

  it('rejects a fast action that targets a missing state key', () => {
    const bad = JSON.parse(JSON.stringify(shoppingChecklistWithChart))
    bad.tree.children[1].actions[0].stateKey = 'missing'

    expect(() => parseSurface(bad)).toThrow(
      'tree.children.1.actions.0.stateKey: fast action "toggle" targets missing state key "missing"',
    )
  })

  it('rejects a surface without freshness metadata', () => {
    const { freshness: _freshness, ...withoutFreshness } = shoppingChecklistWithChart
    expect(SurfaceSchema.safeParse(withoutFreshness).success).toBe(false)
  })
})

describe('ActionSchema', () => {
  it('defaults the path to "agent" and payload to an empty object (fail-safe)', () => {
    expect(ActionSchema.parse({ name: 'regenerate' })).toEqual({
      name: 'regenerate',
      path: 'agent',
      payload: {},
    })
  })

  it('creates a fresh default payload for every parsed action', () => {
    const first = ActionSchema.parse({ name: 'regenerate' })
    const second = ActionSchema.parse({ name: 'regenerate' })
    expect(first.payload).not.toBe(second.payload)
  })

  it('rejects a fast action without a stateKey (undispatchable)', () => {
    const result = ActionSchema.safeParse({ name: 'toggle', path: 'fast' })
    expect(result.success).toBe(false)
  })

  it('accepts a declared action payload', () => {
    expect(
      ActionSchema.parse({
        name: 'regenerate',
        path: 'agent',
        payload: { reason: 'stale-surface' },
      }).payload,
    ).toEqual({ reason: 'stale-surface' })
  })
})
