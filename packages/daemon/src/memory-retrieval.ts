import { wordsIn, type FactRecord } from './facts.ts'
import { factLineWithOriginMark } from './facts-projection.ts'
import type { MemoryConfig } from './memory-config.ts'
import {
  type DereferenceResult,
  type MemoryIndex,
  type MemoryIndexRow,
  type MemoryOrder,
  type MemoryRecordKind,
  type MemoryTimeBasis,
} from './memory-index.ts'
import { renderEventForContext, type SpaceEvent, type SpacesEngine } from './spaces-engine.ts'
import { extractTemporalRange } from './temporal-query.ts'
import type { Origin } from './taint.ts'

/**
 * The dedicated retrieval interface issues/021-advanced-memory.md asks for:
 * `MemoryIndex` owns storage (FTS5, source references, dereferencing), this
 * module owns turning a natural-language query into what `MemoryIndex.search`
 * needs and turning its rows back into answer-bearing records. Splitting the
 * two keeps `MemoryIndex` a mechanical index over files and puts query
 * parsing — the part that changes as retrieval gets smarter — in one place.
 *
 * The parsing order below is LongMemEval's time-aware query expansion
 * (docs/references/06-memory-research.md): extracting a query's temporal
 * range and applying it as a date filter *before* keyword search is that
 * literature's highest-measured-gain technique, well ahead of leaning on the
 * search engine to notice "start of June" sitting in the query text.
 *
 * This is also the seam an optional embedding layer (issues/021-advanced-memory.md
 * keeps it off by default) would extend: `search` would gain a second
 * candidate source — a vector index consulted alongside `MemoryIndex.search`
 * and merged into the same dereference-then-render pipeline — with no change
 * to `MemoryQuery`, `MemoryHit`, or any caller. No embedding layer is
 * implemented here.
 */

export interface MemoryRetrievalOptions {
  index: MemoryIndex
  spacesEngine: SpacesEngine
  config: MemoryConfig
  now?: () => Date
}

export interface MemoryQuery {
  spaceId: string
  query: string
  kind?: MemoryRecordKind
  /** Explicit range; when absent the range is extracted from `query`. */
  from?: string
  to?: string
  timeBasis?: MemoryTimeBasis
  order?: MemoryOrder
  limit?: number
}

export interface MemoryHit {
  sourceRef: string
  kind: MemoryRecordKind
  recordedAt: string
  occurredAt?: string
  score: number
  /** The record's own origins — never the query's. */
  origins: Origin[]
  record:
    | { type: 'event'; event: SpaceEvent }
    | { type: 'fact'; fact: FactRecord; state: 'active' | 'dormant' | 'superseded' }
}

export interface MemorySearchOutcome {
  hits: MemoryHit[]
  /** Source refs that could not be dereferenced even after a reconcile. */
  unresolved: string[]
  /** The range actually applied, when one was extracted or supplied. */
  range?: { from: string; to: string }
}

/**
 * Query stopwords for `MemoryRetrieval.search`. Deliberately a separate set
 * from `facts.ts`'s `STOP_WORDS`: that one is tuned to pick two
 * topic-defining words out of a stated fact for the Curator's `topicKey`
 * heuristic, so it drops words a *search query* legitimately needs matched —
 * "like", "want", "prefer" are exactly the words a user's own question
 * ("what do I like") needs kept. This set instead trims only generic
 * question scaffolding that natural-language memory queries are full of and
 * that indexed records essentially never contain verbatim.
 */
const QUERY_STOP_WORDS = new Set([
  'a',
  'am',
  'an',
  'and',
  'are',
  'at',
  'did',
  'do',
  'does',
  'for',
  'how',
  'i',
  'in',
  'is',
  'it',
  'me',
  'much',
  'my',
  'of',
  'on',
  'that',
  'the',
  'to',
  'was',
  'were',
  'what',
  'when',
  'which',
  'who',
  'you',
  'your',
])

interface ResolvedRange {
  termQueryText: string
  from?: string
  to?: string
  appliedRange?: { from: string; to: string }
}

export class MemoryRetrieval {
  private readonly index: MemoryIndex
  private readonly spacesEngine: SpacesEngine
  private readonly config: MemoryConfig
  private readonly now: () => Date

  constructor(options: MemoryRetrievalOptions) {
    this.index = options.index
    this.spacesEngine = options.spacesEngine
    this.config = options.config
    this.now = options.now ?? (() => new Date())
  }

  search(query: MemoryQuery): MemorySearchOutcome {
    // A query against a Space that no longer exists (archived and removed,
    // never created) can never legitimately return anything: fail soft here
    // rather than let `MemoryIndex.search` run and `dereference` report every
    // row `missing` one at a time.
    if (this.spacesEngine.getSpace(query.spaceId) === undefined) {
      return { hits: [], unresolved: [] }
    }

    const resolved = this.resolveRange(query)
    const terms = tokenize(resolved.termQueryText)
    const rangeField = resolved.appliedRange === undefined ? {} : { range: resolved.appliedRange }

    if (terms.length === 0) {
      return { hits: [], unresolved: [], ...rangeField }
    }

    const params = {
      spaceId: query.spaceId,
      terms,
      ...(query.kind === undefined ? {} : { kind: query.kind }),
      ...(resolved.from === undefined ? {} : { from: resolved.from }),
      ...(resolved.to === undefined ? {} : { to: resolved.to }),
      timeBasis: query.timeBasis ?? 'effective',
      order: query.order ?? 'relevance',
      ...(query.limit === undefined ? {} : { limit: query.limit }),
    }

    const first = this.dereferenceAll(this.index.search(params))
    if (first.unresolved.length === 0) {
      return { hits: first.hits, unresolved: first.unresolved, ...rangeField }
    }

    // Something the index pointed at no longer matches what was indexed.
    // Reconcile once, then **re-run the query** rather than re-dereferencing
    // the rows the stale index produced: a repaired line may no longer match
    // these terms at all, and answering with it would hand back a record the
    // query never selected. Re-running also refreshes the scores and the
    // ordering, which the first pass computed from stale rows.
    this.index.reconcile()
    const second = this.dereferenceAll(this.index.search(params))
    return { hits: second.hits, unresolved: second.unresolved, ...rangeField }
  }

  /** Renders an outcome for a tool result / the Agent's context, taint-aware. */
  renderOutcome(outcome: MemorySearchOutcome): string {
    const lines: string[] = []
    if (outcome.range) {
      lines.push(`Time range applied: ${outcome.range.from} to ${outcome.range.to}`)
    }
    if (outcome.hits.length === 0) {
      // A clear, unambiguous line rather than silence: the Agent's
      // abstention rule ("say you don't know and do not invent it",
      // spaces-engine.ts's ABSTENTION_RULE) only fires reliably when the
      // absence of a match is itself visible in the rendered context.
      lines.push('No matching memory found for this query.')
    } else {
      for (const hit of outcome.hits) lines.push(renderHit(hit))
    }
    if (outcome.unresolved.length > 0) {
      lines.push(
        `${outcome.unresolved.length} reference(s) could not be resolved: ${outcome.unresolved.join(', ')}`,
      )
    }
    return lines.join('\n')
  }

  /**
   * Explicit `from`/`to` win outright and are never stripped from the query
   * text (they did not come from the text, so there is nothing in it to
   * strip). Otherwise `extractTemporalRange` (temporal-query.ts) is tried,
   * and its matched substring is removed from the query text before
   * tokenizing: the words "start of June" must not have to appear in a
   * record for that record to match, which is the entire point of
   * extracting the range first rather than leaving it for keyword search to
   * stumble onto.
   */
  private resolveRange(query: MemoryQuery): ResolvedRange {
    if (query.from !== undefined || query.to !== undefined) {
      return {
        termQueryText: query.query,
        ...(query.from === undefined ? {} : { from: query.from }),
        ...(query.to === undefined ? {} : { to: query.to }),
        ...(query.from !== undefined && query.to !== undefined
          ? { appliedRange: { from: query.from, to: query.to } }
          : {}),
      }
    }

    const extracted = extractTemporalRange(query.query, {
      timezone: this.config.timezone,
      now: this.now(),
    })
    if (extracted === undefined) return { termQueryText: query.query }

    return {
      termQueryText: stripMatchedSpan(query.query, extracted.matched),
      from: extracted.from,
      to: extracted.to,
      appliedRange: { from: extracted.from, to: extracted.to },
    }
  }

  /**
   * Dereferences every row and, since `MemoryHit.record` is required, treats
   * a row whose dereference fails as not a hit at all rather than as a
   * flagged placeholder: the retrieval contract promises every hit carries
   * the original record plus its origins, and a record-less entry could not
   * honor that — it would also shift every later hit's position, silently
   * perturbing an order the caller (and, for `recency`, a re-run of the same
   * query after a rebuild) is entitled to rely on. A row that fails to
   * dereference goes to `unresolved` and is excluded from `hits`; the rows that
   * did resolve keep their relative order. Repair is the caller's job (see
   * `search`), which reconciles **once** for the whole search and re-runs the
   * query — never one reconcile per failing row, which would turn a single
   * stale index into a reconcile storm.
   */
  private dereferenceAll(rows: MemoryIndexRow[]): { hits: MemoryHit[]; unresolved: string[] } {
    const results = new Map<string, DereferenceResult>()
    const pending: MemoryIndexRow[] = []

    for (const row of rows) {
      const result = this.index.dereference(row.sourceRef)
      results.set(row.sourceRef, result)
      if (!result.ok) pending.push(row)
    }

    const hits: MemoryHit[] = []
    const unresolved: string[] = []
    for (const row of rows) {
      const result = results.get(row.sourceRef)
      if (result === undefined || !result.ok) {
        unresolved.push(row.sourceRef)
        continue
      }
      hits.push(toHit(row, result))
    }

    return { hits, unresolved }
  }
}

/**
 * Removes the first case-insensitive occurrence of `matched` from `text`,
 * replacing it with a single space rather than deleting it outright: gluing
 * the surrounding words together ("weigh in June morning" losing "in June"
 * outright would become "weigh morning" but a careless deletion could just
 * as easily fuse two words into a new, meaningless token). `matched` comes
 * from `extractTemporalRange` already lowercased; the comparison is
 * case-insensitive but the untouched parts of `text` keep their original
 * casing (tokenizing lowercases everything next anyway).
 */
function stripMatchedSpan(text: string, matched: string): string {
  const index = text.toLowerCase().indexOf(matched)
  if (index === -1) return text
  return `${text.slice(0, index)} ${text.slice(index + matched.length)}`
}

/**
 * Lowercase `[\p{L}\p{N}]+` runs (Unicode-safe, the same rule `facts.ts`'s
 * `wordsIn` uses), then drops `QUERY_STOP_WORDS`, deduplicating while
 * preserving first-occurrence order. Restricting terms to letter/digit runs
 * is itself what neutralizes FTS5 query syntax in the *query* text (a stray
 * `"`, `*`, `-`, or `NEAR(` is simply not part of any run and disappears
 * here) — `MemoryIndex.search` still quotes every term defensively before
 * it ever reaches SQLite, so nothing downstream has to trust that this
 * function was the only line of defense.
 */
function tokenize(text: string): string[] {
  // Same word-run rule the Curator compares facts with (`wordsIn` in
  // `facts.ts`); only the stop-word set below differs, deliberately.
  const words = wordsIn(text)
  const seen = new Set<string>()
  const terms: string[] = []
  for (const word of words) {
    if (QUERY_STOP_WORDS.has(word)) continue
    if (seen.has(word)) continue
    seen.add(word)
    terms.push(word)
  }
  return terms
}

function toHit(row: MemoryIndexRow, result: Extract<DereferenceResult, { ok: true }>): MemoryHit {
  const base = {
    sourceRef: row.sourceRef,
    kind: row.kind,
    recordedAt: row.recordedAt,
    score: row.score,
    ...(row.occurredAt === undefined ? {} : { occurredAt: row.occurredAt }),
  }
  if (result.kind === 'event') {
    return {
      ...base,
      origins: [result.event.origin],
      record: { type: 'event', event: result.event },
    }
  }
  return {
    ...base,
    // The record's own origin, never the row's stored `origin` column: a
    // trusted fact is indexed with `origin: 'trusted:system'` as a storage
    // fallback (`memory-index.ts`'s `indexSpaceFacts`), but `FactRecord.origin`
    // itself is absent for a trusted fact, and this hit must report that
    // absence rather than manufacture an origin the record never carried.
    origins: result.fact.origin === undefined ? [] : [result.fact.origin],
    record: { type: 'fact', fact: result.fact, state: result.state },
  }
}

function renderHit(hit: MemoryHit): string {
  const metadata = [
    `ref: ${hit.sourceRef}`,
    `recorded: ${hit.recordedAt}`,
    ...(hit.occurredAt === undefined ? [] : [`occurred: ${hit.occurredAt}`]),
    `score: ${hit.score.toFixed(3)}`,
    ...(hit.record.type === 'fact' ? [`state: ${hit.record.state}`] : []),
  ].join('; ')
  const body =
    hit.record.type === 'event'
      ? renderEventForContext(hit.record.event)
      : factLineWithOriginMark(hit.record.fact, `noted: ${hit.record.fact.noted ?? 'undated'}`)
  return `- (${metadata})\n${body}`
}
