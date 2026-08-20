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
