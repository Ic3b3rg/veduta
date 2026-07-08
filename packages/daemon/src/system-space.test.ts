import { SurfaceSchema, type Surface, type SurfaceSnapshot } from '@veduta/protocol'
import { describe, expect, it } from 'vitest'
import { SYSTEM_SPACE_ID, appendSystemSurface } from './system-space.ts'

const emptySnapshot: SurfaceSnapshot = { surfaceCursor: 0, spaces: [] }

function systemSurface(id: string): Surface {
  return SurfaceSchema.parse({
    id,
    spaceId: SYSTEM_SPACE_ID,
    title: id,
    tree: { id: 'root', type: 'Box', children: [] },
    state: {},
    freshness: { updatedAt: '2026-07-08T10:00:00.000Z', updatedBy: 'system' },
  })
}

describe('appendSystemSurface', () => {
  it('creates the synthetic System Space on first use', () => {
    const snapshot = appendSystemSurface(emptySnapshot, systemSurface('srf-usage'))
    expect(snapshot.spaces).toHaveLength(1)
    expect(snapshot.spaces[0]).toMatchObject({ id: SYSTEM_SPACE_ID, slug: 'system' })
    expect(snapshot.spaces[0]?.surfaces.map((surface) => surface.id)).toEqual(['srf-usage'])
  })

  it('merges further daemon Surfaces into the one System Space', () => {
    const first = appendSystemSurface(emptySnapshot, systemSurface('srf-usage'))
    const second = appendSystemSurface(first, systemSurface('srf-connected-devices'))
    expect(second.spaces).toHaveLength(1)
    expect(second.spaces[0]?.surfaces.map((surface) => surface.id)).toEqual([
      'srf-usage',
      'srf-connected-devices',
    ])
  })
})
