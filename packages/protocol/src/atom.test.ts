import { describe, expect, it } from 'vitest'
import {
  AtomNodeSchema,
  MAX_AUTOMATION_RUN_HISTORY,
  MAX_PENDING_SLOT_TIMEOUT_MS,
  MIN_PENDING_SLOT_TIMEOUT_MS,
  PendingAtomPropsSchema,
  SurfaceSchema,
  pendingSlotVariants,
} from './index.ts'

describe('Pending Atom protocol', () => {
  it.each([
    { variant: 'text', lines: 3 },
    { variant: 'list', rows: 4 },
    { variant: 'image' },
    { variant: 'stat' },
    { variant: 'chart' },
  ])('accepts a schema-validated $variant footprint', (props) => {
    const startedAt = '2026-08-21T12:00:00.000Z'
    expect(
      AtomNodeSchema.parse({
        id: `pending-${props.variant}`,
        type: 'Pending',
        props: { ...props, label: `${props.variant} content`, timeoutMs: 30_000, startedAt },
      }),
    ).toMatchObject({ type: 'Pending', props: { ...props, startedAt } })
  })

  it('publishes the complete footprint catalog and bounded timeout contract', () => {
    expect(pendingSlotVariants).toEqual(['text', 'list', 'image', 'stat', 'chart'])
    expect(MIN_PENDING_SLOT_TIMEOUT_MS).toBe(1_000)
    expect(MAX_PENDING_SLOT_TIMEOUT_MS).toBe(120_000)
  })

  it.each([
    undefined,
    {},
    { variant: 'video' },
    { variant: 'text', lines: 0 },
    { variant: 'text', lines: 7 },
    { variant: 'list', rows: 0 },
    { variant: 'list', rows: 9 },
    { variant: 'stat', rows: 3 },
    { variant: 'stat', startedAt: 'not-a-date' },
    { variant: 'chart', timeoutMs: MIN_PENDING_SLOT_TIMEOUT_MS - 1 },
    { variant: 'chart', timeoutMs: MAX_PENDING_SLOT_TIMEOUT_MS + 1 },
  ])('rejects malformed Pending props %#', (props) => {
    expect(PendingAtomPropsSchema.safeParse(props).success).toBe(false)
    expect(
      AtomNodeSchema.safeParse({ id: 'pending-malformed', type: 'Pending', props }).success,
    ).toBe(false)
  })

  it.each([
    { binding: 'pending' },
    { actions: [{ name: 'fill' }] },
    { children: [{ id: 'nested', type: 'Text', props: { text: 'Not a leaf' } }] },
  ])('rejects Pending nodes that are not leaves %#', (extra) => {
    expect(
      AtomNodeSchema.safeParse({
        id: 'pending-not-a-leaf',
        type: 'Pending',
        props: { variant: 'text' },
        ...extra,
      }).success,
    ).toBe(false)
  })

  it('keeps existing Atom props backward compatible', () => {
    expect(
      AtomNodeSchema.parse({
        id: 'existing-chart',
        type: 'Chart',
        props: { variant: 'future-chart-style', customOption: true },
      }),
    ).toMatchObject({
      id: 'existing-chart',
      type: 'Chart',
      props: { variant: 'future-chart-style', customOption: true },
    })
  })
})

describe('Disclosure and selection Atom contracts', () => {
  it('accepts nested disclosure Atoms and actionable controls', () => {
    expect(
      AtomNodeSchema.safeParse({
        id: 'details',
        type: 'Collapsible',
        props: { label: 'Details', defaultOpen: true },
        children: [{ id: 'detail-copy', type: 'Text', props: { text: 'More context' } }],
      }).success,
    ).toBe(true)
    expect(
      AtomNodeSchema.safeParse({
        id: 'sections',
        type: 'Accordion',
        props: { mode: 'single' },
        children: [
          {
            id: 'first',
            type: 'Collapsible',
            props: { label: 'First', defaultOpen: true },
            children: [{ id: 'first-copy', type: 'Text', props: { text: 'First answer' } }],
          },
          {
            id: 'second',
            type: 'Collapsible',
            props: { label: 'Second' },
            children: [{ id: 'second-copy', type: 'Text', props: { text: 'Second answer' } }],
          },
        ],
      }).success,
    ).toBe(true)
    expect(
      AtomNodeSchema.safeParse({
        id: 'notifications',
        type: 'Switch',
        binding: 'notifications',
        props: { label: 'Notifications' },
        actions: [{ name: 'toggle', path: 'fast', stateKey: 'notifications' }],
      }).success,
    ).toBe(true)
    expect(
      AtomNodeSchema.safeParse({
        id: 'city',
        type: 'Combobox',
        binding: 'city',
        props: {
          label: 'City',
          options: [
            { label: 'Rome', value: 'rome' },
            { label: 'Milan', value: 'milan' },
          ],
        },
        actions: [{ name: 'change', path: 'fast', stateKey: 'city' }],
      }).success,
    ).toBe(true)
  })

  it.each([
    { type: 'Collapsible', props: { label: '' }, children: [{ id: 't', type: 'Text' }] },
    { type: 'Collapsible', props: { label: 'Details' }, children: [] },
    {
      type: 'Collapsible',
      props: { label: 'Details', typo: true },
      children: [{ id: 't', type: 'Text' }],
    },
    { type: 'Accordion', props: {}, children: [{ id: 't', type: 'Text' }] },
    {
      type: 'Accordion',
      props: { mode: 'single' },
      children: [
        {
          id: 'a',
          type: 'Collapsible',
          props: { label: 'A', defaultOpen: true },
          children: [{ id: 'ta', type: 'Text' }],
        },
        {
          id: 'b',
          type: 'Collapsible',
          props: { label: 'B', defaultOpen: true },
          children: [{ id: 'tb', type: 'Text' }],
        },
      ],
    },
    { type: 'Switch', props: { label: 'Enabled' }, binding: 'enabled' },
    {
      type: 'Switch',
      props: { label: 'Enabled' },
      binding: 'enabled',
      actions: [{ name: 'change', path: 'fast', stateKey: 'enabled' }],
    },
    {
      type: 'Switch',
      props: { label: 'Enabled' },
      binding: 'enabled',
      actions: [{ name: 'toggle', path: 'fast', stateKey: 'other' }],
    },
    {
      type: 'Combobox',
      props: { label: 'City', options: [] },
      binding: 'city',
      actions: [{ name: 'change', path: 'fast', stateKey: 'city' }],
    },
    {
      type: 'Combobox',
      props: {
        label: 'City',
        options: [
          { label: 'Rome', value: 'rome' },
          { label: 'Other Rome', value: 'rome' },
        ],
      },
      binding: 'city',
      actions: [{ name: 'change', path: 'fast', stateKey: 'city' }],
    },
    {
      type: 'Combobox',
      props: { label: 'City', options: ['Rome'] },
      binding: 'city',
      actions: [{ name: 'change', path: 'fast', stateKey: 'city' }],
    },
  ])('rejects an unusable new Atom %#', (candidate) => {
    expect(AtomNodeSchema.safeParse({ id: 'invalid', ...candidate }).success).toBe(false)
  })

  it('rejects bound values that cannot be rendered by Switch and Combobox', () => {
    const tree = {
      id: 'root',
      type: 'Col',
      children: [
        {
          id: 'switch',
          type: 'Switch',
          binding: 'enabled',
          props: { label: 'Enabled' },
          actions: [{ name: 'toggle', path: 'fast', stateKey: 'enabled' }],
        },
        {
          id: 'city',
          type: 'Combobox',
          binding: 'city',
          props: { label: 'City', options: [{ label: 'Rome', value: 'rome' }] },
          actions: [{ name: 'change', path: 'fast', stateKey: 'city' }],
        },
      ],
    }
    const surface = {
      id: 'srf-controls',
      spaceId: 'spc-home',
      title: 'Controls',
      tree,
      state: { enabled: false, city: 'rome' },
      freshness: { updatedAt: '2026-09-28T10:00:00.000Z', updatedBy: 'seed' },
    }
    expect(SurfaceSchema.safeParse(surface).success).toBe(true)
    expect(
      SurfaceSchema.safeParse({ ...surface, state: { enabled: 'false', city: 'rome' } }).success,
    ).toBe(false)
    expect(
      SurfaceSchema.safeParse({ ...surface, state: { enabled: true, city: 'unknown' } }).success,
    ).toBe(false)
  })
})

describe('Automation Atom protocol', () => {
  it('keeps legacy Automation nodes without props valid', () => {
    expect(
      AtomNodeSchema.safeParse({
        id: 'legacy-automation-without-props',
        type: 'Automation',
      }).success,
    ).toBe(true)
  })

  it('keeps pre-history Automation props backward compatible', () => {
    expect(
      AtomNodeSchema.safeParse({
        id: 'legacy-automation',
        type: 'Automation',
        props: {
          title: 'L'.repeat(140),
          detail: 'Legacy schedule copy',
          enabled: true,
        },
      }).success,
    ).toBe(true)
  })

  it('accepts bounded, meaningful run history', () => {
    expect(
      AtomNodeSchema.parse({
        id: 'automation-12',
        type: 'Automation',
        props: {
          label: 'Weekly review',
          schedule: 'Every Monday',
          history: [
            {
              id: 'run-1',
              automationId: 12,
              scheduledFor: '2026-09-01T08:00:00.000Z',
              kind: 'changed',
              summary: 'Plan updated',
              at: '2026-09-01T08:00:01.000Z',
            },
          ],
        },
      }).props,
    ).toMatchObject({ history: [{ kind: 'changed' }] })
  })

  it('rejects routine checks and unbounded history', () => {
    const base = {
      id: 'run-1',
      automationId: 12,
      scheduledFor: '2026-09-01T08:00:00.000Z',
      summary: 'No changes',
      at: '2026-09-01T08:00:01.000Z',
    }
    expect(
      AtomNodeSchema.safeParse({
        id: 'automation-12',
        type: 'Automation',
        props: {
          label: 'Weekly review',
          schedule: 'Every Monday',
          history: [{ ...base, kind: 'unchanged' }],
        },
      }).success,
    ).toBe(false)
    expect(
      AtomNodeSchema.safeParse({
        id: 'automation-12',
        type: 'Automation',
        props: {
          label: 'Weekly review',
          schedule: 'Every Monday',
          history: Array.from({ length: MAX_AUTOMATION_RUN_HISTORY + 1 }, (_, index) => ({
            ...base,
            id: `run-${index}`,
            kind: 'failed',
          })),
        },
      }).success,
    ).toBe(false)
  })
})

describe('Form text Atom protocol', () => {
  it('rejects unsupported Input props instead of silently ignoring them', () => {
    const result = AtomNodeSchema.safeParse({
      id: 'title',
      type: 'Input',
      binding: 'title',
      props: { label: 'Title', misspelledPlaceholder: 'Ignored today' },
    })

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues).toContainEqual(
        expect.objectContaining({
          path: ['props'],
          message: expect.stringContaining('Unrecognized key(s) in object'),
        }),
      )
    }
  })

  it('requires Input to bind one canonical text value', () => {
    const result = AtomNodeSchema.safeParse({
      id: 'title',
      type: 'Input',
      props: { label: 'Title' },
    })

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues).toContainEqual(
        expect.objectContaining({ path: ['binding'], message: 'Input requires a binding' }),
      )
    }
  })

  it.each([
    { actions: [{ name: 'change', path: 'fast', stateKey: 'title' }] },
    { children: [{ id: 'nested', type: 'Text', props: { text: 'Not a leaf' } }] },
  ])('keeps Input a submit-only leaf %#', (extra) => {
    const result = AtomNodeSchema.safeParse({
      id: 'title',
      type: 'Input',
      binding: 'title',
      props: { label: 'Title' },
      ...extra,
    })

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues).toContainEqual(
        expect.objectContaining({ message: 'Input must be a submit-only leaf Atom' }),
      )
    }
  })

  it('rejects unsupported Textarea props instead of silently ignoring them', () => {
    const result = AtomNodeSchema.safeParse({
      id: 'notes',
      type: 'Textarea',
      binding: 'notes',
      props: { label: 'Notes', rows: 4, resize: 'horizontal' },
    })

    expect(result.success).toBe(false)
  })

  it.each([
    { binding: undefined },
    { binding: 'notes', actions: [{ name: 'change', path: 'fast', stateKey: 'notes' }] },
    {
      binding: 'notes',
      children: [{ id: 'nested', type: 'Text', props: { text: 'Not a leaf' } }],
    },
  ])('keeps Textarea a bound submit-only leaf %#', (extra) => {
    const result = AtomNodeSchema.safeParse({
      id: 'notes',
      type: 'Textarea',
      props: { label: 'Notes' },
      ...extra,
    })

    expect(result.success).toBe(false)
  })

  it('rejects unsupported Form props instead of rendering ambiguous submit behavior', () => {
    const result = AtomNodeSchema.safeParse({
      id: 'profile-form',
      type: 'Form',
      props: { label: 'Profile', submitLabel: 'Save', autosave: true },
      actions: [{ name: 'submit', path: 'fast', stateKeys: ['name'] }],
      children: [{ id: 'name', type: 'Input', binding: 'name', props: { label: 'Name' } }],
    })

    expect(result.success).toBe(false)
  })

  it('rejects unsupported Form action fields before they can be stripped', () => {
    const result = AtomNodeSchema.safeParse({
      id: 'profile-form',
      type: 'Form',
      props: { label: 'Profile', submitLabel: 'Save' },
      actions: [{ name: 'submit', path: 'fast', stateKeys: ['name'], unexpected: true }],
      children: [{ id: 'name', type: 'Input', binding: 'name', props: { label: 'Name' } }],
    })

    expect(result.success).toBe(false)
  })

  it.each([
    { binding: 'name' },
    { children: undefined },
    { actions: undefined },
    { actions: [{ name: 'save', path: 'fast', stateKeys: ['name'] }] },
    { actions: [{ name: 'submit', path: 'agent' }] },
    { actions: [{ name: 'submit', path: 'fast', stateKey: 'name' }] },
    {
      actions: [
        { name: 'submit', path: 'fast', payload: { source: 'profile' }, stateKeys: ['name'] },
      ],
    },
    {
      actions: [
        { name: 'submit', path: 'fast', stateKeys: ['name'] },
        { name: 'also-submit', path: 'fast', stateKeys: ['name'] },
      ],
    },
  ])('requires one unbound Form with one atomic submit action %#', (override) => {
    const result = AtomNodeSchema.safeParse({
      id: 'profile-form',
      type: 'Form',
      props: { label: 'Profile', submitLabel: 'Save' },
      actions: [{ name: 'submit', path: 'fast', stateKeys: ['name'] }],
      children: [{ id: 'name', type: 'Input', binding: 'name', props: { label: 'Name' } }],
      ...override,
    })

    expect(result.success).toBe(false)
  })

  it('reserves multi-key actions for Form submission', () => {
    const result = AtomNodeSchema.safeParse({
      id: 'save-button',
      type: 'Button',
      props: { label: 'Save' },
      actions: [{ name: 'submit', path: 'fast', stateKeys: ['name'] }],
    })

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues).toContainEqual(
        expect.objectContaining({
          path: ['actions', 0, 'stateKeys'],
          message: 'stateKeys actions are reserved for Form submission',
        }),
      )
    }
  })
})
