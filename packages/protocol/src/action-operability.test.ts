import { describe, expect, it } from 'vitest'
import { SurfaceSchema, semanticValidationIssues } from './index.ts'

const base = {
  id: 'srf-operability',
  spaceId: 'spc-home',
  title: 'Operable plans',
  freshness: { updatedAt: '2026-10-01T10:00:00.000Z', updatedBy: 'agent' },
}

describe('complete Surface Action operability', () => {
  it('rejects a shared selection when any offered choice makes another bound control invalid', () => {
    function selection(id: string, values: string[]) {
      return {
        id,
        type: 'Select',
        binding: 'selection',
        props: { label: id, options: values.map((value) => ({ label: value, value })) },
        actions: [
          {
            name: 'change',
            path: 'fast',
            plan: {
              inputs: { value: { type: 'string', enum: values } },
              targets: { selection: { type: 'string' } },
              steps: [
                {
                  op: 'set',
                  target: 'selection',
                  value: { source: 'input', name: 'value' },
                },
              ],
            },
          },
        ],
      }
    }

    const surface = {
      ...base,
      state: { selection: 'a' },
      tree: {
        id: 'root',
        type: 'Box',
        children: [selection('first', ['a', 'b']), selection('second', ['a', 'c'])],
      },
    }
    const invalid = SurfaceSchema.safeParse(surface)
    expect(invalid.success).toBe(false)
    if (invalid.success) return
    expect(semanticValidationIssues(invalid.error)).toContainEqual(
      expect.objectContaining({
        path: ['tree', 'children', 0, 'actions', 0, 'plan', 'steps', 0, 'value'],
        code: 'invalid_atom_action_value',
      }),
    )

    expect(
      SurfaceSchema.safeParse({
        ...surface,
        tree: {
          ...surface.tree,
          children: [selection('first', ['a', 'b']), selection('second', ['a', 'b'])],
        },
      }).success,
    ).toBe(true)
  })

  it('rejects an optional DatePicker whose empty choice breaks a required peer', () => {
    function picker(id: string, allowEmpty: boolean) {
      return {
        id,
        type: 'DatePicker',
        binding: 'date',
        props: { label: id, allowEmpty },
        actions: [
          {
            name: 'change',
            path: 'fast',
            plan: {
              inputs: { value: { type: 'string' } },
              targets: { date: { type: 'string' } },
              steps: [{ op: 'set', target: 'date', value: { source: 'input', name: 'value' } }],
            },
          },
        ],
      }
    }
    const parsed = SurfaceSchema.safeParse({
      ...base,
      state: { date: '2026-10-01' },
      tree: {
        id: 'root',
        type: 'Box',
        children: [picker('optional', true), picker('required', false)],
      },
    })
    expect(parsed.success).toBe(false)
    if (parsed.success) return
    expect(semanticValidationIssues(parsed.error)).toContainEqual(
      expect.objectContaining({
        path: ['tree', 'children', 0, 'actions', 0, 'plan', 'steps', 0, 'value'],
        code: 'invalid_atom_action_value',
      }),
    )
  })

  it('rejects an append whose declared record can never supply the Chart series', () => {
    const parsed = SurfaceSchema.safeParse({
      ...base,
      state: { records: [], draft: '' },
      tree: {
        id: 'root',
        type: 'Box',
        children: [
          {
            id: 'chart',
            type: 'Chart',
            binding: 'records',
            props: {
              type: 'line',
              xKey: 'id',
              yKey: 'kg',
              label: 'Measurements',
              xLabel: 'Record',
              yLabel: 'kg',
              emptyText: 'No measurements',
            },
          },
          {
            id: 'form',
            type: 'Form',
            props: { label: 'Record', submitLabel: 'Log' },
            children: [
              {
                id: 'draft',
                type: 'Input',
                binding: 'draft',
                props: { label: 'Amount', valueType: 'number' },
              },
            ],
            actions: [
              {
                name: 'submit',
                path: 'fast',
                plan: {
                  inputs: { draft: { type: 'number' } },
                  targets: {
                    records: {
                      type: 'array',
                      items: {
                        type: 'object',
                        identityKey: 'id',
                        fields: { id: { type: 'string' }, amount: { type: 'number' } },
                      },
                    },
                  },
                  steps: [
                    {
                      op: 'append',
                      target: 'records',
                      value: {
                        source: 'object',
                        fields: {
                          id: { source: 'metadata', name: 'recordId' },
                          amount: { source: 'input', name: 'draft' },
                        },
                      },
                    },
                  ],
                },
              },
            ],
          },
        ],
      },
    })
    expect(parsed.success).toBe(false)
    if (parsed.success) return
    expect(semanticValidationIssues(parsed.error)).toContainEqual(
      expect.objectContaining({
        path: ['tree', 'children', 1, 'actions', 0, 'plan', 'steps', 0, 'value'],
        code: 'invalid_atom_action_value',
      }),
    )
  })
  it('rejects a clear value that can never satisfy its bound text Atom', () => {
    const parsed = SurfaceSchema.safeParse({
      ...base,
      state: { copy: 'Visible copy' },
      tree: {
        id: 'root',
        type: 'Box',
        children: [
          { id: 'copy', type: 'Text', binding: 'copy' },
          {
            id: 'clear',
            type: 'Button',
            props: { label: 'Clear' },
            actions: [
              {
                name: 'clear',
                path: 'fast',
                plan: {
                  inputs: {},
                  targets: { copy: { type: 'string', nullable: true } },
                  steps: [{ op: 'clear', target: 'copy', value: null }],
                },
              },
            ],
          },
        ],
      },
    })
    expect(parsed.success).toBe(false)
    if (parsed.success) return
    expect(semanticValidationIssues(parsed.error)).toContainEqual(
      expect.objectContaining({
        path: ['tree', 'children', 1, 'actions', 0, 'plan', 'steps', 0, 'value'],
        code: 'invalid_atom_action_value',
      }),
    )
  })
})
