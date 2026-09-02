import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { factRecordIds } from './facts.ts'
import { MemoryConfigSchema, type MemoryConfig } from './memory-config.ts'
import { MemoryIndex } from './memory-index.ts'
import { MemoryRetrieval } from './memory-retrieval.ts'
import { SpacesEngine } from './spaces-engine.ts'
import { startOfZonedDay } from './timezone.ts'

/** Non-UTC on purpose: proves the range extraction genuinely resolves in `ZONE`, not the host's own clock. */
const ZONE = 'America/New_York'

function localNoonIso(year: number, month: number, day: number): string {
  const midnight = startOfZonedDay(ZONE, { year, month, day })
  return new Date(midnight.getTime() + 12 * 60 * 60 * 1000).toISOString()
}

const FIXED_NOW = new Date(localNoonIso(2026, 7, 28))
const now = () => new Date(FIXED_NOW.getTime())

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'veduta-memory-retrieval-'))
}

function memoryDbPath(rootDir: string): string {
  return join(rootDir, 'memory.sqlite')
}

function config(overrides: Partial<MemoryConfig> = {}): MemoryConfig {
  return MemoryConfigSchema.parse({ timezone: ZONE, ...overrides })
}

function setup() {
  const rootDir = tempRoot()
  const engine = new SpacesEngine({ rootDir, now })
  const index = new MemoryIndex({ rootDir, spacesEngine: engine, now })
  const retrieval = new MemoryRetrieval({ index, spacesEngine: engine, config: config(), now })
  return { rootDir, engine, index, retrieval }
}

describe('MemoryRetrieval: time-aware queries', () => {
  it('returns only the June 1-7 records for "start of June" and reports the extracted range, without needing the temporal words in the record text', () => {
    const { engine, retrieval } = setup()
    const health = engine.createSpace({ name: 'Health' })

    engine.appendEvent(health.id, {
      type: 'note',
      text: 'weighed 68 kilograms in May',
      at: localNoonIso(2026, 5, 15),
    })
    engine.appendEvent(health.id, {
      type: 'note',
      text: 'weighed 70 kilograms this morning',
      at: localNoonIso(2026, 6, 1),
    })
    engine.appendEvent(health.id, {
      type: 'note',
      text: 'weighed 70.5 kilograms',
      at: localNoonIso(2026, 6, 3),
    })
    engine.appendEvent(health.id, {
      type: 'note',
      text: 'weighed 71 kilograms',
      at: localNoonIso(2026, 6, 7),
    })
    engine.appendEvent(health.id, {
      type: 'note',
      text: 'weighed 72 kilograms mid june',
      at: localNoonIso(2026, 6, 15),
    })
    engine.appendEvent(health.id, {
      type: 'note',
      text: 'weighed 73 kilograms in july',
      at: localNoonIso(2026, 7, 1),
    })

    const outcome = retrieval.search({
      spaceId: health.id,
      query: 'How much did I weigh at the start of June?',
    })

    const texts = outcome.hits
      .map((hit) => (hit.record.type === 'event' ? hit.record.event.text : ''))
      .sort()
    expect(texts).toEqual(
      [
        'weighed 70 kilograms this morning',
        'weighed 70.5 kilograms',
        'weighed 71 kilograms',
      ].sort(),
    )
    // None of the June 1-7 records mention "start of june" anywhere: the
    // match came entirely from the extracted date range plus the remaining
    // word "weigh", never from the temporal phrase itself.
    for (const text of texts) expect(text.toLowerCase()).not.toContain('start of june')

    expect(outcome.range).toEqual({
      from: startOfZonedDay(ZONE, { year: 2026, month: 6, day: 1 }).toISOString(),
      to: startOfZonedDay(ZONE, { year: 2026, month: 6, day: 8 }).toISOString(),
    })
  })

  it('orders hits by recency when requested and defaults to relevance', () => {
    const { engine, retrieval } = setup()
    const health = engine.createSpace({ name: 'Health' })
    engine.appendEvent(health.id, {
      type: 'note',
      text: 'weighed 70 kilograms',
      at: localNoonIso(2026, 6, 1),
    })
    engine.appendEvent(health.id, {
      type: 'note',
      text: 'weighed 71 kilograms',
      at: localNoonIso(2026, 6, 3),
    })
    engine.appendEvent(health.id, {
      type: 'note',
      text: 'weighed 72 kilograms',
      at: localNoonIso(2026, 6, 7),
    })

    const recency = retrieval.search({ spaceId: health.id, query: 'weigh', order: 'recency' })
    const recencyTexts = recency.hits.map((hit) =>
      hit.record.type === 'event' ? hit.record.event.text : '',
    )
    expect(recencyTexts).toEqual([
      'weighed 72 kilograms',
      'weighed 71 kilograms',
      'weighed 70 kilograms',
    ])

    const relevanceDefault = retrieval.search({ spaceId: health.id, query: 'weigh' })
    const relevanceExplicit = retrieval.search({
      spaceId: health.id,
      query: 'weigh',
      order: 'relevance',
    })
    expect(relevanceDefault.hits.map((hit) => hit.sourceRef)).toEqual(
      relevanceExplicit.hits.map((hit) => hit.sourceRef),
    )
  })
})

describe('MemoryRetrieval: hits carry the original record and its own origin', () => {
  it("reports an untrusted event's own origin, never the query's", () => {
    const { engine, index, retrieval } = setup()
    const health = engine.createSpace({ name: 'Health' })
    engine.appendEvent(health.id, {
      type: 'reader.summary',
      origin: 'untrusted:gmail',
      text: 'forwarded weigh-in note from a friend',
      at: localNoonIso(2026, 6, 2),
    })
    index.reconcile()

    const outcome = retrieval.search({ spaceId: health.id, query: 'weigh-in' })
    expect(outcome.hits).toHaveLength(1)
    const hit = outcome.hits[0]
    expect(hit?.record.type).toBe('event')
    if (hit?.record.type === 'event') {
      expect(hit.record.event.text).toBe('forwarded weigh-in note from a friend')
    }
    expect(hit?.origins).toEqual(['untrusted:gmail'])
  })
})

describe('MemoryRetrieval: fact states', () => {
  it('returns active, dormant, and superseded facts with the right state via kind: "fact"', () => {
    const { engine, index, retrieval } = setup()
    const health = engine.createSpace({ name: 'Health' })

    engine.writeFact(health.id, 'I enjoy quiet mornings')
    engine.writeFact(health.id, 'I read mystery novels')
    engine.writeFact(health.id, 'I love hiking mountains')
    engine.writeFact(health.id, 'I hate hiking mountains') // supersedes the previous one

    const today = FIXED_NOW.toISOString().slice(0, 10)
    const document = engine.readFacts(health.id)
    const ids = factRecordIds(document, today)
    const dormantCandidate = document.active.find((fact) => fact.text === 'I read mystery novels')
    const dormantId = dormantCandidate ? ids.get(dormantCandidate) : undefined
    expect(dormantId).toBeDefined()
    engine.demoteFacts(health.id, [dormantId ?? ''])
    index.reconcile()

    const active = retrieval.search({ spaceId: health.id, query: 'mornings', kind: 'fact' })
    expect(active.hits).toHaveLength(1)
    expect(active.hits[0]?.record.type === 'fact' ? active.hits[0].record.state : undefined).toBe(
      'active',
    )
    expect(active.hits[0]?.origins).toEqual([])

    const dormant = retrieval.search({ spaceId: health.id, query: 'mystery', kind: 'fact' })
    expect(dormant.hits).toHaveLength(1)
    expect(dormant.hits[0]?.record.type === 'fact' ? dormant.hits[0].record.state : undefined).toBe(
      'dormant',
    )

    const superseded = retrieval.search({ spaceId: health.id, query: 'love', kind: 'fact' })
    expect(superseded.hits).toHaveLength(1)
    expect(
      superseded.hits[0]?.record.type === 'fact' ? superseded.hits[0].record.state : undefined,
    ).toBe('superseded')

    const rendered = retrieval.renderOutcome(active)
    expect(rendered).toContain('state: active')
  })
})

describe('MemoryRetrieval: query robustness', () => {
  it('handles a query containing FTS5 syntax the same as its plain-word form', () => {
    const { engine, retrieval } = setup()
    const health = engine.createSpace({ name: 'Health' })
    engine.appendEvent(health.id, {
      type: 'note',
      text: 'went for a walk with the dog',
      at: localNoonIso(2026, 6, 2),
    })

    const plain = retrieval.search({ spaceId: health.id, query: 'walk dog' })
    let tricky: ReturnType<typeof retrieval.search> | undefined
    expect(() => {
      tricky = retrieval.search({ spaceId: health.id, query: 'walk* "dog" NEAR(walk dog) -dog' })
    }).not.toThrow()
    expect(tricky?.hits.map((hit) => hit.sourceRef)).toEqual(plain.hits.map((hit) => hit.sourceRef))
    expect(plain.hits).toHaveLength(1)
  })

  it('returns an empty outcome without throwing when the query reduces to only stopwords', () => {
    const { engine, retrieval } = setup()
    const health = engine.createSpace({ name: 'Health' })
    expect(() => retrieval.search({ spaceId: health.id, query: 'What did I do?' })).not.toThrow()
    expect(retrieval.search({ spaceId: health.id, query: 'What did I do?' })).toEqual({
      hits: [],
      unresolved: [],
    })
  })
})

describe('MemoryRetrieval: stale handling', () => {
  it('excludes a stale hit from results and a subsequent search finds it again once reconcile rebuilds', () => {
    const rootDir = tempRoot()
    const engine = new SpacesEngine({ rootDir, now })
    const health = engine.createSpace({ name: 'Health' })
    engine.appendEvent(health.id, { type: 'note', text: 'unique-stale-marker weigh check' })

    // Each phase below closes its `MemoryIndex` before the next raw
    // `DatabaseSync` mutation and reopens a fresh one afterwards — the same
    // pattern `memory-index.test.ts` uses throughout: a long-lived SQLite
    // connection does not pick up a write committed by a separate
    // connection to the same WAL file until it is reopened.
    let index = new MemoryIndex({ rootDir, spacesEngine: engine, now })
    index.reconcile() // The event above was appended before the index existed.
    let retrieval = new MemoryRetrieval({ index, spacesEngine: engine, config: config(), now })
    const before = retrieval.search({ spaceId: health.id, query: 'unique-stale-marker' })
    expect(before.hits).toHaveLength(1)
    const sourceRef = before.hits[0]?.sourceRef ?? ''
    index.close()

    const raw = new DatabaseSync(memoryDbPath(rootDir))
    raw
      .prepare('update memory_records set hash = ? where source_ref = ?')
      .run('deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef', sourceRef)
    raw.close()

    index = new MemoryIndex({ rootDir, spacesEngine: engine, now })
    retrieval = new MemoryRetrieval({ index, spacesEngine: engine, config: config(), now })
    const staleOutcome = retrieval.search({ spaceId: health.id, query: 'unique-stale-marker' })
    expect(staleOutcome.hits).toEqual([])
    expect(staleOutcome.unresolved).toEqual([sourceRef])
    index.close()

    // A hand-corrupted `hash` column alone leaves the log file and its
    // cursor untouched, so `reconcile()`'s own shrink/prefix-hash checks
    // (memory-index.ts) see nothing to redo and never revisit this exact
    // row: the search above already ran its one reconcile-and-retry and
    // still failed. Invalidating `schema_version` too forces the other,
    // already-documented recovery path — "a missing or stale schema_version
    // throws the whole index away and rebuilds" — which re-derives every
    // hash from the real files, including this one.
    const rawAgain = new DatabaseSync(memoryDbPath(rootDir))
    rawAgain.prepare('update memory_meta set value = ? where key = ?').run('999', 'schema_version')
    rawAgain.close()

    index = new MemoryIndex({ rootDir, spacesEngine: engine, now })
    retrieval = new MemoryRetrieval({ index, spacesEngine: engine, config: config(), now })
    const repaired = retrieval.search({ spaceId: health.id, query: 'unique-stale-marker' })
    expect(repaired.hits).toHaveLength(1)
    expect(repaired.hits[0]?.sourceRef).toBe(sourceRef)
    expect(repaired.unresolved).toEqual([])
    index.close()
  })
})

describe('MemoryRetrieval: renderOutcome', () => {
  it('preserves unresolved source references when the complete diagnostic fits the budget', () => {
    const { retrieval } = setup()
    const sourceRef = 'event:spc-health:2026-07-03.jsonl:7'

    const rendered = retrieval.renderOutcome({ hits: [], unresolved: [sourceRef] })

    expect(rendered).toContain(`1 reference(s) could not be resolved: ${sourceRef}`)
    expect(rendered.length).toBeLessThanOrEqual(8_000)
  })

  it('falls back to a bounded unresolved-reference count when the full diagnostic cannot fit', () => {
    const { retrieval } = setup()
    const unresolved = Array.from(
      { length: 100 },
      (_, index) => `event:spc-health:${'x'.repeat(190)}:${index}`,
    )

    const rendered = retrieval.renderOutcome({ hits: [], unresolved })

    expect(rendered).toContain('100 reference(s) could not be resolved.')
    expect(rendered).not.toContain(unresolved[0])
    expect(rendered.length).toBeLessThanOrEqual(8_000)
  })

  it('keeps untrusted event text inside the delimited block and reports "nothing found" for an empty outcome', () => {
    const { engine, index, retrieval } = setup()
    const health = engine.createSpace({ name: 'Health' })
    engine.appendEvent(health.id, {
      type: 'reader.summary',
      origin: 'untrusted:gmail',
      text: 'forwarded weigh-in reminder',
      at: localNoonIso(2026, 6, 2),
    })
    index.reconcile()

    const outcome = retrieval.search({ spaceId: health.id, query: 'weigh-in' })
    const rendered = retrieval.renderOutcome(outcome)
    expect(rendered).toContain('<<<UNTRUSTED data from gmail>>>')
    expect(rendered).toContain('forwarded weigh-in reminder')

    const empty = retrieval.renderOutcome({ hits: [], unresolved: [] })
    expect(empty).toBe('No matching memory found for this query.')
  })

  it('keeps untrusted fact text inside the same delimited block facts-projection.ts uses', () => {
    const { engine, index, retrieval } = setup()
    const health = engine.createSpace({ name: 'Health' })
    engine.writeFact(health.id, 'Meeting with Alice at 3pm', 'untrusted:gmail')
    index.reconcile()

    const outcome = retrieval.search({ spaceId: health.id, query: 'meeting', kind: 'fact' })
    expect(outcome.hits[0]?.origins).toEqual(['untrusted:gmail'])
    const rendered = retrieval.renderOutcome(outcome)
    expect(rendered).toContain('<<<UNTRUSTED data from gmail>>>')
    expect(rendered).toContain('Meeting with Alice at 3pm')
  })
})
