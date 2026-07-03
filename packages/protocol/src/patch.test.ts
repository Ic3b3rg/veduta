import { describe, expect, it } from 'vitest'
import { PatchSchema } from './index.ts'

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
