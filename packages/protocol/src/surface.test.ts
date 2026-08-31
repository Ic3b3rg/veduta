import { describe, expect, it } from 'vitest'
import {
  ActionSchema,
  FormSubmitPayloadSchema,
  SurfaceSchema,
  SurfaceValidationError,
  parseSurface,
  surfaceRelativeTimeStatus,
} from './index.ts'

const textFormSurface = {
  id: 'srf-profile',
  spaceId: 'spc-home',
  title: 'Profile',
  tree: {
    id: 'profile-form',
    type: 'Form',
    props: { label: 'Profile details', submitLabel: 'Save profile' },
    actions: [
      {
        name: 'submit',
        path: 'fast',
        stateKeys: ['displayName', 'bio'],
      },
    ],
    children: [
      {
        id: 'display-name',
        type: 'Input',
        binding: 'displayName',
        props: { label: 'Display name', placeholder: 'Ada' },
      },
      {
        id: 'bio',
        type: 'Textarea',
        binding: 'bio',
        props: { label: 'Biography', rows: 4 },
      },
    ],
  },
  state: { displayName: 'Ada', bio: 'First programmer' },
  freshness: { updatedAt: '2026-08-31T20:00:00.000Z', updatedBy: 'agent' },
}

const shoppingChecklistWithChart = {
  id: 'srf-groceries',
  spaceId: 'spc-home',
  title: 'Shopping checklist',
  tree: {
    id: 'root',
    type: 'Box',
    children: [
      { id: 'title', type: 'Title', props: { text: 'Shopping checklist' } },
      {
        id: 'milk',
        type: 'Checkbox',
        binding: 'milk',
        props: { label: 'Milk' },
        actions: [{ name: 'toggle', path: 'fast', stateKey: 'milk' }],
      },
      {
        id: 'eggs',
        type: 'Checkbox',
        binding: 'eggs',
        props: { label: 'Eggs' },
        actions: [{ name: 'toggle', path: 'fast', stateKey: 'eggs' }],
      },
      {
        id: 'spend',
        type: 'Chart',
        binding: 'spendByCategory',
        props: { label: 'Spend by category', variant: 'bar' },
      },
    ],
  },
  state: {
    milk: false,
    eggs: true,
    spendByCategory: [
      { label: 'Dairy', value: 12 },
      { label: 'Produce', value: 19 },
    ],
  },
  freshness: { updatedAt: '2026-07-03T10:00:00.000Z', updatedBy: 'seed' },
}

describe('SurfaceSchema', () => {
  it('accepts one submit-only Form with multiple text fields', () => {
    const parsed = SurfaceSchema.parse(textFormSurface)

    expect(parsed.tree.actions).toEqual([
      {
        name: 'submit',
        path: 'fast',
        payload: {},
        stateKeys: ['displayName', 'bio'],
      },
    ])
  })

  it('rejects a text control outside a Form', () => {
    const result = SurfaceSchema.safeParse({
      ...shoppingChecklistWithChart,
      tree: {
        id: 'orphan-input',
        type: 'Input',
        binding: 'title',
        props: { label: 'Title' },
      },
      state: { title: 'Shopping list' },
    })

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues).toContainEqual(
        expect.objectContaining({
          path: ['tree'],
          message: 'Input must belong to a Form',
        }),
      )
    }
  })

  it('rejects a Form whose committed text value is not a string', () => {
    const result = SurfaceSchema.safeParse({
      id: 'srf-profile',
      spaceId: 'spc-home',
      title: 'Profile',
      tree: {
        id: 'profile-form',
        type: 'Form',
        props: { label: 'Profile details', submitLabel: 'Save profile' },
        actions: [{ name: 'submit', path: 'fast', stateKeys: ['bio'] }],
        children: [
          {
            id: 'bio',
            type: 'Textarea',
            binding: 'bio',
            props: { label: 'Biography' },
          },
        ],
      },
      state: { bio: 42 },
      freshness: { updatedAt: '2026-08-31T20:00:00.000Z', updatedBy: 'agent' },
    })

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues).toContainEqual(
        expect.objectContaining({
          path: ['state', 'bio'],
          message: 'Form text state "bio" must be a string',
        }),
      )
    }
  })

  it.each([
    {
      stateKeys: ['displayName'],
      message: 'Form submit targets must match its text fields (missing: "bio")',
    },
    {
      stateKeys: ['displayName', 'bio', 'nickname'],
      message: 'Form submit targets must match its text fields (extra: "nickname")',
    },
  ])('rejects incomplete Form submit targets: $message', ({ stateKeys, message }) => {
    const candidate = JSON.parse(JSON.stringify(textFormSurface))
    candidate.tree.actions[0].stateKeys = stateKeys
    candidate.state.nickname = 'Countess of Lovelace'

    const result = SurfaceSchema.safeParse(candidate)

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues).toContainEqual(
        expect.objectContaining({
          path: ['tree', 'actions', 0, 'stateKeys'],
          message,
        }),
      )
    }
  })

  it('rejects duplicate text bindings within one Form', () => {
    const candidate = JSON.parse(JSON.stringify(textFormSurface))
    candidate.tree.children[1].binding = 'displayName'
    candidate.tree.actions[0].stateKeys = ['displayName']

    const result = SurfaceSchema.safeParse(candidate)

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues).toContainEqual(
        expect.objectContaining({
          path: ['tree', 'children', 1, 'binding'],
          message: 'Form text binding "displayName" is duplicated',
        }),
      )
    }
  })

  it('rejects nested Forms and Forms without a text field', () => {
    const candidate = JSON.parse(JSON.stringify(textFormSurface))
    candidate.tree.children = [
      {
        id: 'nested-form',
        type: 'Form',
        props: { label: 'Nested', submitLabel: 'Save nested' },
        actions: [{ name: 'submit', path: 'fast', stateKeys: ['bio'] }],
        children: [
          { id: 'nested-bio', type: 'Textarea', binding: 'bio', props: { label: 'Biography' } },
        ],
      },
    ]
    candidate.tree.actions[0].stateKeys = ['displayName']

    const result = SurfaceSchema.safeParse(candidate)

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: ['tree', 'children'],
            message: 'Form requires at least one owned Input or Textarea',
          }),
          expect.objectContaining({
            path: ['tree', 'children', 0],
            message: 'Forms cannot be nested',
          }),
        ]),
      )
    }
  })

  it('accepts a shopping checklist with a chart and round-trips it', () => {
    const parsed = SurfaceSchema.parse(shoppingChecklistWithChart)
    expect(SurfaceSchema.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed)
  })

  it('rejects an unknown Atom with an actionable message', () => {
    const bad = JSON.parse(JSON.stringify(shoppingChecklistWithChart))
    bad.tree.children[0].type = 'Carousel'

    expect(() => parseSurface(bad)).toThrow(SurfaceValidationError)
    expect(() => parseSurface(bad)).toThrow('tree.children.0.type: unknown Atom "Carousel"')
  })

  it('rejects a broken binding with an actionable message', () => {
    const bad = JSON.parse(JSON.stringify(shoppingChecklistWithChart))
    bad.tree.children[1].binding = 'missing'

    expect(() => parseSurface(bad)).toThrow(SurfaceValidationError)
    expect(() => parseSurface(bad)).toThrow(
      'tree.children.1.binding: binding "missing" does not exist in Surface state',
    )
  })

  it('rejects a fast action that targets a missing state key', () => {
    const bad = JSON.parse(JSON.stringify(shoppingChecklistWithChart))
    bad.tree.children[1].actions[0].stateKey = 'missing'

    expect(() => parseSurface(bad)).toThrow(
      'tree.children.1.actions.0.stateKey: fast action "toggle" targets missing state key "missing"',
    )
  })

  it('rejects a surface without freshness metadata', () => {
    const { freshness: _freshness, ...withoutFreshness } = shoppingChecklistWithChart
    expect(SurfaceSchema.safeParse(withoutFreshness).success).toBe(false)
  })

  it('defaults pinned to false and pinnable to true when absent (issue 022)', () => {
    const parsed = SurfaceSchema.parse(shoppingChecklistWithChart)
    expect(parsed.pinned).toBe(false)
    expect(parsed.pinnable).toBe(true)
  })

  it('keeps explicit pinned/pinnable values', () => {
    const parsed = SurfaceSchema.parse({
      ...shoppingChecklistWithChart,
      pinned: true,
      pinnable: false,
    })
    expect(parsed.pinned).toBe(true)
    expect(parsed.pinnable).toBe(false)
  })

  it('normalizes occurrence instants and exposes current-window status without guessing legacy dates', () => {
    const surface = SurfaceSchema.parse({
      ...shoppingChecklistWithChart,
      tree: {
        id: 'root',
        type: 'Box',
        children: [
          { id: 'count', type: 'Stat', binding: 'todayCount', props: { label: 'Today' } },
          {
            id: 'rows',
            type: 'Table',
            binding: 'todayRows',
            props: { columns: ['id', 'amount'] },
          },
        ],
      },
      state: {
        records: [
          { id: 'dated', occurredAt: '2026-08-20T12:00:00+02:00', amount: 12 },
          { id: 'legacy', amount: 7 },
          { id: 'legacy-null', occurredAt: null, amount: 5 },
        ],
        todayRows: [{ id: 'dated', occurredAt: '2026-08-20T10:00:00.000Z', amount: 12 }],
        todayCount: 1,
      },
      validity: {
        kind: 'relative-time',
        timeZone: 'Europe/Rome',
        window: 'day',
        startsAt: '2026-08-19T22:00:00.000Z',
        expiresAt: '2026-08-20T22:00:00.000Z',
        source: { stateKey: 'records', occurredAtKey: 'occurredAt' },
        projectionStateKeys: ['todayRows', 'todayCount'],
      },
    })

    expect(surface.state['records']).toEqual([
      { id: 'dated', occurredAt: '2026-08-20T10:00:00.000Z', amount: 12 },
      { id: 'legacy', amount: 7 },
      { id: 'legacy-null', occurredAt: null, amount: 5 },
    ])
    expect(surfaceRelativeTimeStatus(surface, new Date('2026-08-20T12:00:00.000Z'))).toEqual({
      status: 'current',
      undatedRecords: 2,
      caveat:
        '2 source records have no occurrence date and are excluded from this relative-time view.',
    })
    expect(surfaceRelativeTimeStatus(surface, new Date('2026-08-20T22:00:00.000Z'))).toEqual({
      status: 'expired',
      undatedRecords: 2,
      caveat:
        '2 source records have no occurrence date and are excluded from this relative-time view.',
    })
  })

  it('requires every visible binding in a relative-time Surface to be a declared projection', () => {
    const result = SurfaceSchema.safeParse({
      ...shoppingChecklistWithChart,
      tree: {
        id: 'root',
        type: 'Box',
        children: [
          { id: 'rows', type: 'Table', binding: 'todayRows', props: { columns: ['item'] } },
          { id: 'total', type: 'Stat', binding: 'todayTotal', props: { label: 'Total' } },
        ],
      },
      state: { records: [], todayRows: [], todayTotal: 0 },
      validity: {
        kind: 'relative-time',
        timeZone: 'UTC',
        window: 'day',
        startsAt: '2026-08-20T00:00:00.000Z',
        expiresAt: '2026-08-21T00:00:00.000Z',
        source: { stateKey: 'records' },
        projectionStateKeys: ['todayRows'],
      },
    })

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues).toContainEqual(
        expect.objectContaining({
          path: ['tree', 'children', 1, 'binding'],
          message: 'relative-time binding "todayTotal" must be declared as a projection state key',
        }),
      )
    }
  })

  it('rejects fast actions that target relative source or projection state', () => {
    const result = SurfaceSchema.safeParse({
      ...shoppingChecklistWithChart,
      tree: {
        id: 'root',
        type: 'Box',
        children: [
          {
            id: 'done',
            type: 'Checkbox',
            binding: 'todayDone',
            props: { label: 'Done today' },
            actions: [{ name: 'toggle', path: 'fast', stateKey: 'todayDone' }],
          },
        ],
      },
      state: { records: [], todayDone: false },
      validity: {
        kind: 'relative-time',
        timeZone: 'UTC',
        window: 'day',
        startsAt: '2026-08-20T00:00:00.000Z',
        expiresAt: '2026-08-21T00:00:00.000Z',
        source: { stateKey: 'records' },
        projectionStateKeys: ['todayDone'],
      },
    })

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues).toContainEqual(
        expect.objectContaining({
          path: ['tree', 'children', 0, 'actions', 0, 'stateKey'],
          message: 'fast actions cannot target relative-time source or projection state',
        }),
      )
    }
  })

  it('rejects a parseable but non-ISO occurrence time', () => {
    const result = SurfaceSchema.safeParse({
      ...shoppingChecklistWithChart,
      tree: {
        id: 'root',
        type: 'Box',
        children: [
          { id: 'rows', type: 'Table', binding: 'todayRows', props: { columns: ['item'] } },
        ],
      },
      state: {
        records: [{ occurredAt: 'August 20, 2026' }],
        todayRows: [],
      },
      validity: {
        kind: 'relative-time',
        timeZone: 'Europe/Rome',
        window: 'day',
        startsAt: '2026-08-19T22:00:00.000Z',
        expiresAt: '2026-08-20T22:00:00.000Z',
        source: { stateKey: 'records' },
        projectionStateKeys: ['todayRows'],
      },
    })

    expect(result.success).toBe(false)
  })
})

describe('ActionSchema', () => {
  it('defaults the path to "agent" and payload to an empty object (fail-safe)', () => {
    expect(ActionSchema.parse({ name: 'regenerate' })).toEqual({
      name: 'regenerate',
      path: 'agent',
      payload: {},
    })
  })

  it('creates a fresh default payload for every parsed action', () => {
    const first = ActionSchema.parse({ name: 'regenerate' })
    const second = ActionSchema.parse({ name: 'regenerate' })
    expect(first.payload).not.toBe(second.payload)
  })

  it('rejects a fast action without a stateKey (undispatchable)', () => {
    const result = ActionSchema.safeParse({ name: 'toggle', path: 'fast' })
    expect(result.success).toBe(false)
  })

  it('rejects duplicate atomic state targets', () => {
    const result = ActionSchema.safeParse({
      name: 'submit',
      path: 'fast',
      stateKeys: ['name', 'name'],
    })

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues).toContainEqual(
        expect.objectContaining({
          path: ['stateKeys', 1],
          message: 'duplicate state key "name"',
        }),
      )
    }
  })

  it('accepts a declared action payload', () => {
    expect(
      ActionSchema.parse({
        name: 'regenerate',
        path: 'agent',
        payload: { reason: 'stale-surface' },
      }).payload,
    ).toEqual({ reason: 'stale-surface' })
  })
})

describe('FormSubmitPayloadSchema', () => {
  it('accepts a complete string field map', () => {
    expect(FormSubmitPayloadSchema.parse({ value: { displayName: 'Ada', bio: '' } })).toEqual({
      value: { displayName: 'Ada', bio: '' },
    })
  })

  it.each([{ value: { displayName: 42 } }, { value: { displayName: 'Ada' }, unexpected: true }])(
    'rejects a malformed submitted payload',
    (payload) => {
      expect(FormSubmitPayloadSchema.safeParse(payload).success).toBe(false)
    },
  )
})
