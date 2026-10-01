import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  GatewayServerMessageSchema,
  SemanticValidationIssueSchema,
  SurfaceValidationError,
  parseSurface,
  semanticValidationIssues,
  PatchSchema,
} from './index.ts'

describe('machine-readable semantic validation issues', () => {
  it('reports the selected patch branch without unrelated state or remove errors', () => {
    const parsed = PatchSchema.safeParse({
      surfaceId: 'srf-test',
      operations: [
        {
          target: 'tree',
          op: 'replace',
          path: '',
          value: {
            id: 'table',
            type: 'Table',
            binding: 'rows',
            props: { columns: [{ key: 'item', label: 'Item' }] },
          },
        },
      ],
    })
    expect(parsed.success).toBe(false)
    if (parsed.success) return
    expect(semanticValidationIssues(parsed.error)).toEqual([
      {
        path: ['operations', 0, 'value', 'props', 'columns', 0],
        code: 'invalid_type',
        message: 'Expected string, received object',
      },
    ])
  })

  it('retains exact paths and stable codes for unsupported fields and semantic failures', () => {
    const schema = z
      .object({ props: z.object({ label: z.string() }).strict() })
      .strict()
      .superRefine((_value, ctx) => {
        ctx.addIssue({
          code: 'custom',
          path: ['children', 1, 'id'],
          params: { semanticCode: 'duplicate_node_id' },
          message: 'Atom ids must be unique across the complete tree',
        })
      })
    const parsed = schema.safeParse({ props: { label: 'Save', typo: true }, extra: true })
    expect(parsed.success).toBe(false)
    if (parsed.success) return

    expect(semanticValidationIssues(parsed.error)).toEqual([
      {
        path: ['props', 'typo'],
        code: 'unrecognized_keys',
        message: 'Unrecognized key "typo"',
      },
      { path: ['extra'], code: 'unrecognized_keys', message: 'Unrecognized key "extra"' },
      {
        path: ['children', 1, 'id'],
        code: 'duplicate_node_id',
        message: 'Atom ids must be unique across the complete tree',
      },
    ])
    for (const issue of semanticValidationIssues(parsed.error))
      expect(SemanticValidationIssueSchema.safeParse(issue).success).toBe(true)
  })

  it('unpacks action union failures to the individual invalid fields', () => {
    const parsed = z
      .object({
        action: z.union([z.object({ fast: z.string() }), z.object({ agent: z.number() })]),
      })
      .safeParse({ action: { fast: 1, agent: false } })
    expect(parsed.success).toBe(false)
    if (parsed.success) return
    expect(semanticValidationIssues(parsed.error)).toEqual([
      {
        path: ['action', 'fast'],
        code: 'invalid_type',
        message: 'Expected string, received number',
      },
      {
        path: ['action', 'agent'],
        code: 'invalid_type',
        message: 'Expected number, received boolean',
      },
    ])
  })

  it('publishes complete Surface failures through the shared error and wire contracts', () => {
    let failure: unknown
    try {
      parseSurface({
        id: 'srf-invalid',
        spaceId: 'spc-home',
        title: 'Invalid progress',
        tree: { id: 'progress', type: 'Progress', props: { label: 'Progress', value: 999 } },
        state: {},
        freshness: { updatedAt: '2026-10-01T10:00:00.000Z', updatedBy: 'seed' },
      })
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(SurfaceValidationError)
    if (!(failure instanceof SurfaceValidationError)) return
    expect(failure.code).toBe('invalid_surface')
    expect(failure.validationIssues).toContainEqual(
      expect.objectContaining({
        path: ['tree', 'props', 'value'],
        code: 'too_big',
      }),
    )
    const frame = {
      type: 'error',
      error: failure.message,
      code: failure.code,
      issues: failure.validationIssues,
    }
    expect(GatewayServerMessageSchema.parse(JSON.parse(JSON.stringify(frame)))).toEqual(frame)
  })
})
