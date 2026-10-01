import { describe, expect, it } from 'vitest'
import {
  AtomNodeSchema,
  SurfaceSchema,
  fastActionInputsSchema,
  inputSetPlan,
  literalSetPlan,
} from './index.ts'

const options = [
  { label: 'First', value: 'first' },
  { label: 'Second', value: 'second' },
]

function selection(type: 'Checkbox' | 'Select' | 'RadioGroup' | 'DatePicker') {
  const spec =
    type === 'Checkbox'
      ? { type: 'boolean' as const }
      : type === 'Select' || type === 'RadioGroup'
        ? { type: 'string' as const, enum: options.map((option) => option.value) }
        : { type: 'string' as const }
  return {
    id: type,
    type,
    binding: 'value',
    props: { label: 'Choice', ...(spec.enum ? { options } : {}) },
    actions: [
      {
        name: type === 'Checkbox' ? 'toggle' : 'change',
        path: 'fast',
        plan: inputSetPlan('value', spec),
      },
    ],
  }
}

function surface(tree: unknown, value: unknown) {
  return {
    id: 'srf-controls',
    spaceId: 'spc-test',
    title: 'Controls',
    freshness: { updatedBy: 'agent', updatedAt: '2026-10-01T08:00:00.000Z' },
    tree,
    state: { value },
  }
}

describe('selection and action control acceptance', () => {
  it('rejects a Select without offered options before persistence', () => {
    expect(
      SurfaceSchema.safeParse(
        surface(
          {
            ...selection('Select'),
            props: { label: 'Choice' },
            actions: [
              { name: 'change', path: 'fast', plan: inputSetPlan('value', { type: 'string' }) },
            ],
          },
          'first',
        ),
      ).success,
    ).toBe(false)
  })

  it('accepts each operable control and rejects inert, competing, or discarded semantics', () => {
    const button = {
      id: 'button',
      type: 'Button',
      props: { label: 'Apply' },
      actions: [{ name: 'apply', path: 'fast', plan: literalSetPlan('value', true) }],
    }
    const controls = [
      button,
      selection('Checkbox'),
      selection('Select'),
      selection('RadioGroup'),
      selection('DatePicker'),
    ]
    for (const control of controls) {
      expect(AtomNodeSchema.safeParse(control).success).toBe(true)
      for (const invalid of [
        { ...control, props: { ...control.props, unsupported: true } },
        { ...control, props: { ...control.props, label: ' ' } },
        { ...control, children: [] },
        { ...control, actions: [] },
        { ...control, actions: [...control.actions, control.actions[0]] },
      ])
        expect(AtomNodeSchema.safeParse(invalid).success).toBe(false)
    }
    expect(AtomNodeSchema.safeParse({ ...button, binding: 'value' }).success).toBe(false)
    for (const type of ['Checkbox', 'Select', 'RadioGroup', 'DatePicker'] as const) {
      const control = selection(type)
      expect(AtomNodeSchema.safeParse({ ...control, binding: undefined }).success).toBe(false)
      expect(
        AtomNodeSchema.safeParse({ ...control, actions: [{ name: 'unresolved', path: 'agent' }] })
          .success,
      ).toBe(false)
      expect(
        AtomNodeSchema.safeParse({
          ...control,
          actions: [
            {
              ...control.actions[0],
              plan: inputSetPlan(
                'other',
                type === 'Checkbox' ? { type: 'boolean' } : { type: 'string' },
              ),
            },
          ],
        }).success,
      ).toBe(false)
    }
    expect(
      AtomNodeSchema.safeParse({
        ...button,
        actions: [{ name: 'review', path: 'agent', payload: { decisionId: 'decision' } }],
      }).success,
    ).toBe(true)
    expect(
      AtomNodeSchema.safeParse({
        ...button,
        actions: [
          { name: 'apply', path: 'fast', plan: inputSetPlan('value', { type: 'boolean' }) },
        ],
      }).success,
    ).toBe(false)
  })

  it('requires unique offered option identities and an exact typed offered-value input', () => {
    for (const type of ['Select', 'RadioGroup'] as const) {
      const control = selection(type)
      for (const invalidOptions of [
        [],
        ['first', 'second'],
        [
          { label: 'First', value: 'first' },
          { label: 'Duplicate', value: 'first' },
        ],
        [{ label: ' ', value: 'first' }],
      ]) {
        expect(
          AtomNodeSchema.safeParse({
            ...control,
            props: { label: 'Choice', options: invalidOptions },
          }).success,
        ).toBe(false)
      }
      expect(
        AtomNodeSchema.safeParse({
          ...control,
          actions: [
            { name: 'change', path: 'fast', plan: inputSetPlan('value', { type: 'string' }) },
          ],
        }).success,
      ).toBe(false)
      expect(SurfaceSchema.safeParse(surface(control, 'first')).success).toBe(true)
      for (const value of ['', 'third', 1, null])
        expect(SurfaceSchema.safeParse(surface(control, value)).success).toBe(false)
    }
    expect(SurfaceSchema.safeParse(surface(selection('Checkbox'), false)).success).toBe(true)
    expect(SurfaceSchema.safeParse(surface(selection('Checkbox'), 'false')).success).toBe(false)
  })

  it('accepts only real calendar dates and requires an explicit empty-date policy', () => {
    const control = selection('DatePicker')
    expect(SurfaceSchema.safeParse(surface(control, '2024-02-29')).success).toBe(true)
    for (const value of ['', '2025-02-29', '2026-04-31', '10/01/2026', '2026-10-01T00:00:00Z', 1]) {
      expect(SurfaceSchema.safeParse(surface(control, value)).success).toBe(false)
    }
    const optional = { ...control, props: { label: 'Choice', allowEmpty: true } }
    expect(SurfaceSchema.safeParse(surface(optional, '')).success).toBe(true)
    for (const candidate of [control, optional]) {
      const node = AtomNodeSchema.parse(candidate)
      const action = node.actions?.[0]
      if (action?.path !== 'fast') throw new Error('expected fast Action')
      expect(fastActionInputsSchema(node, action).safeParse({ value: '' }).success).toBe(
        candidate === optional,
      )
      expect(fastActionInputsSchema(node, action).safeParse({ value: '2025-02-29' }).success).toBe(
        false,
      )
      expect(fastActionInputsSchema(node, action).safeParse({ value: '2024-02-29' }).success).toBe(
        true,
      )
      expect(
        fastActionInputsSchema(
          { ...node, props: { ...node.props, disabled: true } },
          action,
        ).safeParse({ value: '2024-02-29' }).success,
      ).toBe(false)
    }
  })

  it('rejects a selection plan that overwrites its submitted value later in the batch', () => {
    const node = selection('Select')
    const plan = inputSetPlan('value', { type: 'string', enum: ['first', 'second'] })
    plan.steps.push({ op: 'set', target: 'value', value: { source: 'literal', value: 'first' } })
    expect(
      SurfaceSchema.safeParse(
        surface({ ...node, actions: [{ name: 'change', path: 'fast', plan }] }, 'first'),
      ).success,
    ).toBe(false)
  })

  it('rejects Buttons with a statically invalid literal or clear value for a bound control', () => {
    for (const [type, value, canonical] of [
      ['DatePicker', '2025-02-29', '2026-10-01'],
      ['DatePicker', '', '2026-10-01'],
      ['Select', 'third', 'first'],
      ['RadioGroup', 'third', 'first'],
      ['Checkbox', 'true', false],
    ] as const) {
      const plan = literalSetPlan('value', value)
      const tree = {
        id: 'root',
        type: 'Col',
        children: [
          selection(type),
          {
            id: 'button',
            type: 'Button',
            props: { label: 'Apply' },
            actions: [{ name: 'apply', path: 'fast', plan }],
          },
        ],
      }
      expect(SurfaceSchema.safeParse(surface(tree, canonical)).success).toBe(false)
      if (value === '') {
        plan.steps = [{ op: 'clear', target: 'value', value: '' }]
        expect(SurfaceSchema.safeParse(surface(tree, canonical)).success).toBe(false)
      }
    }
  })

  it('validates every known intermediate control value and rejects timestamp metadata as a calendar date', () => {
    const plan = literalSetPlan('value', '2025-02-29')
    plan.steps.push({
      op: 'set',
      target: 'value',
      value: { source: 'literal', value: '2026-10-01' },
    })
    const button = {
      id: 'button',
      type: 'Button',
      props: { label: 'Apply' },
      actions: [{ name: 'apply', path: 'fast', plan }],
    }
    const tree = { id: 'root', type: 'Col', children: [selection('DatePicker'), button] }
    expect(SurfaceSchema.safeParse(surface(tree, '2026-10-01')).success).toBe(false)
    plan.steps[0] = { op: 'set', target: 'value', value: { source: 'metadata', name: 'now' } }
    expect(SurfaceSchema.safeParse(surface(tree, '2026-10-01')).success).toBe(false)
    plan.steps[0] = {
      op: 'set',
      target: 'value',
      value: { source: 'literal', value: '2024-02-29' },
    }
    expect(SurfaceSchema.safeParse(surface(tree, '2026-10-01')).success).toBe(true)
    const optionalTree = {
      ...tree,
      children: [
        { ...selection('DatePicker'), props: { label: 'Choice', allowEmpty: true } },
        button,
      ],
    }
    plan.steps = [{ op: 'clear', target: 'value', value: '' }]
    expect(SurfaceSchema.safeParse(surface(optionalTree, '2026-10-01')).success).toBe(true)
  })
})
