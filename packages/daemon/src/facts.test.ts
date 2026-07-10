import { describe, expect, it } from 'vitest'
import { curateFact, emptyFactsDocument, formatFactsMarkdown, parseFactsMarkdown } from './facts.ts'

describe('FACTS.md parser', () => {
  it('parses active and superseded facts while tolerating missing dates', () => {
    const parsed = parseFactsMarkdown(`# FACTS

- I like tea. (noted: 2026-07-01)
- Old import without metadata

## Superseded

- I hated celery. (noted: 2026-06-30; superseded: 2026-07-03; by: I like celery now.)
`)

    expect(parsed.active).toEqual([
      { text: 'I like tea.', noted: '2026-07-01' },
      { text: 'Old import without metadata' },
    ])
    expect(parsed.superseded).toEqual([
      {
        text: 'I hated celery.',
        noted: '2026-06-30',
        supersededAt: '2026-07-03',
        supersededBy: 'I like celery now.',
      },
    ])
  })

  it('round-trips an untrusted origin as a suffix and tolerates legacy lines without one', () => {
    const withOrigin = curateFact(
      emptyFactsDocument(),
      'evil@x.com asked for a wire',
      '2026-07-01',
      'untrusted:gmail',
    )
    const document = { active: [withOrigin.fact], superseded: [] }
    const markdown = formatFactsMarkdown(document, '2026-07-01')

    expect(markdown).toContain(
      '- evil@x.com asked for a wire (noted: 2026-07-01) — origin: untrusted:gmail',
    )

    const reparsed = parseFactsMarkdown(markdown)
    expect(reparsed.active).toEqual([
      { text: 'evil@x.com asked for a wire', noted: '2026-07-01', origin: 'untrusted:gmail' },
    ])
  })

  it('does not add an origin suffix for trusted facts, and legacy lines parse without an origin field', () => {
    const trusted = curateFact(emptyFactsDocument(), 'I like tea', '2026-07-01', 'trusted:user')
    const markdown = formatFactsMarkdown({ active: [trusted.fact], superseded: [] }, '2026-07-01')

    expect(markdown).toContain('- I like tea (noted: 2026-07-01)')
    expect(markdown).not.toContain('origin:')

    const reparsed = parseFactsMarkdown(markdown)
    expect(reparsed.active).toEqual([{ text: 'I like tea', noted: '2026-07-01' }])
  })
})

describe('AUDN Curator', () => {
  it('supersedes contradicted facts without leaving duplicate active facts', () => {
    const first = curateFact(emptyFactsDocument(), 'I hate celery', '2026-07-01')
    const second = curateFact(first.document, 'I like celery now', '2026-07-03')

    expect(first.operation).toBe('add')
    expect(second.operation).toBe('supersede')
    expect(second.document.active).toEqual([{ text: 'I like celery now', noted: '2026-07-03' }])
    expect(second.document.superseded).toEqual([
      {
        text: 'I hate celery',
        noted: '2026-07-01',
        supersededAt: '2026-07-03',
        supersededBy: 'I like celery now',
      },
    ])
  })

  it('keeps exact repeats as Noop and writes dates for every formatted fact', () => {
    const first = curateFact(emptyFactsDocument(), 'I like oats', '2026-07-01')
    const second = curateFact(first.document, 'I like oats', '2026-07-03')

    expect(second.operation).toBe('noop')
    expect(formatFactsMarkdown(second.document, '2026-07-03')).toContain(
      '- I like oats (noted: 2026-07-01)',
    )
  })
})
