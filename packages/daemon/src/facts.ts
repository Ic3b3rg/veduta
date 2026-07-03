export interface FactRecord {
  text: string
  noted?: string
  supersededAt?: string
  supersededBy?: string
}

export interface FactsDocument {
  active: FactRecord[]
  superseded: FactRecord[]
}

export type CuratorOperation = 'add' | 'update' | 'supersede' | 'noop'

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
  return { active: [], superseded: [] }
}

export function parseFactsMarkdown(markdown: string): FactsDocument {
  const document = emptyFactsDocument()
  let section: keyof FactsDocument = 'active'

  for (const rawLine of markdown.split(/\r?\n/)) {
    const line = rawLine.trim()
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
    '## Superseded',
    '',
    ...formatSection(document.superseded, fallbackDate),
    '',
  ].join('\n')
}

export function curateFact(
  document: FactsDocument,
  factText: string,
  noted: string,
): CuratorResult {
  const text = normalizeWhitespace(factText)
  if (!text) throw new Error('fact text is required')

  const active = document.active.map((fact) => ({ ...fact }))
  const superseded = document.superseded.map((fact) => ({ ...fact }))
  const fact = { text, noted }
  const exact = active.find(
    (candidate) => normalizeFactText(candidate.text) === normalizeFactText(text),
  )

  if (exact) {
    return { operation: 'noop', document: { active, superseded }, fact: exact }
  }

  const key = topicKey(text)
  const relatedIndex = key ? active.findIndex((candidate) => topicKey(candidate.text) === key) : -1

  if (relatedIndex === -1) {
    return {
      operation: 'add',
      document: { active: [...active, fact], superseded },
      fact,
    }
  }

  const previous = active[relatedIndex]
  if (!previous) {
    return {
      operation: 'add',
      document: { active: [...active, fact], superseded },
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

export function searchFacts(document: FactsDocument, query: string): FactRecord[] {
  const needle = normalizeFactText(query)
  if (!needle) return []
  return [...document.active, ...document.superseded].filter((fact) =>
    normalizeFactText(fact.text).includes(needle),
  )
}

function parseFactLine(line: string): FactRecord {
  const metadataMatch = line.match(/^(.*?)(?:\s+\(([^()]*)\))\s*$/)
  const text = normalizeWhitespace(metadataMatch?.[1] ?? line)
  const metadata = metadataMatch?.[2] ? parseMetadata(metadataMatch[2]) : {}

  return factRecord({
    text,
    ...(metadata['noted'] === undefined ? {} : { noted: metadata['noted'] }),
    ...(metadata['superseded'] === undefined ? {} : { supersededAt: metadata['superseded'] }),
    ...(metadata['by'] === undefined ? {} : { supersededBy: metadata['by'] }),
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
  if (fact.supersededAt) metadata.push(`superseded: ${fact.supersededAt}`)
  if (fact.supersededBy) metadata.push(`by: ${fact.supersededBy}`)
  return `- ${fact.text} (${metadata.join('; ')})`
}

function factRecord(input: FactRecord): FactRecord {
  return {
    text: input.text,
    ...(input.noted === undefined ? {} : { noted: input.noted }),
    ...(input.supersededAt === undefined ? {} : { supersededAt: input.supersededAt }),
    ...(input.supersededBy === undefined ? {} : { supersededBy: input.supersededBy }),
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

function wordsIn(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+/g) ?? []
}

function normalizeWhitespace(text: string): string {
  return text.trim().replace(/\s+/g, ' ')
}
