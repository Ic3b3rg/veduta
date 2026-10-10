import { describe, expect, it } from 'vitest'
import { inspectSurfacePatch, SurfaceSchema } from './index.ts'

describe('inspectSurfacePatch', () => {
  it('inspects ordered before/after values with the same final validation as applying a batch', () => {
    const before = { id: 'note', type: 'Text', props: { text: 'Before' } }
    const after = { id: 'note', type: 'Text', props: { text: 'After' } }
    const surface = SurfaceSchema.parse({
      id: 'srf-review',
      spaceId: 'spc-work',
      title: 'Review',
      tree: { id: 'root', type: 'Box', children: [before] },
      state: {},
      freshness: { updatedAt: '2026-10-10T12:00:00.000Z', updatedBy: 'agent' },
    })
    // The first step temporarily duplicates the id; only the final batch must validate.
    const review = inspectSurfacePatch(surface, {
      surfaceId: surface.id,
      operations: [
        {
          target: 'tree',
          op: 'add',
          path: '/children/0',
          value: { id: 'note', type: 'Text', props: { text: 'After' } },
        },
        { target: 'tree', op: 'remove', path: '/children/1' },
        { target: 'tree', op: 'move', from: '/children/0', path: '/children/0' },
      ],
    })
    expect(review.steps.map(({ before, after }) => ({ before, after }))).toEqual([
      { before: undefined, after },
      { before, after: undefined },
      { before: after, after },
    ])
    expect(review.surface.tree.children).toEqual([after])
    expect(surface.tree.children).toEqual([before])
    expect(() =>
      inspectSurfacePatch(surface, {
        surfaceId: surface.id,
        operations: [{ target: 'tree', op: 'remove', path: '/children/0' }],
      }),
    ).toThrow('visible content')
  })
})
