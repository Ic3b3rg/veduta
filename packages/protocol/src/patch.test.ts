import { describe, expect, it } from 'vitest'
import { PatchSchema, applySurfacePatch, type Surface } from './index.ts'

describe('PatchSchema', () => {
  it('accepts JSON-Patch-like operations for Surface state and tree nodes', () => {
    const parsed = PatchSchema.parse({
      surfaceId: 'srf-groceries',
      operations: [
        { target: 'state', op: 'replace', path: '/milk', value: true },
        {
          target: 'tree',
          op: 'add',
          path: '/children/2',
          value: {
            id: 'chart',
            type: 'Chart',
            binding: 'spendByCategory',
            props: { variant: 'bar' },
          },
        },
      ],
    })

    expect(parsed.operations).toHaveLength(2)
  })

  it('rejects a remove patch that carries a value', () => {
    const result = PatchSchema.safeParse({
      surfaceId: 'srf-groceries',
      operations: [{ target: 'state', op: 'remove', path: '/milk', value: false }],
    })

    expect(result.success).toBe(false)
  })
})

describe('applySurfacePatch', () => {
  const surface: Surface = {
    id: 'srf-groceries',
    spaceId: 'spc-home',
    title: 'Groceries',
    tree: {
      id: 'root',
      type: 'Box',
      children: [
        {
          id: 'milk',
          type: 'Checkbox',
          binding: 'milk',
          props: { label: 'Milk' },
          actions: [{ name: 'toggle', path: 'fast', payload: {}, stateKey: 'milk' }],
        },
      ],
    },
    state: { milk: false, 'a/b': 'escaped' },
    freshness: { updatedAt: '2026-07-03T10:00:00.000Z', updatedBy: 'seed' },
  }

  it('applies state patches with JSON Pointer escaping and validates the result', () => {
    const patched = applySurfacePatch(surface, {
      surfaceId: surface.id,
      operations: [
        { target: 'state', op: 'replace', path: '/milk', value: true },
        { target: 'state', op: 'replace', path: '/a~1b', value: 'updated' },
      ],
    })

    expect(patched.state['milk']).toBe(true)
    expect(patched.state['a/b']).toBe('updated')
  })

  it('rejects patches for a different Surface', () => {
    expect(() =>
      applySurfacePatch(surface, {
        surfaceId: 'srf-other',
        operations: [{ target: 'state', op: 'replace', path: '/milk', value: true }],
      }),
    ).toThrow('cannot be applied')
  })

  it('applies tree add patches at the end of an array', () => {
    const patched = applySurfacePatch(surface, {
      surfaceId: surface.id,
      operations: [
        {
          target: 'tree',
          op: 'add',
          path: '/children/1',
          value: { id: 'note', type: 'Caption', props: { text: 'Buy fresh milk' } },
        },
      ],
    })

    expect(patched.tree.children?.map((child) => child.id)).toEqual(['milk', 'note'])
  })
})
