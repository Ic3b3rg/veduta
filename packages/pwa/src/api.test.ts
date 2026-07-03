import { describe, expect, it } from 'vitest'
import { freshnessLabel, patchSurface } from './api.ts'

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

describe('patchSurface', () => {
  it('applies a Gateway patch to an existing Surface', () => {
    const patched = patchSurface(
      {
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
        state: { milk: false },
        freshness: { updatedAt: '2026-07-03T10:00:00.000Z', updatedBy: 'seed' },
      },
      {
        cursor: 1,
        at: '2026-07-03T10:01:00.000Z',
        spaceId: 'spc-home',
        patch: {
          surfaceId: 'srf-groceries',
          operations: [{ target: 'state', op: 'replace', path: '/milk', value: true }],
        },
        freshness: { updatedAt: '2026-07-03T10:01:00.000Z', updatedBy: 'user' },
      },
    )

    expect(patched.state['milk']).toBe(true)
    expect(patched.freshness.updatedBy).toBe('user')
  })
})
