import { SurfaceSchema, type AtomNode, type Surface, type SurfaceTemplate } from '@veduta/protocol'
import { fromPartial } from '@total-typescript/shoehorn'
import { describe, expect, it } from 'vitest'
import {
  TEMPLATE_IMPORT_MAX_DEPTH,
  TEMPLATE_IMPORT_MAX_JSON_VALUES,
  TEMPLATE_IMPORT_MAX_STRING_LENGTH,
  TEMPLATE_MATCH_THRESHOLD,
  TEMPLATE_PROP_MAX_CHARS,
  matchTemplates,
  normalizedIntent,
  sanitizeImportedTemplate,
  surfaceFromTemplate,
  templateFromSurface,
  treeHash,
  treeSignature,
  walkAtomTree,
} from './templates.ts'

const LONG_LABEL = 'x'.repeat(TEMPLATE_PROP_MAX_CHARS + 1)

function tracker(): Surface {
  return fromPartial<Surface>({
    id: 'srf-tracker',
    spaceId: 'spc-health',
    title: 'Daily workout tracker',
    tree: {
      id: 'root',
      type: 'Box',
      children: [
        { id: 'title', type: 'Title', props: { text: 'Workout tracker' } },
        { id: 'notes', type: 'Markdown', props: { text: LONG_LABEL } },
        {
          id: 'log',
          type: 'Table',
          props: { rows: [{ day: 'Mon', reps: 10 }] },
        },
        {
          id: 'chart',
          type: 'Chart',
          props: { series: { pushups: [1, 2, 3] } },
        },
        {
          id: 'done',
          type: 'Checkbox',
          binding: 'done',
          props: { label: 'Done today' },
          actions: [{ name: 'toggle', path: 'fast', stateKey: 'done' }],
        },
        {
          id: 'reps',
          type: 'Stat',
          binding: 'reps',
          props: { label: 'Reps' },
        },
      ],
    },
    state: { done: true, reps: 42, unrelated: 'not bound' },
    freshness: { updatedAt: '2026-07-01T00:00:00.000Z', updatedBy: 'user' },
  })
}

describe('treeSignature', () => {
  it('is a sorted type:count digest, stable regardless of sibling order', () => {
    const a: AtomNode = {
      id: 'root',
      type: 'Box',
      children: [
        { id: 'a', type: 'Title' },
        { id: 'b', type: 'Stat' },
        { id: 'c', type: 'Stat' },
      ],
    }
    const b: AtomNode = {
      id: 'root',
      type: 'Box',
      children: [
        { id: 'c', type: 'Stat' },
        { id: 'a', type: 'Title' },
        { id: 'b', type: 'Stat' },
      ],
    }

    expect(treeSignature(a)).toBe('Box:1|Stat:2|Title:1')
    expect(treeSignature(a)).toBe(treeSignature(b))
  })

  it('does not throw RangeError on a node with a very large number of children', () => {
    // `stack.push(...node.children)` used to spread every child into
    // individual arguments, and V8 throws "Maximum call stack size exceeded"
    // well before this many arguments to a single call.
    const children: AtomNode[] = Array.from({ length: 200_000 }, (_, i) => ({
      id: `child-${i}`,
      type: 'Stat',
    }))
    const wide: AtomNode = { id: 'root', type: 'Box', children }

    expect(() => treeSignature(wide)).not.toThrow()
    expect(treeSignature(wide)).toBe(`Box:1|Stat:${children.length}`)
  })
})

describe('walkAtomTree', () => {
  it('visits every node exactly once, in preorder (root, then each child subtree, left to right)', () => {
    const tree: AtomNode = {
      id: 'root',
      type: 'Box',
      children: [
        { id: 'a', type: 'Title', children: [{ id: 'a1', type: 'Stat' }] },
        { id: 'b', type: 'Stat' },
      ],
    }

    const visited: string[] = []
    walkAtomTree(tree, (node) => visited.push(node.id))

    expect(visited).toEqual(['root', 'a', 'a1', 'b'])
  })
})

describe('treeHash', () => {
  it('is stable regardless of key order in the serialized tree', () => {
    const a: AtomNode = { id: 'n', type: 'Title', props: { text: 'hi', variant: 'lg' } }
    const b: AtomNode = { id: 'n', type: 'Title', props: { variant: 'lg', text: 'hi' } }
    expect(treeHash(a)).toBe(treeHash(b))
  })

  it('changes when the tree changes', () => {
    const a: AtomNode = { id: 'n', type: 'Title', props: { text: 'hi' } }
    const b: AtomNode = { id: 'n', type: 'Title', props: { text: 'bye' } }
    expect(treeHash(a)).not.toBe(treeHash(b))
  })
})

describe('templateFromSurface / surfaceFromTemplate round trip', () => {
  const surface = tracker()
  const template = templateFromSurface(surface, {
    savedBy: 'stability',
    savedAt: '2026-07-10T00:00:00.000Z',
    origin: 'trusted:user',
  })

  it('validates and reproduces the tree structure verbatim apart from reduced props', () => {
    expect(template.tree.id).toBe(surface.tree.id)
    expect(template.tree.children?.map((c) => c.id)).toEqual(
      surface.tree.children?.map((c) => c.id),
    )
    expect(template.tree.children?.map((c) => c.type)).toEqual(
      surface.tree.children?.map((c) => c.type),
    )

    const done = template.tree.children?.find((n) => n.id === 'done')
    expect(done?.binding).toBe('done')
    expect(done?.actions).toEqual([{ name: 'toggle', path: 'fast', stateKey: 'done', payload: {} }])
  })

  it('has every state key present and carries none of the source Surface state values', () => {
    expect(template.stateKeys).toEqual(['done', 'reps'])

    const instantiated = surfaceFromTemplate(template, {
      surfaceId: 'srf-new',
      spaceId: 'spc-other',
      updatedAt: '2026-07-11T00:00:00.000Z',
      updatedBy: 'agent',
    })

    expect(SurfaceIsValid(instantiated)).toBe(true)
    expect(Object.keys(instantiated.state).sort()).toEqual(['done', 'reps'])
    expect(instantiated.state.done).toBeNull()
    expect(instantiated.state.reps).toBeNull()
    // The Template never carried the unrelated, unbound state key at all.
    expect(instantiated.state.unrelated).toBeUndefined()
  })

  it('seeds supplied values and defaults the title to the Template name', () => {
    const instantiated = surfaceFromTemplate(template, {
      surfaceId: 'srf-new',
      spaceId: 'spc-other',
      state: { done: false, reps: 7 },
      updatedAt: '2026-07-11T00:00:00.000Z',
      updatedBy: 'agent',
    })

    expect(instantiated.state).toEqual({ done: false, reps: 7 })
    expect(instantiated.title).toBe(template.name)
  })

  it('rejects a supplied state key absent from the Template stateKeys', () => {
    expect(() =>
      surfaceFromTemplate(template, {
        surfaceId: 'srf-new',
        spaceId: 'spc-other',
        state: { ghost: true },
        updatedAt: '2026-07-11T00:00:00.000Z',
        updatedBy: 'agent',
      }),
    ).toThrow(/ghost/)
  })

  it('preserves an atomic Form contract and seeds missing text fields with strings', () => {
    const formTemplate = templateFromSurface(profileSurface(), {
      savedBy: 'stability',
      savedAt: '2026-07-10T00:00:00.000Z',
      origin: 'trusted:user',
    })

    expect(formTemplate.tree.actions?.[0]?.stateKeys).toEqual(['displayName', 'bio'])
    const instantiated = surfaceFromTemplate(formTemplate, {
      surfaceId: 'srf-profile-copy',
      spaceId: 'spc-other',
      updatedAt: '2026-07-11T00:00:00.000Z',
      updatedBy: 'agent',
    })
    expect(instantiated.state).toEqual({ bio: '', displayName: '' })
  })

  function SurfaceIsValid(surface: Surface): boolean {
    return surface.tree.id === 'root' && surface.spaceId === 'spc-other'
  }
})

function profileSurface(): Surface {
  return SurfaceSchema.parse({
    id: 'srf-profile',
    spaceId: 'spc-health',
    title: 'Profile',
    tree: {
      id: 'profile-form',
      type: 'Form',
      props: { label: 'Profile', submitLabel: 'Save' },
      actions: [{ name: 'submit', path: 'fast', stateKeys: ['displayName', 'bio'] }],
      children: [
        { id: 'name', type: 'Input', binding: 'displayName', props: { label: 'Name' } },
        { id: 'bio', type: 'Textarea', binding: 'bio', props: { label: 'Biography' } },
      ],
    },
    state: { displayName: 'Ada', bio: 'First programmer' },
    freshness: { updatedAt: '2026-07-01T00:00:00.000Z', updatedBy: 'user' },
  })
}

describe('prop reduction', () => {
  const template = templateFromSurface(tracker(), {
    savedBy: 'pin',
    savedAt: '2026-07-10T00:00:00.000Z',
    origin: 'trusted:user',
  })

  it('blanks a prop string over TEMPLATE_PROP_MAX_CHARS', () => {
    const notes = template.tree.children?.find((n) => n.id === 'notes')
    expect(notes?.props?.text).toBe('')
  })

  it('drops an array-valued prop and records it in dataProps', () => {
    const log = template.tree.children?.find((n) => n.id === 'log')
    expect(log?.props?.rows).toBeUndefined()
    expect(template.dataProps).toContain('log.rows')
  })

  it('drops an object-valued prop and records it in dataProps', () => {
    const chart = template.tree.children?.find((n) => n.id === 'chart')
    expect(chart?.props?.series).toBeUndefined()
    expect(template.dataProps).toContain('chart.series')
  })

  it('leaves a short label untouched', () => {
    const title = template.tree.children?.find((n) => n.id === 'title')
    expect(title?.props?.text).toBe('Workout tracker')
  })
})

describe('matchTemplates', () => {
  const BOX_TREE: AtomNode = { id: 'root', type: 'Box' }
  const STAT_TREE: AtomNode = { id: 'root', type: 'Stat' }

  function withId(
    id: string,
    intent: string,
    name: string,
    tree: AtomNode,
    savedAt: string,
  ): SurfaceTemplate {
    return fromPartial<SurfaceTemplate>({
      formatVersion: 1,
      id,
      name,
      intent,
      tree,
      stateKeys: [],
      dataProps: [],
      provenance: {
        sourceSurfaceId: 'srf-x',
        sourceSpaceId: 'spc-x',
        savedAt,
        savedBy: 'stability',
        origin: 'trusted:user',
      },
    })
  }

  it('ranks an exact intent + matching signature above a partial-intent match', () => {
    // `treeSignature(BOX_TREE)` matches the candidate's signature below;
    // `treeSignature(STAT_TREE)` does not — the signature is never read off
    // the Template's own (removed) `signature` field, only derived from its
    // `tree` on the fly, exactly as an attacker-supplied bundle cannot forge it.
    const exact = withId(
      'tpl-exact',
      'daily workout tracker',
      'Workout Tracker',
      BOX_TREE,
      '2026-07-01T00:00:00.000Z',
    )
    const partial = withId(
      'tpl-partial',
      'workout session tracker',
      'Workout Session',
      STAT_TREE,
      '2026-07-02T00:00:00.000Z',
    )

    const results = matchTemplates([partial, exact], {
      intent: 'daily workout tracker',
      signature: treeSignature(BOX_TREE),
    })

    expect(results.map((r) => r.template.id)).toEqual(['tpl-exact', 'tpl-partial'])
    expect(results[0]?.score).toBe(1)
    expect(results[1]?.score).toBeLessThan(1)
    expect(results[1]?.score).toBeGreaterThanOrEqual(TEMPLATE_MATCH_THRESHOLD)
  })

  it('drops a candidate below the threshold', () => {
    const unrelated = withId(
      'tpl-groceries',
      'grocery shopping list',
      'Groceries',
      BOX_TREE,
      '2026-07-01T00:00:00.000Z',
    )

    const results = matchTemplates([unrelated], { intent: 'daily workout tracker' })
    expect(results).toEqual([])
  })

  it('returns [] for a candidate intent that tokenizes to nothing', () => {
    const some = withId(
      'tpl-x',
      'daily workout tracker',
      'Tracker',
      BOX_TREE,
      '2026-07-01T00:00:00.000Z',
    )
    expect(matchTemplates([some], { intent: '   !!! ???' })).toEqual([])
  })

  it('breaks ties by savedAt desc, then id asc', () => {
    const older = withId(
      'tpl-b',
      'daily workout tracker',
      'Tracker',
      BOX_TREE,
      '2026-01-01T00:00:00.000Z',
    )
    const newer = withId(
      'tpl-a',
      'daily workout tracker',
      'Tracker',
      BOX_TREE,
      '2026-06-01T00:00:00.000Z',
    )
    const sameAgeA = withId(
      'tpl-z',
      'daily workout tracker',
      'Tracker',
      BOX_TREE,
      '2026-06-01T00:00:00.000Z',
    )
    const sameAgeB = withId(
      'tpl-y',
      'daily workout tracker',
      'Tracker',
      BOX_TREE,
      '2026-06-01T00:00:00.000Z',
    )

    const results = matchTemplates([older, newer], { intent: 'daily workout tracker' })
    expect(results.map((r) => r.template.id)).toEqual(['tpl-a', 'tpl-b'])

    const tied = matchTemplates([sameAgeA, sameAgeB], { intent: 'daily workout tracker' })
    expect(tied.map((r) => r.template.id)).toEqual(['tpl-y', 'tpl-z'])
  })

  it("does not trust a Template's own claim: a forged mismatched tree never earns the signature bonus", () => {
    // Before the fix, a persisted `signature` field let an imported bundle
    // advertise a signature that did not describe its own tree, stealing
    // (or dodging) the structural bonus. There is no such field to forge
    // now: the bonus can only ever reflect `treeSignature(template.tree)`.
    const forged = withId(
      'tpl-forged',
      'grocery shopping list',
      'Groceries',
      STAT_TREE, // a tree that does not match the candidate's signature
      '2026-07-01T00:00:00.000Z',
    )

    const results = matchTemplates([forged], {
      intent: 'daily workout tracker',
      signature: treeSignature(BOX_TREE),
    })

    // Intent overlap alone ("grocery shopping list" vs "daily workout
    // tracker") is below threshold, and the mismatched tree earns no bonus
    // to rescue it.
    expect(results).toEqual([])
  })
})

describe('normalizedIntent', () => {
  it('normalizes word order and duplicate words identically', () => {
    expect(normalizedIntent('daily workout tracker')).toBe(
      normalizedIntent('tracker workout daily'),
    )
    expect(normalizedIntent('workout workout tracker')).toBe(normalizedIntent('workout tracker'))
  })

  it('differs for a genuinely different intent', () => {
    expect(normalizedIntent('daily workout tracker')).not.toBe(normalizedIntent('grocery list'))
  })

  it('is stable regardless of case and punctuation, using the same tokenizer as matchTemplates', () => {
    expect(normalizedIntent('Daily, Workout Tracker!')).toBe(
      normalizedIntent('daily workout tracker'),
    )
  })
})

function validRawTemplate(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    formatVersion: 1,
    id: 'tpl-imported',
    name: 'Imported',
    intent: 'imported composition',
    tree: { id: 'root', type: 'Box' },
    stateKeys: [],
    dataProps: [],
    provenance: {
      sourceSurfaceId: 'srf-remote',
      sourceSpaceId: 'spc-remote',
      savedAt: '2026-07-01T00:00:00.000Z',
      savedBy: 'stability',
      origin: 'trusted:user',
    },
    ...overrides,
  }
}

/** Builds a single-child chain `depth` levels deep, iteratively — never recursively. */
function chainTree(depth: number): AtomNode {
  let node: AtomNode = { id: `n${depth}`, type: 'Box' }
  for (let level = depth - 1; level >= 0; level -= 1) {
    node = { id: `n${level}`, type: 'Box', children: [node] }
  }
  return node
}

describe('sanitizeImportedTemplate', () => {
  it('rejects a tree past the depth cap without a stack overflow', () => {
    const raw = validRawTemplate({ tree: chainTree(5000) })
    expect(() => sanitizeImportedTemplate(raw, 'import')).toThrow(
      new RegExp(String(TEMPLATE_IMPORT_MAX_DEPTH)),
    )
  })

  it('rejects a tree past the JSON-value-count cap', () => {
    const children = Array.from({ length: TEMPLATE_IMPORT_MAX_JSON_VALUES + 10 }, (_, i) => ({
      id: `child-${i}`,
      type: 'Box',
    }))
    const raw = validRawTemplate({ tree: { id: 'root', type: 'Box', children } })
    expect(() => sanitizeImportedTemplate(raw, 'import')).toThrow(
      new RegExp(String(TEMPLATE_IMPORT_MAX_JSON_VALUES)),
    )
  })

  it('rejects a string over the max length cap', () => {
    const raw = validRawTemplate({
      tree: {
        id: 'root',
        type: 'Title',
        props: { text: 'x'.repeat(TEMPLATE_IMPORT_MAX_STRING_LENGTH + 1) },
      },
    })
    expect(() => sanitizeImportedTemplate(raw, 'import')).toThrow(
      new RegExp(String(TEMPLATE_IMPORT_MAX_STRING_LENGTH)),
    )
  })

  it('neutralizes <<< in a prop value and in a node id', () => {
    const raw = validRawTemplate({
      tree: {
        id: 'root<<<injected',
        type: 'Title',
        props: { text: 'hello <<<UNTRUSTED>>> world' },
      },
    })

    const { template } = sanitizeImportedTemplate(raw, 'import')
    expect(template.tree.id).not.toContain('<<<')
    expect(template.tree.props?.text).not.toContain('<<<')
  })

  it('neutralizes <<< in a binding, keeping it consistent with the matching neutralized stateKeys entry', () => {
    // `SurfaceTemplateSchema` cross-checks every binding against `stateKeys`;
    // before this fix, `stateKeys` was neutralized but `binding` was not, so
    // this exact bundle failed the schema's own cross-check with an opaque
    // internal error instead of coming out sanitized.
    const raw = validRawTemplate({
      tree: { id: 'root', type: 'Checkbox', binding: 'done<<<injected' },
      stateKeys: ['done<<<injected'],
    })

    const { template } = sanitizeImportedTemplate(raw, 'import')
    expect(template.tree.binding).not.toContain('<<<')
    expect(template.stateKeys).toEqual([template.tree.binding])
  })

  it("neutralizes <<< in a fast action's stateKey, keeping it consistent with the matching neutralized stateKeys entry", () => {
    // Before this fix, `sanitizeAndFilterNode` neutralized an action's
    // `name` but not its `stateKey` — the same cross-check gap the binding
    // case above closes, but for the other half of `collectNodeBindingRefs`.
    const raw = validRawTemplate({
      tree: {
        id: 'root',
        type: 'Checkbox',
        actions: [{ name: 'toggle', path: 'fast', stateKey: 'done<<<injected' }],
      },
      stateKeys: ['done<<<injected'],
    })

    const { template } = sanitizeImportedTemplate(raw, 'import')
    const stateKey = template.tree.actions?.[0]?.stateKey
    expect(stateKey).not.toContain('<<<')
    expect(template.stateKeys).toEqual([stateKey])
  })

  it("neutralizes <<< in a Form action's stateKeys with its fields and Template stateKeys", () => {
    const raw = validRawTemplate({
      tree: {
        id: 'profile-form',
        type: 'Form',
        props: { label: 'Profile', submitLabel: 'Save' },
        actions: [{ name: 'submit', path: 'fast', stateKeys: ['displayName<<<injected'] }],
        children: [
          {
            id: 'name',
            type: 'Input',
            binding: 'displayName<<<injected',
            props: { label: 'Name' },
          },
        ],
      },
      stateKeys: ['displayName<<<injected'],
    })

    const { template } = sanitizeImportedTemplate(raw, 'import')
    const stateKeys = template.tree.actions?.[0]?.stateKeys
    expect(stateKeys?.[0]).not.toContain('<<<')
    expect(template.stateKeys).toEqual(stateKeys)
    expect(template.tree.children?.[0]?.binding).toBe(stateKeys?.[0])
  })

  it('neutralizes <<< in an action payload value and in a payload object key', () => {
    const raw = validRawTemplate({
      tree: {
        id: 'root',
        type: 'Checkbox',
        binding: 'done',
        actions: [
          {
            name: 'toggle',
            path: 'fast',
            stateKey: 'done',
            payload: { 'evil<<<key': 'evil<<<value' },
          },
        ],
      },
      stateKeys: ['done'],
    })

    const { template } = sanitizeImportedTemplate(raw, 'import')
    const payload = template.tree.actions?.[0]?.payload ?? {}
    expect(Object.keys(payload).some((key) => key.includes('<<<'))).toBe(false)
    expect(Object.values(payload).some((value) => String(value).includes('<<<'))).toBe(false)
  })

  it('neutralizes <<< in a prop object key, at the top level and nested inside an object-valued prop', () => {
    const raw = validRawTemplate({
      tree: {
        id: 'root',
        type: 'Title',
        props: {
          'evil<<<top': 'x',
          nested: { 'evil<<<inner': 'y' },
        },
      },
    })

    const { template } = sanitizeImportedTemplate(raw, 'import')
    const props = template.tree.props ?? {}
    expect(Object.keys(props).some((key) => key.includes('<<<'))).toBe(false)
    const nested = props['nested']
    expect(
      nested !== null && typeof nested === 'object' && !Array.isArray(nested)
        ? Object.keys(nested as Record<string, unknown>).some((key) => key.includes('<<<'))
        : true,
    ).toBe(false)
  })

  it('removes agent-path actions while fast actions survive, and reports exactly how many were stripped', () => {
    const raw = validRawTemplate({
      tree: {
        id: 'root',
        type: 'Checkbox',
        binding: 'done',
        actions: [
          { name: 'speak-to-agent', path: 'agent' },
          { name: 'toggle', path: 'fast', stateKey: 'done' },
        ],
      },
      stateKeys: ['done'],
    })

    const { template, strippedAgentActions } = sanitizeImportedTemplate(raw, 'import')
    expect(template.tree.actions).toEqual([
      { name: 'toggle', path: 'fast', stateKey: 'done', payload: {} },
    ])
    expect(strippedAgentActions).toBe(1)
  })

  it('counts stripped agent actions across the whole tree, not just the root node', () => {
    const raw = validRawTemplate({
      tree: {
        id: 'root',
        type: 'Box',
        actions: [{ name: 'a', path: 'agent' }],
        children: [
          {
            id: 'child',
            type: 'Box',
            actions: [
              { name: 'b', path: 'agent' },
              { name: 'c', path: 'fast', stateKey: 'x' },
            ],
          },
        ],
      },
      stateKeys: ['x'],
    })

    const { strippedAgentActions } = sanitizeImportedTemplate(raw, 'import')
    expect(strippedAgentActions).toBe(2)
  })

  it('rewrites provenance.origin to untrusted:<source>', () => {
    const { template } = sanitizeImportedTemplate(validRawTemplate(), 'gmail')
    expect(template.provenance.origin).toBe('untrusted:gmail')
  })
})

describe('templateId folds intent into the hash (issues/022-emergent-templates.md)', () => {
  it('gives two Templates the same name and tree but a different intent different ids', () => {
    const surface = tracker()
    const a = templateFromSurface(surface, {
      savedBy: 'pin',
      savedAt: '2026-07-10T00:00:00.000Z',
      origin: 'trusted:user',
      name: 'Tracker',
      intent: 'daily workout tracker',
    })
    const b = templateFromSurface(surface, {
      savedBy: 'pin',
      savedAt: '2026-07-10T00:00:00.000Z',
      origin: 'trusted:user',
      name: 'Tracker',
      intent: 'weekly progress review',
    })

    expect(a.id).not.toBe(b.id)
  })
})
