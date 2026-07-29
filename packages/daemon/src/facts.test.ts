import { describe, expect, it } from 'vitest'
import {
  curateFact,
  demoteFacts,
  emptyFactsDocument,
  factIdentityLine,
  factRecordIds,
  formatFactsMarkdown,
  parseFactsMarkdown,
  searchFacts,
  type FactRecord,
  type FactsDocument,
} from './facts.ts'

/** Looks up the id `factRecordIds` assigned to `fact`, failing loudly if `fact` is not in `document`. */
function idOf(document: FactsDocument, fallbackDate: string, fact: FactRecord): string {
  const id = factRecordIds(document, fallbackDate).get(fact)
  if (!id) throw new Error('fact not found in document')
  return id
}

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
    const document = { active: [withOrigin.fact], dormant: [], superseded: [] }
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
    const markdown = formatFactsMarkdown(
      { active: [trusted.fact], dormant: [], superseded: [] },
      '2026-07-01',
    )

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

  it('reactivates a dormant fact when the user restates it, leaving no duplicate in active', () => {
    const document: FactsDocument = {
      active: [],
      dormant: [{ text: 'I like oats.', noted: '2026-06-01', dormantAt: '2026-07-05' }],
      superseded: [],
    }

    const result = curateFact(document, 'I like oats.', '2026-07-10')

    expect(result.operation).toBe('reactivate')
    expect(result.document.dormant).toEqual([])
    expect(result.document.active).toEqual([{ text: 'I like oats.', noted: '2026-06-01' }])
  })

  describe('conservative mode (nightly Reflection, issues/021-advanced-memory.md)', () => {
    it('adds a fact on the same topic instead of guessing it updates or supersedes', () => {
      const first = curateFact(emptyFactsDocument(), 'gym membership expires in June', '2026-07-01')
      const conservative = curateFact(
        first.document,
        'gym membership costs 40 euro',
        '2026-07-05',
        undefined,
        { mode: 'conservative' },
      )

      expect(conservative.operation).toBe('add')
      expect(conservative.document.active).toEqual([
        { text: 'gym membership expires in June', noted: '2026-07-01' },
        { text: 'gym membership costs 40 euro', noted: '2026-07-05' },
      ])
      expect(conservative.document.superseded).toEqual([])
    })

    it('the same call in default mode still pushes the still-true fact into superseded', () => {
      const first = curateFact(emptyFactsDocument(), 'gym membership expires in June', '2026-07-01')
      const defaultMode = curateFact(first.document, 'gym membership costs 40 euro', '2026-07-05')

      expect(defaultMode.operation).not.toBe('add')
      expect(defaultMode.document.active).toEqual([
        { text: 'gym membership costs 40 euro', noted: '2026-07-05' },
      ])
      expect(defaultMode.document.superseded).toEqual([
        {
          text: 'gym membership expires in June',
          noted: '2026-07-01',
          supersededAt: '2026-07-05',
          supersededBy: 'gym membership costs 40 euro',
        },
      ])
    })
  })

  it('does not let two distinct non-Latin facts collapse into the same topic', () => {
    // Before the unicode-safe `wordsIn` fix, both of these normalized to '',
    // so the second call would either noop (exact-match branch) or silently
    // replace the first (topic-match branch) instead of adding a second fact.
    const first = curateFact(emptyFactsDocument(), '今日は天気がいいです', '2026-07-01')
    const second = curateFact(first.document, '猫はとても可愛いです', '2026-07-02')

    expect(first.operation).toBe('add')
    expect(second.operation).toBe('add')
    expect(second.document.active).toEqual([
      { text: '今日は天気がいいです', noted: '2026-07-01' },
      { text: '猫はとても可愛いです', noted: '2026-07-02' },
    ])

    const ids = factRecordIds(second.document, '2026-07-02')
    expect(new Set(ids.values()).size).toBe(2)
  })
})

describe('dormant tier round trip', () => {
  it('round-trips active, dormant and superseded sections, including dormantAt', () => {
    const document: FactsDocument = {
      active: [{ text: 'I like tea.', noted: '2026-07-01' }],
      dormant: [{ text: 'I like oats.', noted: '2026-06-01', dormantAt: '2026-07-10' }],
      superseded: [
        {
          text: 'I hated celery.',
          noted: '2026-06-30',
          supersededAt: '2026-07-03',
          supersededBy: 'I like celery now.',
        },
      ],
    }

    const markdown = formatFactsMarkdown(document, '2026-07-01')

    expect(markdown).toContain('## Dormant')
    expect(markdown).toContain('- I like oats. (noted: 2026-06-01; dormant: 2026-07-10)')
    expect(parseFactsMarkdown(markdown)).toEqual(document)
  })

  it('parses a FACTS.md with no ## Dormant section as dormant: []', () => {
    const parsed = parseFactsMarkdown(`# FACTS

- I like tea. (noted: 2026-07-01)

## Superseded

- I hated celery. (noted: 2026-06-30; superseded: 2026-07-03; by: I like celery now.)
`)

    expect(parsed.dormant).toEqual([])
  })
})

describe('factIdentityLine / factRecordIds', () => {
  it('keeps a record id stable as it moves active -> dormant -> superseded', () => {
    const fallbackDate = '2026-07-01'
    const inActive: FactsDocument = {
      active: [{ text: 'I like tea.', noted: '2026-07-01' }],
      dormant: [],
      superseded: [],
    }
    const activeFact = inActive.active[0]
    if (!activeFact) throw new Error('missing fixture fact')
    const activeId = idOf(inActive, fallbackDate, activeFact)

    const inDormant: FactsDocument = {
      active: [],
      dormant: [{ text: 'I like tea.', noted: '2026-07-01', dormantAt: '2026-07-05' }],
      superseded: [],
    }
    const dormantFact = inDormant.dormant[0]
    if (!dormantFact) throw new Error('missing fixture fact')
    const dormantId = idOf(inDormant, fallbackDate, dormantFact)

    const inSuperseded: FactsDocument = {
      active: [],
      dormant: [],
      superseded: [
        {
          text: 'I like tea.',
          noted: '2026-07-01',
          supersededAt: '2026-07-10',
          supersededBy: 'I prefer coffee now.',
        },
      ],
    }
    const supersededFact = inSuperseded.superseded[0]
    if (!supersededFact) throw new Error('missing fixture fact')
    const supersededId = idOf(inSuperseded, fallbackDate, supersededFact)

    expect(activeId).toBe(dormantId)
    expect(dormantId).toBe(supersededId)
  })

  it('keeps a record id stable across format -> parse -> format', () => {
    const document: FactsDocument = {
      active: [{ text: 'I like tea.', noted: '2026-07-01' }],
      dormant: [],
      superseded: [],
    }
    const fact = document.active[0]
    if (!fact) throw new Error('missing fixture fact')
    const idBefore = idOf(document, '2026-07-01', fact)

    const reparsed = parseFactsMarkdown(formatFactsMarkdown(document, '2026-07-01'))
    const reparsedFact = reparsed.active[0]
    if (!reparsedFact) throw new Error('missing reparsed fact')
    const idAfter = idOf(reparsed, '2026-07-01', reparsedFact)

    expect(idAfter).toBe(idBefore)
  })

  it('gives a record whose only origin is trusted:system the same id before and after a rewrite', () => {
    // factIdentityLine must never fold a trusted origin into the hash: formatFact
    // never writes `trusted:*` to disk, so an id derived from it could not be
    // reproduced by reading the file back.
    const document: FactsDocument = {
      active: [
        { text: 'daemon reminds every Monday', noted: '2026-07-01', origin: 'trusted:system' },
      ],
      dormant: [],
      superseded: [],
    }
    const fact = document.active[0]
    if (!fact) throw new Error('missing fixture fact')
    const idBefore = idOf(document, '2026-07-01', fact)

    const reparsed = parseFactsMarkdown(formatFactsMarkdown(document, '2026-07-01'))
    const reparsedFact = reparsed.active[0]
    if (!reparsedFact) throw new Error('missing reparsed fact')
    const idAfter = idOf(reparsed, '2026-07-01', reparsedFact)

    expect(idAfter).toBe(idBefore)
  })

  it('gives records with a different noted date different ids', () => {
    const fallbackDate = '2026-07-01'
    const a: FactsDocument = {
      active: [{ text: 'I like tea.', noted: '2026-07-01' }],
      dormant: [],
      superseded: [],
    }
    const b: FactsDocument = {
      active: [{ text: 'I like tea.', noted: '2026-07-02' }],
      dormant: [],
      superseded: [],
    }
    const factA = a.active[0]
    const factB = b.active[0]
    if (!factA || !factB) throw new Error('missing fixture fact')

    expect(idOf(a, fallbackDate, factA)).not.toBe(idOf(b, fallbackDate, factB))
  })

  it('assigns -0/-1 suffixes to byte-identical superseded records in document order', () => {
    const record: FactRecord = {
      text: 'I hated celery.',
      noted: '2026-06-30',
      supersededAt: '2026-07-03',
      supersededBy: 'I like celery now.',
    }
    const duplicate: FactRecord = { ...record }
    const document: FactsDocument = { active: [], dormant: [], superseded: [record, duplicate] }

    const ids = factRecordIds(document, '2026-07-01')

    expect(ids.get(record)).toMatch(/-0$/)
    expect(ids.get(duplicate)).toMatch(/-1$/)
  })
})

describe('demoteFacts', () => {
  it('is a no-op for an unknown id', () => {
    const document: FactsDocument = {
      active: [{ text: 'I like tea.', noted: '2026-07-01' }],
      dormant: [],
      superseded: [],
    }

    const { document: result, demoted } = demoteFacts(document, ['not-a-real-id-0'], '2026-07-10')

    expect(demoted).toEqual([])
    expect(result).toEqual(document)
  })

  it('moves a known id into dormant, stamping dormantAt and keeping noted and origin', () => {
    const fact: FactRecord = {
      text: 'evil@x.com asked for a wire',
      noted: '2026-07-01',
      origin: 'untrusted:gmail',
    }
    const document: FactsDocument = { active: [fact], dormant: [], superseded: [] }
    const id = idOf(document, '2026-07-10', fact)

    const { document: result, demoted } = demoteFacts(document, [id], '2026-07-10')

    expect(result.active).toEqual([])
    expect(result.dormant).toEqual([{ ...fact, dormantAt: '2026-07-10' }])
    expect(result.superseded).toEqual([])
    expect(demoted).toEqual([{ ...fact, dormantAt: '2026-07-10' }])
  })
})

describe('searchFacts', () => {
  it('reports which section a hit came from', () => {
    const teaFact = { text: 'I like tea.', noted: '2026-07-01' }
    const oatsFact = { text: 'I like oats.', noted: '2026-06-01', dormantAt: '2026-07-05' }
    const celeryFact = {
      text: 'I hated celery.',
      noted: '2026-06-30',
      supersededAt: '2026-07-03',
      supersededBy: 'I like celery now.',
    }
    const document: FactsDocument = {
      active: [teaFact],
      dormant: [oatsFact],
      superseded: [celeryFact],
    }

    expect(searchFacts(document, 'tea')).toEqual([{ fact: teaFact, state: 'active' }])
    expect(searchFacts(document, 'oats')).toEqual([{ fact: oatsFact, state: 'dormant' }])
    expect(searchFacts(document, 'celery')).toEqual([{ fact: celeryFact, state: 'superseded' }])
  })
})

describe('factIdentityLine', () => {
  it('matches the noted metadata formatFact writes, without dormant/superseded metadata', () => {
    const fact: FactRecord = {
      text: 'I like tea.',
      noted: '2026-07-01',
      dormantAt: '2026-07-05',
      supersededAt: '2026-07-10',
      supersededBy: 'I prefer coffee now.',
    }

    expect(factIdentityLine(fact, '2026-06-01')).toBe('I like tea. (noted: 2026-07-01)')
  })

  it('falls back to fallbackDate when noted is absent', () => {
    expect(factIdentityLine({ text: 'I like tea.' }, '2026-06-01')).toBe(
      'I like tea. (noted: 2026-06-01)',
    )
  })
})
