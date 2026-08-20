import {
  PatchSchema,
  SurfaceSchema,
  applySurfacePatch,
  type PatchOperation,
  type Surface,
} from '@veduta/protocol'
import { describe, expect, it } from 'vitest'
import { affectedAtomIdsForPatch } from './surface-motion.ts'

const surface = SurfaceSchema.parse({
  id: 'srf-motion',
  spaceId: 'spc-home',
  title: 'Motion regions',
  tree: {
    id: 'root',
    type: 'Box',
    children: [
      {
        id: 'summary-row',
        type: 'Row',
        children: [
          {
            id: 'status-stat',
            type: 'Stat',
            binding: 'status/summary',
            props: { label: 'Status' },
          },
          {
            id: 'next-stat',
            type: 'Stat',
            binding: 'nextCheck',
            props: { label: 'Next check' },
          },
        ],
      },
      {
        id: 'progress-stat',
        type: 'Progress',
        binding: 'progress',
        props: { label: 'Progress' },
      },
    ],
  },
  state: { 'status/summary': 'Waiting', nextCheck: 'Friday', progress: 0.4 },
  freshness: { updatedAt: '2026-08-20T10:00:00.000Z', updatedBy: 'agent' },
})

describe('affectedAtomIdsForPatch', () => {
  it('maps an escaped state path only to Atoms bound to that top-level state key', () => {
    const patch = operations([
      {
        target: 'state',
        op: 'replace',
        path: '/status~1summary',
        value: 'Ready',
      },
    ])

    expect(affectedAtomIdsForPatch(surface, patched(surface, patch), patch)).toEqual([
      'status-stat',
    ])
  })

  it('does not replay feedback for a state patch whose value is already rendered', () => {
    const patch = operations([
      {
        target: 'state',
        op: 'replace',
        path: '/status~1summary',
        value: 'Waiting',
      },
    ])

    expect(affectedAtomIdsForPatch(surface, patched(surface, patch), patch)).toEqual([])
  })

  it('maps a tree replacement to the replacement subtree root', () => {
    const patch = operations([
      {
        target: 'tree',
        op: 'replace',
        path: '/children/1',
        value: {
          id: 'replacement-progress',
          type: 'Progress',
          binding: 'progress',
          props: { label: 'Updated progress' },
        },
      },
    ])

    expect(affectedAtomIdsForPatch(surface, patched(surface, patch), patch)).toEqual([
      'replacement-progress',
    ])
  })

  it('does not replay feedback when tree operations restore the original tree', () => {
    const originalProgress = surface.tree.children?.[1]
    if (!originalProgress) throw new Error('expected the progress Atom')
    const patch = operations([
      {
        target: 'tree',
        op: 'replace',
        path: '/children/1',
        value: {
          ...originalProgress,
          props: { ...originalProgress.props, label: 'Temporary progress' },
        },
      },
      {
        target: 'tree',
        op: 'replace',
        path: '/children/1',
        value: originalProgress,
      },
    ])

    expect(affectedAtomIdsForPatch(surface, patched(surface, patch), patch)).toEqual([])
  })

  it('filters a restored Atom from a mixed tree patch that changes another Atom', () => {
    const originalProgress = surface.tree.children?.[1]
    const originalNext = surface.tree.children?.[0]?.children?.[1]
    if (!originalProgress || !originalNext) throw new Error('expected test Atoms')
    const patch = operations([
      {
        target: 'tree',
        op: 'replace',
        path: '/children/1',
        value: {
          ...originalProgress,
          props: { ...originalProgress.props, label: 'Temporary progress' },
        },
      },
      {
        target: 'tree',
        op: 'replace',
        path: '/children/1',
        value: originalProgress,
      },
      {
        target: 'tree',
        op: 'replace',
        path: '/children/0/children/1',
        value: {
          ...originalNext,
          props: { ...originalNext.props, label: 'Updated next check' },
        },
      },
    ])

    expect(affectedAtomIdsForPatch(surface, patched(surface, patch), patch)).toEqual(['next-stat'])
  })

  it('does not let a restored ancestor mask its genuinely changed descendant', () => {
    const originalRow = surface.tree.children?.[0]
    const originalNext = originalRow?.children?.[1]
    if (!originalRow || !originalNext) throw new Error('expected nested test Atoms')
    const patch = operations([
      {
        target: 'tree',
        op: 'replace',
        path: '/children/0',
        value: {
          ...originalRow,
          props: { feedback: 'temporary' },
        },
      },
      {
        target: 'tree',
        op: 'replace',
        path: '/children/0',
        value: originalRow,
      },
      {
        target: 'tree',
        op: 'replace',
        path: '/children/0/children/1',
        value: {
          ...originalNext,
          props: { ...originalNext.props, label: 'Updated next check' },
        },
      },
    ])

    expect(affectedAtomIdsForPatch(surface, patched(surface, patch), patch)).toEqual(['next-stat'])
  })

  it('keeps a removal fallback when another descendant also changes', () => {
    const originalNext = surface.tree.children?.[0]?.children?.[1]
    if (!originalNext) throw new Error('expected the nested test Atom')
    const patch = operations([
      { target: 'tree', op: 'remove', path: '/children/0/children/0' },
      {
        target: 'tree',
        op: 'replace',
        path: '/children/0/children/0',
        value: {
          ...originalNext,
          props: { ...originalNext.props, label: 'Updated next check' },
        },
      },
    ])

    expect(affectedAtomIdsForPatch(surface, patched(surface, patch), patch)).toEqual([
      'summary-row',
    ])
  })

  it('keeps a subtree replacement region when a separate descendant also changes', () => {
    const originalRow = surface.tree.children?.[0]
    const originalNext = originalRow?.children?.[1]
    if (!originalRow || !originalNext) throw new Error('expected nested test Atoms')
    const patch = operations([
      {
        target: 'tree',
        op: 'replace',
        path: '/children/0',
        value: { ...originalRow, children: [originalNext] },
      },
      {
        target: 'tree',
        op: 'replace',
        path: '/children/0/children/0',
        value: {
          ...originalNext,
          props: { ...originalNext.props, label: 'Updated next check' },
        },
      },
    ])

    expect(affectedAtomIdsForPatch(surface, patched(surface, patch), patch)).toEqual([
      'summary-row',
    ])
  })

  it('lets a subtree-only changed descendant suppress its restored ancestor', () => {
    const originalRow = surface.tree.children?.[0]
    const originalStatus = originalRow?.children?.[0]
    const originalNext = originalRow?.children?.[1]
    const originalProgress = surface.tree.children?.[1]
    if (!originalRow || !originalStatus || !originalNext || !originalProgress) {
      throw new Error('expected nested test Atoms')
    }
    const nestedSurface = SurfaceSchema.parse({
      ...surface,
      tree: {
        ...surface.tree,
        children: [
          {
            ...originalRow,
            children: [{ id: 'status-col', type: 'Col', children: [originalStatus] }, originalNext],
          },
          originalProgress,
        ],
      },
    })
    const nestedRow = nestedSurface.tree.children?.[0]
    if (!nestedRow) throw new Error('expected the nested row')
    const patch = operations([
      {
        target: 'tree',
        op: 'replace',
        path: '/children/0',
        value: { ...nestedRow, props: { feedback: 'temporary' } },
      },
      { target: 'tree', op: 'replace', path: '/children/0', value: nestedRow },
      { target: 'tree', op: 'remove', path: '/children/0/children/0/children/0' },
    ])

    expect(affectedAtomIdsForPatch(nestedSurface, patched(nestedSurface, patch), patch)).toEqual([
      'status-col',
    ])
  })

  it('pairs both sides of a new-id replacement below a restored ancestor', () => {
    const originalRow = surface.tree.children?.[0]
    const originalNext = originalRow?.children?.[1]
    if (!originalRow || !originalNext) throw new Error('expected nested test Atoms')
    const patch = operations([
      {
        target: 'tree',
        op: 'replace',
        path: '/children/0',
        value: { ...originalRow, props: { feedback: 'temporary' } },
      },
      { target: 'tree', op: 'replace', path: '/children/0', value: originalRow },
      {
        target: 'tree',
        op: 'replace',
        path: '/children/0/children/1',
        value: { ...originalNext, id: 'replacement-next' },
      },
    ])

    expect(affectedAtomIdsForPatch(surface, patched(surface, patch), patch)).toEqual([
      'replacement-next',
    ])
  })

  it('maps a removal to the smallest surviving parent region', () => {
    const patch = operations([{ target: 'tree', op: 'remove', path: '/children/0/children/0' }])

    expect(affectedAtomIdsForPatch(surface, patched(surface, patch), patch)).toEqual([
      'summary-row',
    ])
  })

  it('maps a tree move to the moved Atom instead of its siblings', () => {
    const patch = operations([
      {
        target: 'tree',
        op: 'move',
        from: '/children/0/children/1',
        path: '/children/0/children/0',
      },
    ])

    expect(affectedAtomIdsForPatch(surface, patched(surface, patch), patch)).toEqual(['next-stat'])
  })

  it('resolves later tree paths against the result of earlier operations', () => {
    const patch = operations([
      { target: 'tree', op: 'remove', path: '/children/0/children/0' },
      {
        target: 'tree',
        op: 'move',
        from: '/children/0/children/0',
        path: '/children/1',
      },
    ])

    expect(affectedAtomIdsForPatch(surface, patched(surface, patch), patch)).toEqual([
      'summary-row',
      'next-stat',
    ])
  })
})

function operations(input: PatchOperation[]): PatchOperation[] {
  return PatchSchema.parse({ surfaceId: surface.id, operations: input }).operations
}

function patched(current: Surface, patch: PatchOperation[]): Surface {
  return applySurfacePatch(current, { surfaceId: current.id, operations: patch })
}
