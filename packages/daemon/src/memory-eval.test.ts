import { existsSync, mkdtempSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { performance } from 'node:perf_hooks'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import {
  CORPUS_ABSENT_TOPICS,
  CORPUS_END_OF_MAY_DATES,
  CORPUS_END_OF_MAY_WEIGHT_KG,
  CORPUS_EVENT_COUNT,
  CORPUS_LOG_BYTES,
  CORPUS_NOW,
  CORPUS_READER_SUMMARY_SEARCH_TERM,
  CORPUS_SHOULDER_EVENT,
  CORPUS_START_OF_JUNE_DATES,
  CORPUS_START_OF_JUNE_DATES_KIRITIMATI,
  CORPUS_START_OF_JUNE_DATES_NIUE,
  CORPUS_START_OF_JUNE_WEIGHT_KG,
  CORPUS_MAY31_WEIGHT_KG,
  CORPUS_JUNE7_WEIGHT_KG,
  CORPUS_JUNE8_WEIGHT_KG,
  CORPUS_TARGET_WEIGHT_NEWER,
  CORPUS_TARGET_WEIGHT_OLDER,
  CORPUS_TIMEZONE,
  seedMemoryCorpus,
} from './memory-corpus.ts'
import { MemoryConfigSchema, type MemoryConfig } from './memory-config.ts'
import { formatSourceRef, MemoryIndex } from './memory-index.ts'
import { MemoryRetrieval } from './memory-retrieval.ts'
import { requiredString } from './sqlite-rows.ts'
import { SpacesEngine } from './spaces-engine.ts'

/**
 * Evaluation mini-suite for issue #21 (issues/021-advanced-memory.md's
 * "Evaluation" task): LongMemEval-inspired temporal/update/abstention
 * categories (docs/references/06-memory-research.md), run against the
 * pinned `memory-corpus.ts` fixture with `CORPUS_NOW` as the fixed clock.
 * Every assertion below measures hit ids (`sourceRef`) and order, or a
 * record's own fields — never generated prose.
 */

const now = () => new Date(CORPUS_NOW)

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'veduta-memory-eval-'))
}

function memoryDbPath(rootDir: string): string {
  return join(rootDir, 'memory.sqlite')
}

/** Always call after `index.close()`: an open connection keeps using an unlinked file on Unix. */
function deleteMemorySqlite(rootDir: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    const path = `${memoryDbPath(rootDir)}${suffix}`
    if (existsSync(path)) unlinkSync(path)
  }
}

function config(timezone: string): MemoryConfig {
  return MemoryConfigSchema.parse({ timezone })
}

interface Corpus {
  rootDir: string
  engine: SpacesEngine
  index: MemoryIndex
  retrieval: MemoryRetrieval
  spaceId: string
}

function buildCorpus(): Corpus {
  const rootDir = tempRoot()
  const engine = new SpacesEngine({ rootDir, now })
  const { spaceId } = seedMemoryCorpus(engine)
  const index = new MemoryIndex({ rootDir, spacesEngine: engine, now })
  index.reconcile() // Everything above was written before this index existed.
  const retrieval = new MemoryRetrieval({
    index,
    spacesEngine: engine,
    config: config(CORPUS_TIMEZONE),
    now,
  })
  return { rootDir, engine, index, retrieval, spaceId }
}

/** The pinned source references for a Space's daily weight-log days: each of the 15 protected calendar days (see memory-corpus.ts) holds exactly one event, at line 1. */
function dailyWeightRefs(spaceId: string, dates: readonly string[]): string[] {
  return dates.map((date) =>
    formatSourceRef({ kind: 'event', spaceId, file: `${date}.jsonl`, line: 1 }),
  )
}

describe('memory-eval: fixture integrity', () => {
  it('seeds exactly CORPUS_EVENT_COUNT events and CORPUS_LOG_BYTES of log bytes', () => {
    const rootDir = tempRoot()
    const engine = new SpacesEngine({ rootDir, now })
    const { spaceId, events } = seedMemoryCorpus(engine)

    expect(events).toBe(CORPUS_EVENT_COUNT)
    expect(engine.readRecent(spaceId, 100_000)).toHaveLength(CORPUS_EVENT_COUNT)

    const totalBytes = engine.listLogFiles(spaceId).reduce((sum, file) => sum + file.bytes, 0)
    expect(totalBytes).toBe(CORPUS_LOG_BYTES)
  })
})

describe('memory-eval: temporal (issues/021-advanced-memory.md acceptance criterion 1)', () => {
  it('"start of June" returns exactly the June 1-7 records, pinned and in order, with the right weight and not the end-of-May one', () => {
    const { retrieval, spaceId } = buildCorpus()

    const outcome = retrieval.search({
      spaceId,
      query: 'How much did I weigh at the start of June?',
      order: 'recency',
    })

    expect(outcome.hits.map((hit) => hit.sourceRef)).toEqual(
      dailyWeightRefs(spaceId, [...CORPUS_START_OF_JUNE_DATES].reverse()),
    )

    const texts = outcome.hits.map((hit) =>
      hit.record.type === 'event' ? hit.record.event.text : '',
    )
    const joined = texts.join('\n')
    expect(joined).toContain(CORPUS_START_OF_JUNE_WEIGHT_KG)
    expect(joined).not.toContain(CORPUS_MAY31_WEIGHT_KG)
  })

  it('"end of May" returns exactly the May 25-31 records, pinned and in order, with the right weight and not the start-of-June one', () => {
    const { retrieval, spaceId } = buildCorpus()

    const outcome = retrieval.search({
      spaceId,
      query: 'How much did I weigh at the end of May?',
      order: 'recency',
    })

    expect(outcome.hits.map((hit) => hit.sourceRef)).toEqual(
      dailyWeightRefs(spaceId, [...CORPUS_END_OF_MAY_DATES].reverse()),
    )

    const texts = outcome.hits.map((hit) =>
      hit.record.type === 'event' ? hit.record.event.text : '',
    )
    const joined = texts.join('\n')
    expect(joined).toContain(CORPUS_END_OF_MAY_WEIGHT_KG)
    expect(joined).not.toContain(CORPUS_START_OF_JUNE_WEIGHT_KG)
  })
})

describe('memory-eval: timezone (issues/021-advanced-memory.md acceptance criterion 1, "correct across the user timezone")', () => {
  it('shifts the start-of-June window one day earlier in Pacific/Kiritimati (UTC+14): drops June 7, gains May 31', () => {
    const { index, engine, spaceId } = buildCorpus()
    const retrieval = new MemoryRetrieval({
      index,
      spacesEngine: engine,
      config: config('Pacific/Kiritimati'),
      now,
    })

    const outcome = retrieval.search({
      spaceId,
      query: 'How much did I weigh at the start of June?',
      order: 'recency',
    })

    expect(outcome.hits.map((hit) => hit.sourceRef)).toEqual(
      dailyWeightRefs(spaceId, [...CORPUS_START_OF_JUNE_DATES_KIRITIMATI].reverse()),
    )
    // A higher (more easterly) UTC offset moves "local midnight" to an
    // earlier UTC instant, so the whole 7-day window slides one day earlier
    // than the Europe/Rome baseline: the last day of the baseline window
    // (June 7) falls out, and the day before its first day (May 31) falls in.
    const texts = outcome.hits.map((hit) =>
      hit.record.type === 'event' ? hit.record.event.text : '',
    )
    const joined = texts.join('\n')
    expect(joined).toContain(CORPUS_MAY31_WEIGHT_KG)
    expect(joined).not.toContain(CORPUS_JUNE7_WEIGHT_KG)
  })

  it('shifts the start-of-June window one day later in Pacific/Niue (UTC-11): drops June 1, gains June 8', () => {
    const { index, engine, spaceId } = buildCorpus()
    const retrieval = new MemoryRetrieval({
      index,
      spacesEngine: engine,
      config: config('Pacific/Niue'),
      now,
    })

    const outcome = retrieval.search({
      spaceId,
      query: 'How much did I weigh at the start of June?',
      order: 'recency',
    })

    expect(outcome.hits.map((hit) => hit.sourceRef)).toEqual(
      dailyWeightRefs(spaceId, [...CORPUS_START_OF_JUNE_DATES_NIUE].reverse()),
    )
    // A lower (more westerly) UTC offset moves "local midnight" to a later
    // UTC instant, so the whole window slides one day later than the
    // Europe/Rome baseline: the first day of the baseline window (June 1)
    // falls out, and the day after its last day (June 8) falls in — the
    // opposite direction from the Pacific/Kiritimati case above.
    const texts = outcome.hits.map((hit) =>
      hit.record.type === 'event' ? hit.record.event.text : '',
    )
    const joined = texts.join('\n')
    expect(joined).toContain(CORPUS_JUNE8_WEIGHT_KG)
    expect(joined).not.toContain(CORPUS_START_OF_JUNE_WEIGHT_KG)
  })
})

describe('memory-eval: update (knowledge-update category)', () => {
  it('"what is my current target weight?" with recency order puts the newer statement first, in full order', () => {
    const { retrieval, spaceId } = buildCorpus()

    const outcome = retrieval.search({
      spaceId,
      query: 'what is my current target weight?',
      order: 'recency',
    })

    expect(
      outcome.hits.map((hit) => (hit.record.type === 'event' ? hit.record.event.text : '')),
    ).toEqual([CORPUS_TARGET_WEIGHT_NEWER.text, CORPUS_TARGET_WEIGHT_OLDER.text])
    expect(outcome.hits.map((hit) => hit.recordedAt)).toEqual([
      CORPUS_TARGET_WEIGHT_NEWER.at,
      CORPUS_TARGET_WEIGHT_OLDER.at,
    ])
  })
})

describe('memory-eval: abstention (issues/021-advanced-memory.md; spaces-engine.ts ABSTENTION_RULE)', () => {
  for (const topic of CORPUS_ABSENT_TOPICS) {
    it(`finds nothing for the absent topic "${topic}", distinct from a broken search`, () => {
      const { retrieval, spaceId } = buildCorpus()

      const outcome = retrieval.search({ spaceId, query: topic })

      expect(outcome.hits).toEqual([])
      expect(outcome.unresolved).toEqual([])
    })
  }
})

describe('memory-eval: effective vs recorded time', () => {
  it('matches the recorded-late event by occurredAt under effective basis and by at under recorded basis', () => {
    const { index, spaceId } = buildCorpus()

    const occurredRange = { from: '2026-04-01T00:00:00.000Z', to: '2026-04-10T00:00:00.000Z' }
    const recordedRange = { from: '2026-04-20T00:00:00.000Z', to: '2026-04-30T00:00:00.000Z' }

    expect(
      index.search({ spaceId, terms: ['shoulder'], timeBasis: 'effective', ...occurredRange }),
    ).toHaveLength(1)
    expect(
      index.search({ spaceId, terms: ['shoulder'], timeBasis: 'effective', ...recordedRange }),
    ).toEqual([])

    expect(
      index.search({ spaceId, terms: ['shoulder'], timeBasis: 'recorded', ...recordedRange }),
    ).toHaveLength(1)
    expect(
      index.search({ spaceId, terms: ['shoulder'], timeBasis: 'recorded', ...occurredRange }),
    ).toEqual([])

    const hit = index.search({
      spaceId,
      terms: ['shoulder'],
      timeBasis: 'effective',
      ...occurredRange,
    })[0]
    expect(hit?.occurredAt).toBe(CORPUS_SHOULDER_EVENT.occurredAt)
    expect(hit?.recordedAt).toBe(CORPUS_SHOULDER_EVENT.at)
  })
})

describe('memory-eval: fact augmentation', () => {
  it('finds the reader.summary event by its distinctive entity and dereferences to the original event', () => {
    const { retrieval, index, spaceId } = buildCorpus()

    const outcome = retrieval.search({ spaceId, query: CORPUS_READER_SUMMARY_SEARCH_TERM })
    expect(outcome.hits).toHaveLength(1)
    const hit = outcome.hits[0]
    expect(hit?.record.type).toBe('event')
    if (hit?.record.type === 'event') {
      expect(hit.record.event.type).toBe('reader.summary')
      expect(hit.record.event.text).toBe(
        'Quarantined reader classified an event from source "gmail"',
      )
    }

    // The extraction indexes; the log line stays the record: dereferencing
    // the same source ref again re-reads the original event, not a copy of
    // the indexed text.
    const dereferenced = index.dereference(hit?.sourceRef ?? '')
    expect(
      dereferenced.ok && dereferenced.kind === 'event' ? dereferenced.event.type : undefined,
    ).toBe('reader.summary')
  })
})

describe('memory-eval: rebuild determinism (issues/021-advanced-memory.md acceptance criterion 2)', () => {
  it('reproduces every pinned query sequence, in the same order, after the index is deleted and reconciled', () => {
    const { rootDir, engine, index, retrieval, spaceId } = buildCorpus()

    const kiriRetrieval = new MemoryRetrieval({
      index,
      spacesEngine: engine,
      config: config('Pacific/Kiritimati'),
      now,
    })
    const niueRetrieval = new MemoryRetrieval({
      index,
      spacesEngine: engine,
      config: config('Pacific/Niue'),
      now,
    })

    const queries = [
      () =>
        retrieval.search({
          spaceId,
          query: 'How much did I weigh at the start of June?',
          order: 'recency',
        }),
      () =>
        retrieval.search({
          spaceId,
          query: 'How much did I weigh at the end of May?',
          order: 'recency',
        }),
      () =>
        kiriRetrieval.search({
          spaceId,
          query: 'How much did I weigh at the start of June?',
          order: 'recency',
        }),
      () =>
        niueRetrieval.search({
          spaceId,
          query: 'How much did I weigh at the start of June?',
          order: 'recency',
        }),
      () =>
        retrieval.search({ spaceId, query: 'what is my current target weight?', order: 'recency' }),
    ]

    const before = queries.map((query) => query().hits.map((hit) => hit.sourceRef))
    expect(before.every((sequence) => sequence.length > 0)).toBe(true)
    index.close()

    deleteMemorySqlite(rootDir)

    const rebuiltIndex = new MemoryIndex({ rootDir, spacesEngine: engine, now })
    rebuiltIndex.reconcile()
    const rebuiltRetrieval = new MemoryRetrieval({
      index: rebuiltIndex,
      spacesEngine: engine,
      config: config(CORPUS_TIMEZONE),
      now,
    })
    const rebuiltKiri = new MemoryRetrieval({
      index: rebuiltIndex,
      spacesEngine: engine,
      config: config('Pacific/Kiritimati'),
      now,
    })
    const rebuiltNiue = new MemoryRetrieval({
      index: rebuiltIndex,
      spacesEngine: engine,
      config: config('Pacific/Niue'),
      now,
    })

    const rebuiltQueries = [
      () =>
        rebuiltRetrieval.search({
          spaceId,
          query: 'How much did I weigh at the start of June?',
          order: 'recency',
        }),
      () =>
        rebuiltRetrieval.search({
          spaceId,
          query: 'How much did I weigh at the end of May?',
          order: 'recency',
        }),
      () =>
        rebuiltKiri.search({
          spaceId,
          query: 'How much did I weigh at the start of June?',
          order: 'recency',
        }),
      () =>
        rebuiltNiue.search({
          spaceId,
          query: 'How much did I weigh at the start of June?',
          order: 'recency',
        }),
      () =>
        rebuiltRetrieval.search({
          spaceId,
          query: 'what is my current target weight?',
          order: 'recency',
        }),
    ]

    const after = rebuiltQueries.map((query) => query().hits.map((hit) => hit.sourceRef))
    expect(after).toEqual(before)

    rebuiltIndex.close()
  })
})

describe('memory-eval: FTS5 latency (issues/021-advanced-memory.md acceptance criterion 4)', () => {
  it('keeps MemoryIndex.search p95 under 50ms over 200 queries after a 20-query warm-up', () => {
    const { index, spaceId } = buildCorpus()

    // A small, pinned, varied term set so the measurement is not one cached
    // query repeated: a mix of terms with many hits (the daily weight log),
    // few hits (fillers, the update pair), and a fact-augmentation term.
    const terms = [
      'weigh',
      'walk',
      'soup',
      'target',
      'shoulder',
      CORPUS_READER_SUMMARY_SEARCH_TERM,
      'jog',
    ]

    const runOne = (i: number) =>
      index.search({ spaceId, terms: [terms[i % terms.length] ?? 'weigh'] })

    for (let i = 0; i < 20; i++) runOne(i) // Warm-up: not measured.

    const searchDurationsMs: number[] = []
    const wholeRetrievalDurationsMs: number[] = []
    for (let i = 0; i < 200; i++) {
      const term = terms[i % terms.length] ?? 'weigh'

      const searchStart = performance.now()
      const rows = index.search({ spaceId, terms: [term] })
      searchDurationsMs.push(performance.now() - searchStart)

      const wholeStart = performance.now()
      for (const row of rows) index.dereference(row.sourceRef)
      wholeRetrievalDurationsMs.push(performance.now() - wholeStart + searchDurationsMs[i]!)
    }

    const p95 = percentile(searchDurationsMs, 95)
    const wholeP95 = percentile(wholeRetrievalDurationsMs, 95)
    const sqliteVersionRow = new DatabaseSync(':memory:')
      .prepare('select sqlite_version() as version')
      .get()
    const sqliteVersion = sqliteVersionRow ? requiredString(sqliteVersionRow, 'version') : 'unknown'

    // What makes this number meaningful: the fixture is pinned to
    // `CORPUS_EVENT_COUNT` events (`memory-corpus.ts`) and `CORPUS_LOG_BYTES`
    // of indexed log text (both asserted in "memory-eval: fixture
    // integrity" above); this measures 200 calls to `MemoryIndex.search`
    // alone (the FTS5 query, never `dereference` or the whole
    // `MemoryRetrieval` stack) after a 20-query warm-up, cycling through a
    // small pinned term set. The reference environment is stated so the number
    // can be reproduced or discounted: a single Node process on an
    // Apple-Silicon macOS laptop (local NVMe, warm OS page cache, no
    // concurrent load), with the runtime's own SQLite build logged below. The
    // budget is set two orders of magnitude above what that environment
    // measures, so a slower machine — a shared CI runner, a small VPS — still
    // has headroom; a cold cache or a loaded host is explicitly out of scope
    // for this gate, and the logged value is what to compare against when
    // re-measuring elsewhere.
    console.log(
      `MemoryIndex.search p95: ${p95.toFixed(3)}ms over 200 queries ` +
        `(20-query warm-up, ${CORPUS_EVENT_COUNT} events / ${CORPUS_LOG_BYTES} indexed bytes, ` +
        `sqlite ${sqliteVersion}, ${process.platform}/${process.arch}, node ${process.versions.node}, ` +
        `warm page cache, single process)`,
    )
    // Non-gating: search + dereference together, so the cost `dereference`
    // (a file re-read plus a hash check) adds on top of the FTS5 query alone
    // is visible without making the p95 gate above flaky on that extra I/O.
    console.log(`MemoryIndex whole-retrieval (search+dereference) p95: ${wholeP95.toFixed(3)}ms`)

    expect(p95).toBeLessThan(50)
  })
})

function percentile(valuesMs: number[], p: number): number {
  const sorted = [...valuesMs].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)
  return sorted[Math.max(0, index)] ?? 0
}
