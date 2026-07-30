import { describe, expect, it } from 'vitest'
import { SurfaceTemplateIdSchema, SurfaceTemplateSchema, TemplateBundleSchema } from './index.ts'

const validTemplate = {
  formatVersion: 1 as const,
  id: 'tpl-shopping-checklist',
  name: 'Shopping checklist',
  intent: 'shopping checklist for groceries',
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
    ],
  },
  stateKeys: ['milk', 'eggs'],
  dataProps: [],
  provenance: {
    sourceSurfaceId: 'srf-groceries',
    sourceSpaceId: 'spc-home',
    savedAt: '2026-07-03T10:00:00.000Z',
    savedBy: 'stability' as const,
    origin: 'trusted:user',
  },
}

describe('SurfaceTemplateIdSchema', () => {
  it('accepts a well-formed template id', () => {
    expect(SurfaceTemplateIdSchema.safeParse('tpl-shopping-checklist').success).toBe(true)
  })

  it('rejects an id outside the grammar (path-traversal guard)', () => {
    expect(SurfaceTemplateIdSchema.safeParse('tpl-../../etc/passwd').success).toBe(false)
    expect(SurfaceTemplateIdSchema.safeParse('not-a-template').success).toBe(false)
    expect(SurfaceTemplateIdSchema.safeParse('tpl-').success).toBe(false)
  })
})

describe('SurfaceTemplateSchema', () => {
  it('accepts a well-formed Template and round-trips it through JSON', () => {
    const parsed = SurfaceTemplateSchema.parse(validTemplate)
    expect(SurfaceTemplateSchema.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed)
  })

  it('rejects a binding absent from stateKeys', () => {
    const bad = JSON.parse(JSON.stringify(validTemplate))
    bad.stateKeys = ['milk']

    const result = SurfaceTemplateSchema.safeParse(bad)
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0]?.message).toContain('binding "eggs" does not exist')
    }
  })

  it('rejects a fast action stateKey absent from stateKeys', () => {
    const bad = JSON.parse(JSON.stringify(validTemplate))
    // Break only the fast action's target, leaving the binding itself valid,
    // so this exercises the fast-action branch specifically.
    bad.tree.children[2].actions[0].stateKey = 'ghost'

    const result = SurfaceTemplateSchema.safeParse(bad)
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(
        result.error.issues.some((issue) => issue.message.includes('fast action "toggle"')),
      ).toBe(true)
    }
  })

  it('rejects an id outside the grammar', () => {
    const bad = { ...validTemplate, id: 'not-valid' }
    expect(SurfaceTemplateSchema.safeParse(bad).success).toBe(false)
  })

  it('rejects an unknown origin shape', () => {
    const bad = {
      ...validTemplate,
      provenance: { ...validTemplate.provenance, origin: 'anonymous' },
    }
    expect(SurfaceTemplateSchema.safeParse(bad).success).toBe(false)
  })

  it('accepts a trusted:system and an untrusted:<source> origin', () => {
    expect(
      SurfaceTemplateSchema.safeParse({
        ...validTemplate,
        provenance: { ...validTemplate.provenance, origin: 'trusted:system' },
      }).success,
    ).toBe(true)
    expect(
      SurfaceTemplateSchema.safeParse({
        ...validTemplate,
        provenance: { ...validTemplate.provenance, origin: 'untrusted:gmail' },
      }).success,
    ).toBe(true)
  })
})

describe('TemplateBundleSchema', () => {
  it('round-trips a bundle of Templates through JSON', () => {
    const bundle = {
      formatVersion: 1 as const,
      exportedAt: '2026-07-03T10:00:00.000Z',
      templates: [validTemplate],
    }
    const parsed = TemplateBundleSchema.parse(bundle)
    expect(TemplateBundleSchema.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed)
  })

  it('rejects a bundle containing an invalid Template', () => {
    const bad = {
      formatVersion: 1 as const,
      exportedAt: '2026-07-03T10:00:00.000Z',
      templates: [{ ...validTemplate, stateKeys: [] }],
    }
    expect(TemplateBundleSchema.safeParse(bad).success).toBe(false)
  })
})
