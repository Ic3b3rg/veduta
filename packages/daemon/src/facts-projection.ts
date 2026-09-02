import type { FactRecord, FactsDocument } from './facts.ts'
import { stripForbiddenUnicode } from './forbidden-unicode.ts'
import {
  isUntrusted,
  isValidOrigin,
  untrustedDataBlock,
  untrustedSource,
  type Origin,
} from './taint.ts'

const SUPERSEDED_RECORD_LIMIT = 20
const SUPERSEDED_TAIL_LIMIT = 2_000
const SUPERSEDED_PREFIX = '\n\nSuperseded:\n'

export interface FactsProjection {
  /** The full FACTS section as injected into context: active facts, then the superseded tail. */
  text: string
  /** The untrusted origins of exactly what `text` renders. */
  origins: Origin[]
  /** Rendered length of the ACTIVE portion only, in UTF-16 code units. */
  activeSize: number
}

/**
 * The single projection of a `FactsDocument` that both the context injected
 * into a turn (`SpacesEngine.assembleContext`) and the taint gating that turn
 * (`SpacesEngine.contextOrigins`) must read from, so the two can never drift
 * apart (issues/021-advanced-memory.md, issues/032-facts-hygiene-context-budget.md).
 * Before this function existed, `spaces-engine.ts` walked the document twice —
 * once to render FACTS, once to collect origins — and the two walks happened
 * to agree only because nobody had changed one without the other yet.
 *
 * Dormant records are excluded from all three fields: they are kept on disk
 * and still valid (`facts.ts`), but are not injected into context by
 * default, so they must render no text and contribute no origin here. A
 * dormant fact that is later retrieved on demand taints the turn through the
 * retrieving tool's own reported origins instead, not through this
 * projection.
 *
 * `origins` lists each untrusted origin once, in first-appearance order,
 * walking active records before the superseded records selected for the
 * bounded tail. A superseded record that renders still gates the turn; an
 * omitted one contributes its origin only if retrieval later surfaces it.
 *
 * `activeSize` is read off the same array of rendered active lines used to
 * build `text` — never by re-rendering or by searching `text` for the
 * "Superseded:" label — so it can never disagree with what `text` actually
 * contains. Its unit is UTF-16 code units (`string.length`), not a token
 * count: computing it is `O(projection length)`, with no tokenizer involved.
 * Active records are never truncated here. The superseded tail separately
 * considers the 20 most recent records and injects only complete renderings
 * that fit 2,000 UTF-16 code units, including its heading, wrappers, and
 * omission marker (issues/131-bounded-superseded-facts-tail.md).
 */
export function projectFacts(document: FactsDocument): FactsProjection {
  const origins: Origin[] = []
  const seenOrigins = new Set<Origin>()
  const recordOrigin = (fact: FactRecord): void => {
    const origin = projectionOrigin(fact.origin)
    if (origin && isUntrusted(origin) && !seenOrigins.has(origin)) {
      seenOrigins.add(origin)
      origins.push(origin)
    }
  }

  const active =
    document.active.length === 0
      ? ['No active facts noted.']
      : document.active.map((fact) => {
          recordOrigin(fact)
          return factLineWithOriginMark(fact, `noted: ${fact.noted ?? 'undated'}`)
        })
  const activeSize = active.join('\n').length

  const superseded = projectSupersededFacts(document.superseded)
  for (const fact of superseded.records) recordOrigin(fact)

  const text = `${active.join('\n')}${SUPERSEDED_PREFIX}${superseded.lines.join('\n')}`
  return { text, origins, activeSize }
}

interface SupersededProjection {
  lines: string[]
  records: FactRecord[]
}

function projectSupersededFacts(facts: FactRecord[]): SupersededProjection {
  if (facts.length === 0) return { lines: ['No superseded facts.'], records: [] }

  const candidates = facts
    .map((fact, index) => ({ fact, index }))
    .sort((left, right) => {
      const leftDate = stripForbiddenUnicode(left.fact.supersededAt ?? '')
      const rightDate = stripForbiddenUnicode(right.fact.supersededAt ?? '')
      if (leftDate !== rightDate) return leftDate > rightDate ? -1 : 1
      return left.index - right.index
    })
    .slice(0, SUPERSEDED_RECORD_LIMIT)

  const lines: string[] = []
  const records: FactRecord[] = []
  for (const { fact } of candidates) {
    const supersededAt = fact.supersededAt ? `; superseded: ${fact.supersededAt}` : ''
    const line = factLineWithOriginMark(fact, `noted: ${fact.noted ?? 'undated'}${supersededAt}`)
    const nextLines = [...lines, line]
    const omittedCount = facts.length - nextLines.length
    const completeLines =
      omittedCount === 0 ? nextLines : [...nextLines, supersededOmissionLine(omittedCount)]

    if (`${SUPERSEDED_PREFIX}${completeLines.join('\n')}`.length <= SUPERSEDED_TAIL_LIMIT) {
      lines.push(line)
      records.push(fact)
    }
  }

  const omittedCount = facts.length - records.length
  if (omittedCount > 0) lines.push(supersededOmissionLine(omittedCount))
  return { lines, records }
}

function supersededOmissionLine(count: number): string {
  const noun = count === 1 ? 'record' : 'records'
  return `- ${count} superseded ${noun} omitted; use search_memory for omitted history.`
}

/**
 * The one taint-aware rendering of a FACTS line, for anything that shows a
 * fact to the Agent — the injected projection above and `search_memory`'s
 * retrieved hits alike. Exported so a retrieval result cannot grow a second,
 * independently drifting delimiter scheme: a divergence here is a security
 * divergence, since it decides whether tainted text ever appears outside its
 * block (docs/SECURITY.md §3.2).
 */
export function factLineWithOriginMark(fact: FactRecord, metadata: string): string {
  const text = stripForbiddenUnicode(fact.text)
  const renderedMetadata = stripForbiddenUnicode(metadata)
  const origin = projectionOrigin(fact.origin)
  if (!origin || !isUntrusted(origin)) return `- ${text} (${renderedMetadata})`
  // Untrusted fact text lives only inside the delimited block; the plain
  // line carries content-free metadata so no tainted text ever renders
  // outside the delimiters (docs/SECURITY.md §3.2).
  const source = untrustedSource(origin) ?? 'external'
  const line = `- (untrusted fact from "${source}"; ${renderedMetadata}) [${origin}]`
  return `${line}\n${untrustedDataBlock(source, [['fact', text]])}`
}

function projectionOrigin(origin: Origin | undefined): Origin | undefined {
  if (origin === undefined) return undefined
  const sanitized = stripForbiddenUnicode(origin)
  // Persisted FACTS readers already validate origins. Keep this shared
  // renderer fail-closed too: a malformed in-memory origin must never make
  // its record appear trusted (docs/SECURITY.md §3.2).
  return isValidOrigin(sanitized) ? sanitized : 'untrusted:external'
}
