import { SurfaceSchema } from '@veduta/protocol'
import { describe, expect, it } from 'vitest'
import { fastActionIdempotencyKey, freshnessLabel, optimisticFastSurface } from './api.ts'

describe('freshnessLabel', () => {
  const now = Date.parse('2026-07-03T12:00:00.000Z')

  it('says "just now" under a minute', () => {
    expect(freshnessLabel('2026-07-03T11:59:40.000Z', now)).toBe('just now')
  })

  it('uses minutes under an hour', () => {
    expect(freshnessLabel('2026-07-03T11:15:00.000Z', now)).toBe('45m ago')
  })

  it('uses hours under a day and days beyond', () => {
    expect(freshnessLabel('2026-07-03T09:00:00.000Z', now)).toBe('3h ago')
    expect(freshnessLabel('2026-07-01T12:00:00.000Z', now)).toBe('2d ago')
  })
})

describe('fastActionIdempotencyKey', () => {
  it('is stable for the same Surface version and changes after freshness advances', () => {
    const input = {
      surfaceId: 'srf-groceries',
      surfaceUpdatedAt: '2026-07-03T10:00:00.000Z',
      nodeId: 'milk',
      actionName: 'toggle',
      value: true,
    }

    expect(fastActionIdempotencyKey(input)).toBe(fastActionIdempotencyKey(input))
    expect(
      fastActionIdempotencyKey({
        ...input,
        surfaceUpdatedAt: '2026-07-03T10:01:00.000Z',
      }),
    ).not.toBe(fastActionIdempotencyKey(input))
    expect(fastActionIdempotencyKey(input).length).toBeLessThan(128)
  })
})

describe('optimisticFastSurface', () => {
  it('updates the declared fast-action state key before the Gateway round trip completes', () => {
    const surface = SurfaceSchema.parse({
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
            actions: [{ name: 'toggle', path: 'fast', stateKey: 'milk' }],
          },
        ],
      },
      state: { milk: false },
      freshness: { updatedAt: '2026-07-03T10:00:00.000Z', updatedBy: 'seed' },
    })

    const milkNode = surface.tree.children?.[0]
    if (!milkNode) throw new Error('expected milk node in test Surface')

    const optimistic = optimisticFastSurface(
      surface,
      milkNode,
      'toggle',
      true,
      '2026-07-03T10:00:01.000Z',
    )

    expect(optimistic.state['milk']).toBe(true)
    expect(optimistic.freshness).toEqual({
      updatedAt: '2026-07-03T10:00:01.000Z',
      updatedBy: 'user',
    })
  })
})
