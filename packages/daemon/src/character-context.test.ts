import { describe, expect, it } from 'vitest'
import { characterDocumentBody, characterSection, defaultSoul } from './character-context.ts'
import { LEGACY_SOUL } from './legacy-character.ts'

describe('effective injected character documents', () => {
  it('measures USER after trimming without counting the generated section wrapper', () => {
    const body = characterDocumentBody('USER', ` \n${'😀'.repeat(1000)}\n `)
    expect(body.length).toBe(2000)
    expect(characterDocumentBody('USER', `${body}x`).length).toBe(2001)
  })

  it('uses the same exact legacy recognition as context assembly', () => {
    expect(characterDocumentBody('SOUL', LEGACY_SOUL)).toBe(defaultSoul())
    expect(characterSection('SOUL', LEGACY_SOUL)).toBe(defaultSoul())
    const instructions =
      'This Space is for the Health life area. Keep goals as Surfaces inside this Space instead of creating narrower Spaces.'
    expect(characterDocumentBody('INSTRUCTIONS', instructions, 'Health')).toBe('')
    expect(characterDocumentBody('INSTRUCTIONS', instructions, 'Home')).toBe(instructions)
  })

  it('preserves custom SOUL and INSTRUCTIONS bytes and excludes only generated wrappers', () => {
    for (const title of ['SOUL', 'INSTRUCTIONS'] as const) {
      const custom = ` \n${'x'.repeat(2000)}\n `
      expect(characterDocumentBody(title, custom)).toBe(custom)
      expect(characterSection(title, custom)).toBe(`# ${title}\n\n${custom}`)
      expect(characterDocumentBody(title, `# ${title}\n\nCustom`)).toBe(`# ${title}\n\nCustom`)
    }
    expect(characterDocumentBody('SOUL', `${LEGACY_SOUL}custom`)).not.toBe(defaultSoul())
  })
})
