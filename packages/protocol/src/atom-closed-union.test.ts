import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  AtomNodeSchema,
  RenderableSurfaceSchema,
  SurfaceSchema,
  SurfaceTemplateSchema,
  semanticValidationIssues,
  inputSetPlan,
  type AtomNode,
} from './index.ts'

const text = { id: 'copy', type: 'Text', props: { text: 'Canonical content' } }
const surface = {
  id: 'srf-closed',
  spaceId: 'spc-home',
  title: 'Closed catalog',
  tree: { id: 'root', type: 'Box', children: [text] },
  state: {},
  freshness: { updatedAt: '2026-10-01T10:00:00.000Z', updatedBy: 'seed' },
}

describe('closed Atom authoring union', () => {
  it('rejects unsupported node fields instead of dropping them', () => {
    const result = SurfaceSchema.safeParse({
      ...surface,
      tree: { ...surface.tree, children: [{ ...text, style: { color: 'red' } }] },
    })
    expect(result.success).toBe(false)
    if (result.success) return
    expect(semanticValidationIssues(result.error)).toContainEqual({
      path: ['tree', 'children', 0, 'style'],
      code: 'unrecognized_keys',
      message: 'Unrecognized key "style"',
    })
  })

  it('rejects duplicate ids anywhere in the complete authoring tree', () => {
    const tree = {
      ...surface.tree,
      children: [text, { id: 'other', type: 'Col', children: [{ ...text, type: 'Caption' }] }],
    }
    const parsed = SurfaceSchema.safeParse({ ...surface, tree })
    expect(parsed.success).toBe(false)
    if (parsed.success) return
    expect(semanticValidationIssues(parsed.error)).toContainEqual(
      expect.objectContaining({
        path: ['tree', 'children', 1, 'children', 0, 'id'],
        code: 'duplicate_node_id',
      }),
    )
    expect(AtomNodeSchema.safeParse(tree).success).toBe(false)
    expect(
      SurfaceTemplateSchema.safeParse({
        formatVersion: 1,
        id: 'tpl-closed',
        name: 'Closed',
        intent: 'General composition',
        tree,
        stateKeys: [],
        dataProps: [],
        provenance: {
          sourceSurfaceId: surface.id,
          sourceSpaceId: surface.spaceId,
          savedAt: surface.freshness.updatedAt,
          savedBy: 'pin',
          origin: 'trusted:user',
        },
      }).success,
    ).toBe(false)
  })

  it('retains actual unknown wire nodes while validating known branches and ids', () => {
    const tree = {
      id: 'future',
      type: 'FuturePanel',
      props: { futureOption: true },
      binding: 'futureUnimplementedBinding',
      children: [text],
    }
    const read = RenderableSurfaceSchema.parse({ ...surface, tree })
    expect(read.tree).toMatchObject(tree)
    expect(SurfaceSchema.safeParse(read).success).toBe(false)
    expect(
      RenderableSurfaceSchema.safeParse({
        ...surface,
        tree: { ...tree, children: [{ ...text, props: { text: 'Copy', unsupported: true } }] },
      }).success,
    ).toBe(false)
    expect(
      RenderableSurfaceSchema.safeParse({ ...surface, tree: { ...tree, id: text.id } }).success,
    ).toBe(false)
  })

  it('exposes per-type props and Action shapes in the parsed TypeScript contract', () => {
    type Input = Extract<AtomNode, { type: 'Input' }>
    type Form = Extract<AtomNode, { type: 'Form' }>
    expectTypeOf<Input['binding']>().toEqualTypeOf<string>()
    expectTypeOf<Input['props']>().toMatchTypeOf<{
      label: string
      valueType?: 'number' | undefined
    }>()
    expectTypeOf<Form['actions'][number]['path']>().toEqualTypeOf<'fast'>()
    expectTypeOf<Form['actions'][number]['name']>().toEqualTypeOf<'submit'>()
  })

  it.each([
    {
      type: 'Switch',
      name: 'toggle',
      props: { label: 'Enabled' },
      value: false,
      spec: { type: 'boolean' },
    },
    {
      type: 'Combobox',
      name: 'change',
      props: { label: 'City', options: [{ label: 'Rome', value: 'rome' }] },
      value: 'rome',
      spec: { type: 'string' },
    },
    {
      type: 'Automation',
      name: 'toggle',
      props: { label: 'Review', schedule: 'Every week' },
      value: false,
      spec: { type: 'boolean' },
    },
  ])(
    'rejects a fast $type that overwrites its owning typed gesture',
    ({ type, name, props, value, spec }) => {
      const plan = inputSetPlan(
        'choice',
        spec.type === 'boolean' ? { type: 'boolean' } : { type: 'string' },
      )
      const parsed = SurfaceSchema.safeParse({
        ...surface,
        tree: {
          id: 'control',
          type,
          props,
          binding: 'choice',
          actions: [
            {
              name,
              path: 'fast',
              plan: {
                ...plan,
                steps: [
                  ...plan.steps,
                  { op: 'set', target: 'choice', value: { source: 'literal', value } },
                ],
              },
            },
          ],
        },
        state: { choice: value },
      })
      expect(parsed.success).toBe(false)
      if (parsed.success) return
      expect(semanticValidationIssues(parsed.error)).toContainEqual(
        expect.objectContaining({
          path: ['tree', 'actions', 0, 'plan', 'steps'],
          code: 'invalid_bound_control_write',
        }),
      )
    },
  )
})
