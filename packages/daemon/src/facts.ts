import { createHash } from 'node:crypto'
import { isUntrusted, isValidOrigin, type Origin } from './taint.ts'

export interface FactRecord {
  text: string
  noted?: string
  /** Set when the fact was moved out of `active` into `dormant` (issues/021-advanced-memory.md). */
  dormantAt?: string
  supersededAt?: string
  supersededBy?: string
  /** Absent means legacy/trusted. Set when the fact was curated from untrusted content. */
  origin?: Origin
}

/**
 * `dormant` is a third, non-destructive state (issues/021-advanced-memory.md):
 * a fact that is still valid and kept on disk, but no longer injected into
 * context by default, and retrievable on demand. Unlike `superseded`, a
 * dormant fact was not contradicted or replaced — it was demoted only to
 * keep the active set small.
 */
export interface FactsDocument {
  active: FactRecord[]
  dormant: FactRecord[]
  superseded: FactRecord[]
}

export type CuratorOperation = 'add' | 'update' | 'supersede' | 'noop' | 'reactivate'

export interface CuratorResult {
  operation: CuratorOperation
  document: FactsDocument
  fact: FactRecord
  previous?: FactRecord
}

const STOP_WORDS = new Set([
  'a',
  'about',
  'am',
  'an',
  'and',
  'are',
  'currently',
  'did',
  'do',
  'does',
  'don',
  'for',
  'has',
  'hate',
  'hated',
  'hates',
  'have',
  'i',
  'is',
  'like',
  'liked',
  'likes',
  'love',
  'loved',
  'loves',
  'my',
  'need',
  'now',
  'of',
  'on',
  'prefer',
  'prefers',
  'really',
  'the',
  'to',
  'very',
  'want',
  'was',
  'were',
])

const POSITIVE_WORDS = new Set(['like', 'liked', 'likes', 'love', 'loved', 'loves', 'prefer'])
const NEGATIVE_WORDS = new Set(['hate', 'hated', 'hates', 'dislike', 'disliked', 'avoid'])

export function emptyFactsDocument(): FactsDocument {
  return { active: [], dormant: [], superseded: [] }
}

export function parseFactsMarkdown(markdown: string): FactsDocument {
  const document = emptyFactsDocument()
  let section: keyof FactsDocument = 'active'

  for (const rawLine of markdown.split(/\r?\n/)) {
    const line = rawLine.trim()
    // A file with no `## Dormant` heading (every FACTS.md written before
    // issues/021-advanced-memory.md) simply parses with `dormant: []` — no
    // migration step needed.
    if (/^##\s+dormant\b/i.test(line)) {
      section = 'dormant'
      continue
    }
    if (/^##\s+superseded\b/i.test(line)) {
      section = 'superseded'
      continue
    }

    const bullet = line.match(/^[-*]\s+(.+)$/)
    if (!bullet?.[1]) continue
    document[section].push(parseFactLine(bullet[1]))
  }

  return document
}

export function formatFactsMarkdown(document: FactsDocument, fallbackDate: string): string {
  return [
    '# FACTS',
    '',
    ...formatSection(document.active, fallbackDate),
    '',
    '## Dormant',
    '',
    ...formatSection(document.dormant, fallbackDate),
    '',
    '## Superseded',
    '',
    ...formatSection(document.superseded, fallbackDate),
    '',
  ].join('\n')
}

/**
 * AUDN Curator (docs/adr/0006-file-based-memory.md): Add, Update, Supersede,
 * Noop — plus Reactivate for a fact restated while it is dormant.
 *
 * `options.mode: 'conservative'` (used by the nightly Reflection,
 * issues/021-advanced-memory.md) skips the topic-similarity branch entirely
 * and only ever noops, reactivates or adds. `topicKey` matches on the first
 * two non-stopwords, so in the default mode "gym membership costs 40 euro"
 * replaces an active "gym membership expires in June" and pushes a
 * still-true fact into `## Superseded` even though nothing here actually
 * contradicted it — a known defect of the default topic-similarity
 * heuristic, tracked separately and left unchanged by this function.
 * Reflection must never falsely supersede, so it opts into the conservative
 * mode instead of relying on that heuristic.
 */
export function curateFact(
  document: FactsDocument,
  factText: string,
  noted: string,
  origin?: Origin,
  options?: { mode?: 'default' | 'conservative' },
): CuratorResult {
  const text = normalizeWhitespace(factText)
  if (!text) throw new Error('fact text is required')

  const active = document.active.map((fact) => ({ ...fact }))
  const dormant = document.dormant.map((fact) => ({ ...fact }))
  const superseded = document.superseded.map((fact) => ({ ...fact }))
  const mode = options?.mode ?? 'default'

  // A fact restated while dormant is reactivated rather than added again,
  // in both modes: without this, the user restating a fact they already
  // told us (now sitting quietly in `dormant`) would create a duplicate
  // active record instead of resurfacing the one that already exists.
  const dormantIndex = dormant.findIndex(
    (candidate) => normalizeFactText(candidate.text) === normalizeFactText(text),
  )
  const dormantMatch = dormantIndex === -1 ? undefined : dormant[dormantIndex]
  if (dormantMatch) {
    const { dormantAt: _dormantAt, ...reactivated } = dormantMatch
    const nextDormant = [...dormant]
    nextDormant.splice(dormantIndex, 1)
    return {
      operation: 'reactivate',
      document: { active: [...active, reactivated], dormant: nextDormant, superseded },
      fact: reactivated,
    }
  }

  const fact: FactRecord = { text, noted, ...(origin === undefined ? {} : { origin }) }
  const exact = active.find(
    (candidate) => normalizeFactText(candidate.text) === normalizeFactText(text),
  )

  if (exact) {
    return { operation: 'noop', document: { active, dormant, superseded }, fact: exact }
  }

  if (mode === 'conservative') {
    return {
      operation: 'add',
      document: { active: [...active, fact], dormant, superseded },
      fact,
    }
  }

  const key = topicKey(text)
  const relatedIndex = key ? active.findIndex((candidate) => topicKey(candidate.text) === key) : -1

  if (relatedIndex === -1) {
    return {
      operation: 'add',
      document: { active: [...active, fact], dormant, superseded },
      fact,
    }
  }

  const previous = active[relatedIndex]
  if (!previous) {
    return {
      operation: 'add',
      document: { active: [...active, fact], dormant, superseded },
      fact,
    }
  }

  const operation = contradicts(previous.text, text) ? 'supersede' : 'update'
  const nextActive = [...active]
  nextActive.splice(relatedIndex, 1, fact)

  return {
    operation,
    document: {
      active: nextActive,
      dormant,
      superseded: [
        ...superseded,
        {
          ...previous,
          noted: previous.noted ?? noted,
          supersededAt: noted,
          supersededBy: text,
        },
      ],
    },
    fact,
    previous,
  }
}

export function searchFacts(
  document: FactsDocument,
  query: string,
): { fact: FactRecord; state: 'active' | 'dormant' | 'superseded' }[] {
  const needle = normalizeFactText(query)
  if (!needle) return []
  const sections: { state: 'active' | 'dormant' | 'superseded'; facts: FactRecord[] }[] = [
    { state: 'active', facts: document.active },
    { state: 'dormant', facts: document.dormant },
    { state: 'superseded', facts: document.superseded },
  ]
  return sections.flatMap(({ state, facts }) =>
    facts
      .filter((fact) => normalizeFactText(fact.text).includes(needle))
      .map((fact) => ({ fact, state })),
  )
}

/**
 * The record's persisted identity: the same text `formatFact` would write
 * to disk, but restricted to the fields that identify a record and survive
 * a state move (active → dormant → superseded) — the text, `noted ??
 * fallbackDate`, and the origin, and only when it is untrusted. `formatFact`
 * never writes a trusted origin to disk (see its final line below), so an
 * id computed from an in-memory `trusted:system` record would be
 * unreproducible from re-reading the very file it was written to.
 * `dormantAt`, `supersededAt` and `supersededBy` are deliberately excluded:
 * they change when a record moves between states, and an id must not.
 */
export function factIdentityLine(fact: FactRecord, fallbackDate: string): string {
  const base = `${fact.text} (noted: ${fact.noted ?? fallbackDate})`
  return fact.origin && isUntrusted(fact.origin) ? `${base} — origin: ${fact.origin}` : base
}

/**
 * Maps every record in `document` (active, then dormant, then superseded,
 * in that order) to a stable id: the first 16 hex characters of the sha256
 * of its `factIdentityLine`, suffixed `-<n>` where `n` counts earlier
 * records in the walk sharing that same hash. The suffix matters because
 * byte-identical records can legitimately coexist in `## Superseded` (the
 * same fact noted, and later superseded, more than once); without it they
 * would collide on one id. The memory index and whatever dereferences an id
 * back to a record (issues/021-advanced-memory.md) must both call this
 * function rather than recompute the hash themselves, so the two sides
 * cannot disagree about what an id means.
 */
export function factRecordIds(
  document: FactsDocument,
  fallbackDate: string,
): Map<FactRecord, string> {
  const ids = new Map<FactRecord, string>()
  const seen = new Map<string, number>()
  for (const fact of [...document.active, ...document.dormant, ...document.superseded]) {
    const hash = createHash('sha256')
      .update(factIdentityLine(fact, fallbackDate))
      .digest('hex')
      .slice(0, 16)
    const count = seen.get(hash) ?? 0
    seen.set(hash, count + 1)
    ids.set(fact, `${hash}-${count}`)
  }
  return ids
}

/**
 * Moves the active records whose id (per `factRecordIds`) is in `ids` into
 * `dormant`, stamping `dormantAt: date` and preserving every other field.
 * Unknown ids are ignored; `superseded` is never touched and nothing is
 * ever deleted — this is the nightly Reflection's non-destructive way of
 * bringing the active set back under budget without losing a fact that is
 * still true (issues/021-advanced-memory.md).
 */
export function demoteFacts(
  document: FactsDocument,
  ids: string[],
  date: string,
): { document: FactsDocument; demoted: FactRecord[] } {
  const idSet = new Set(ids)
  const recordIds = factRecordIds(document, date)
  const active: FactRecord[] = []
  const demoted: FactRecord[] = []

  for (const fact of document.active) {
    const id = recordIds.get(fact)
    if (id !== undefined && idSet.has(id)) {
      demoted.push({ ...fact, dormantAt: date })
    } else {
      active.push(fact)
    }
  }

  return {
    document: {
      active,
      dormant: [...document.dormant, ...demoted],
      superseded: document.superseded,
    },
    demoted,
  }
}

function parseFactLine(line: string): FactRecord {
  const originMatch = line.match(/^(.*)\s+—\s+origin:\s*(\S+)\s*$/)
  const withoutOrigin = originMatch?.[1] ?? line
  const origin = originMatch?.[2]

  const metadataMatch = withoutOrigin.match(/^(.*?)(?:\s+\(([^()]*)\))\s*$/)
  const text = normalizeWhitespace(metadataMatch?.[1] ?? withoutOrigin)
  const metadata = metadataMatch?.[2] ? parseMetadata(metadataMatch[2]) : {}

  return factRecord({
    text,
    ...(metadata['noted'] === undefined ? {} : { noted: metadata['noted'] }),
    ...(metadata['dormant'] === undefined ? {} : { dormantAt: metadata['dormant'] }),
    ...(metadata['superseded'] === undefined ? {} : { supersededAt: metadata['superseded'] }),
    ...(metadata['by'] === undefined ? {} : { supersededBy: metadata['by'] }),
    ...(origin !== undefined && isValidOrigin(origin) ? { origin } : {}),
  })
}

function parseMetadata(metadata: string): Record<string, string> {
  const parsed: Record<string, string> = {}
  for (const part of metadata.split(';')) {
    const separator = part.indexOf(':')
    if (separator === -1) continue
    const key = part.slice(0, separator).trim().toLowerCase()
    const value = part.slice(separator + 1).trim()
    if (key && value) parsed[key] = value
  }
  return parsed
}

function formatSection(facts: FactRecord[], fallbackDate: string): string[] {
  if (facts.length === 0) return ['_None yet._']
  return facts.map((fact) => formatFact(fact, fallbackDate))
}

function formatFact(fact: FactRecord, fallbackDate: string): string {
  const metadata = [`noted: ${fact.noted ?? fallbackDate}`]
  if (fact.dormantAt) metadata.push(`dormant: ${fact.dormantAt}`)
  if (fact.supersededAt) metadata.push(`superseded: ${fact.supersededAt}`)
  if (fact.supersededBy) metadata.push(`by: ${fact.supersededBy}`)
  const base = `- ${fact.text} (${metadata.join('; ')})`
  return fact.origin && isUntrusted(fact.origin) ? `${base} — origin: ${fact.origin}` : base
}

function factRecord(input: FactRecord): FactRecord {
  return {
    text: input.text,
    ...(input.noted === undefined ? {} : { noted: input.noted }),
    ...(input.dormantAt === undefined ? {} : { dormantAt: input.dormantAt }),
    ...(input.supersededAt === undefined ? {} : { supersededAt: input.supersededAt }),
    ...(input.supersededBy === undefined ? {} : { supersededBy: input.supersededBy }),
    ...(input.origin === undefined ? {} : { origin: input.origin }),
  }
}

function contradicts(previous: string, next: string): boolean {
  const previousPolarity = preferencePolarity(previous)
  const nextPolarity = preferencePolarity(next)
  return previousPolarity !== 0 && nextPolarity !== 0 && previousPolarity !== nextPolarity
}

function preferencePolarity(text: string): -1 | 0 | 1 {
  const words = wordsIn(text)
  if (words.some((word) => NEGATIVE_WORDS.has(word))) return -1
  if (words.some((word) => POSITIVE_WORDS.has(word))) return 1
  return 0
}

function topicKey(text: string): string {
  return wordsIn(text)
    .filter((word) => !STOP_WORDS.has(word))
    .slice(0, 2)
    .join(' ')
}

function normalizeFactText(text: string): string {
  return wordsIn(text).join(' ')
}

/**
 * Unicode-aware word extraction. `\p{L}`/`\p{N}` (with the `u` flag) match a
 * letter or digit in any script, not just ASCII. The previous `[a-z0-9]+`
 * regex matched nothing at all for text with no ASCII letters or digits —
 * Japanese, Greek, Cyrillic — so `normalizeFactText` and `topicKey` both
 * collapsed to `''` for every such fact: today they wrongly supersede each
 * other via the exact-match branch in `curateFact`, and under the
 * conservative mode added for the nightly Reflection (issues/021-advanced-memory.md)
 * they would instead wrongly noop each other — either way, a real fact is
 * lost. `normalize('NFC')` runs first so a combining-mark sequence and its
 * precomposed equivalent match identically. For ASCII input this produces
 * byte-identical output to the old regex.
 */
/**
 * Word runs for comparison and search: NFC-normalized, lowercased, split on
 * anything outside `\p{L}\p{N}`. Deliberately Unicode-aware rather than
 * `[a-z0-9]+`, which reduced every non-Latin text to the empty string — so
 * every Japanese or Greek fact shared one comparison key and superseded the
 * others. Exported because the retrieval layer tokenizes a query the same
 * way; the two apply different stop-word sets to the result, which is a
 * deliberate difference (see `memory-retrieval.ts`), but the tokenization
 * itself must not diverge or a fact would stop matching its own words.
 */
export function wordsIn(text: string): string[] {
  return (
    text
      .normalize('NFC')
      .toLowerCase()
      .match(/[\p{L}\p{N}]+/gu) ?? []
  )
}

function normalizeWhitespace(text: string): string {
  return text.trim().replace(/\s+/g, ' ')
}
