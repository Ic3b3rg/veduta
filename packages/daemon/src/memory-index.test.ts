import { mkdtempSync, existsSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { factRecordIds } from './facts.ts'
import {
  formatSourceRef,
  MemoryIndex,
  parseSourceRef,
  SCHEMA_VERSION,
  type DereferenceResult,
  type MemorySourceRef,
} from './memory-index.ts'
import { SpacesEngine, type SpaceEvent } from './spaces-engine.ts'
import { requiredNumber, requiredString } from './sqlite-rows.ts'

const FIXED_NOW = new Date('2026-07-08T13:00:00.000Z')
const now = () => new Date(FIXED_NOW.getTime())

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'veduta-memory-index-'))
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

function logFilePath(rootDir: string, slug: string, day: string): string {
  return join(rootDir, 'spaces', slug, 'log', `${day}.jsonl`)
}

function eventFromDereference(result: DereferenceResult): SpaceEvent {
  if (!result.ok || result.kind !== 'event') {
    throw new Error(`expected an event hit, got ${JSON.stringify(result)}`)
  }
  return result.event
}

describe('MemoryIndex: source references', () => {
  it('formats and parses event and fact references losslessly', () => {
    const eventRef: MemorySourceRef = {
      kind: 'event',
      spaceId: 'spc-health',
      file: '2026-07-08.jsonl',
      line: 3,
    }
    expect(parseSourceRef(formatSourceRef(eventRef))).toEqual(eventRef)

    const factRef: MemorySourceRef = {
      kind: 'fact',
      spaceId: 'spc-health',
      recordId: 'abc123def4567890-0',
    }
    expect(parseSourceRef(formatSourceRef(factRef))).toEqual(factRef)
  })

  it('returns undefined for a malformed reference', () => {
    expect(parseSourceRef('nonsense')).toBeUndefined()
    expect(parseSourceRef('event:spc-health/file.jsonl#not-a-number')).toBeUndefined()
  })

  it('rejects a source ref whose file component attempts path traversal', () => {
    // The file group used to be `[^#]+`, so this parsed successfully and
    // `readLogLine`/`readLogPrefixHash` would join it onto a path
    // unvalidated. Constraining it to the `YYYY-MM-DD.jsonl` log-file naming
    // convention closes that off one regex away from being reachable.
    expect(parseSourceRef('event:spc-health/../../../../etc/passwd#1')).toBeUndefined()
  })
})

describe('MemoryIndex: finding events', () => {
  it('finds an event by a word in its text and dereferences to the original, including occurredAt', () => {
    const rootDir = tempRoot()
    const engine = new SpacesEngine({ rootDir, now })
    const health = engine.createSpace({ name: 'Health' })
    engine.appendEvent(health.id, {
      type: 'note',
      text: 'Went for a long swim this afternoon',
      occurredAt: '2026-07-07T15:00:00.000Z',
    })

    const index = new MemoryIndex({ rootDir, spacesEngine: engine, now })
    index.reconcile() // The event above was appended before the index existed.
    const hits = index.search({ spaceId: health.id, terms: ['swim'] })
    expect(hits).toHaveLength(1)

    const result = index.dereference(hits[0]?.sourceRef ?? '')
    expect(result.ok).toBe(true)
    const event = eventFromDereference(result)
    expect(event.text).toBe('Went for a long swim this afternoon')
    expect(event.occurredAt).toBe('2026-07-07T15:00:00.000Z')

    index.close()
  })

  it('finds an event by a word nested inside its payload', () => {
    const rootDir = tempRoot()
    const engine = new SpacesEngine({ rootDir, now })
    const health = engine.createSpace({ name: 'Health' })
    engine.appendEvent(health.id, {
      type: 'note',
      text: 'Logged a grocery run',
      payload: { basket: { items: ['bread', 'blueberry muffins'] } },
    })

    const index = new MemoryIndex({ rootDir, spacesEngine: engine, now })
    index.reconcile()
    const hits = index.search({ spaceId: health.id, terms: ['blueberry'] })
    expect(hits).toHaveLength(1)
    const event = eventFromDereference(index.dereference(hits[0]?.sourceRef ?? ''))
    expect(event.text).toBe('Logged a grocery run')

    index.close()
  })

  it('finds a reader.summary entity and dereferences to the original event (fact-augmentation)', () => {
    const rootDir = tempRoot()
    const engine = new SpacesEngine({ rootDir, now })
    const health = engine.createSpace({ name: 'Health' })
    engine.appendEvent(health.id, {
      type: 'reader.summary',
      origin: 'untrusted:gmail',
      text: 'Quarantined reader classified an event from source "gmail"',
      payload: {
        queueId: 1,
        source: 'gmail',
        reader: {
          subject: 'Team roadmap sync',
          sender: 'alice@example.com',
          intent: 'meeting',
          entities: ['Alice Smith', 'Conference Room B'],
          deadlines: [],
          urgency: 'normal',
          summary: 'Alice wants to schedule a sync about the roadmap.',
        },
      },
    })

    const index = new MemoryIndex({ rootDir, spacesEngine: engine, now })
    index.reconcile()
    const hits = index.search({ spaceId: health.id, terms: ['conference'] })
    expect(hits).toHaveLength(1)
    const event = eventFromDereference(index.dereference(hits[0]?.sourceRef ?? ''))
    expect(event.type).toBe('reader.summary')
    expect(event.text).toBe('Quarantined reader classified an event from source "gmail"')

    index.close()
  })
})

describe('MemoryIndex: finding facts', () => {
  it('finds active, dormant, and superseded facts by text and dereferences with the right state', () => {
    const rootDir = tempRoot()
    const engine = new SpacesEngine({ rootDir, now })
    const health = engine.createSpace({ name: 'Health' })
    const index = new MemoryIndex({ rootDir, spacesEngine: engine, now })

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

    // `kind: 'fact'` scopes past the `fact.write` Event log echo every
    // `writeFact` call also produces (ADR-0003), which would otherwise
    // double-count these same words.
    const activeHits = index.search({ spaceId: health.id, terms: ['mornings'], kind: 'fact' })
    expect(activeHits).toHaveLength(1)
    const activeResult = index.dereference(activeHits[0]?.sourceRef ?? '')
    expect(activeResult.ok && activeResult.kind === 'fact' ? activeResult.state : undefined).toBe(
      'active',
    )
    expect(
      activeResult.ok && activeResult.kind === 'fact' ? activeResult.fact.text : undefined,
    ).toBe('I enjoy quiet mornings')

    const dormantHits = index.search({ spaceId: health.id, terms: ['mystery'], kind: 'fact' })
    expect(dormantHits).toHaveLength(1)
    const dormantResult = index.dereference(dormantHits[0]?.sourceRef ?? '')
    expect(
      dormantResult.ok && dormantResult.kind === 'fact' ? dormantResult.state : undefined,
    ).toBe('dormant')

    const supersededHits = index.search({ spaceId: health.id, terms: ['love'], kind: 'fact' })
    expect(supersededHits).toHaveLength(1)
    const supersededResult = index.dereference(supersededHits[0]?.sourceRef ?? '')
    expect(
      supersededResult.ok && supersededResult.kind === 'fact' ? supersededResult.state : undefined,
    ).toBe('superseded')

    index.close()
  })

  it('leaves no orphan fact rows after a supersede rewrites FACTS.md', () => {
    const rootDir = tempRoot()
    const engine = new SpacesEngine({ rootDir, now })
    const health = engine.createSpace({ name: 'Health' })
    const index = new MemoryIndex({ rootDir, spacesEngine: engine, now })

    engine.writeFact(health.id, 'I love hiking mountains')
    engine.writeFact(health.id, 'I hate hiking mountains') // supersede: rewrites FACTS.md

    const db = new DatabaseSync(memoryDbPath(rootDir))
    const rows = db
      .prepare(`select source_ref from memory_records where space_id = ? and kind = 'fact'`)
      .all(health.id)
    db.close()
    expect(rows.length).toBeGreaterThan(0)

    for (const row of rows) {
      const sourceRef = requiredString(row, 'source_ref')
      const result = index.dereference(sourceRef)
      expect(result.ok).toBe(true)
    }

    index.close()
  })
})

describe('MemoryIndex: incremental indexing', () => {
  it('indexes only new lines, and repeating the call adds nothing', () => {
    const rootDir = tempRoot()
    const engine = new SpacesEngine({ rootDir, now })
    const health = engine.createSpace({ name: 'Health' })
    const day = '2026-07-09'
    engine.appendEvent(health.id, { type: 'note', text: 'first entry', at: `${day}T08:00:00.000Z` })
    engine.appendEvent(health.id, {
      type: 'note',
      text: 'second entry',
      at: `${day}T09:00:00.000Z`,
    })

    const index = new MemoryIndex({ rootDir, spacesEngine: engine, now })
    index.indexSpaceEvents(health.id)

    const cursorSource = `${health.id}/${day}.jsonl`
    const readCursor = () => {
      const db = new DatabaseSync(memoryDbPath(rootDir))
      const row = db.prepare('select * from memory_cursors where source = ?').get(cursorSource)
      db.close()
      return row
        ? {
            indexedBytes: requiredNumber(row, 'indexed_bytes'),
            indexedLines: requiredNumber(row, 'indexed_lines'),
          }
        : undefined
    }

    const firstCursor = readCursor()
    expect(firstCursor?.indexedLines).toBe(2)
    const firstRowCount = index
      .search({ spaceId: health.id, terms: ['entry'] })
      .filter((row) => row.kind === 'event').length
    expect(firstRowCount).toBe(2)

    index.indexSpaceEvents(health.id)
    const secondCursor = readCursor()
    expect(secondCursor).toEqual(firstCursor)
    const secondRowCount = index
      .search({ spaceId: health.id, terms: ['entry'] })
      .filter((row) => row.kind === 'event').length
    expect(secondRowCount).toBe(2)

    index.close()
  })
})

describe('MemoryIndex: delete-and-rebuild determinism', () => {
  it('reproduces the exact same hit sequence and order for relevance and recency after the index file is deleted', () => {
    const rootDir = tempRoot()
    const engine = new SpacesEngine({ rootDir, now })
    const health = engine.createSpace({ name: 'Health' })
    engine.appendEvent(health.id, {
      type: 'note',
      text: 'weighed 70 kilograms this morning',
      at: '2026-06-01T08:00:00.000Z',
    })
    engine.appendEvent(health.id, {
      type: 'note',
      text: 'weighed 71 kilograms after breakfast',
      at: '2026-06-15T08:00:00.000Z',
    })
    engine.appendEvent(health.id, {
      type: 'note',
      text: 'weighed 69 kilograms before dinner',
      at: '2026-07-01T08:00:00.000Z',
    })
    engine.writeFact(health.id, 'I weigh about 70 kilograms')

    let index = new MemoryIndex({ rootDir, spacesEngine: engine, now })
    index.reconcile() // Everything above was written before the index existed.
    const relevanceBefore = index
      .search({ spaceId: health.id, terms: ['kilograms'], order: 'relevance' })
      .map((row) => row.sourceRef)
    const recencyBefore = index
      .search({ spaceId: health.id, terms: ['kilograms'], order: 'recency' })
      .map((row) => row.sourceRef)
    expect(relevanceBefore.length).toBeGreaterThan(0)
    index.close()

    deleteMemorySqlite(rootDir)

    index = new MemoryIndex({ rootDir, spacesEngine: engine, now })
    index.reconcile()
    const relevanceAfter = index
      .search({ spaceId: health.id, terms: ['kilograms'], order: 'relevance' })
      .map((row) => row.sourceRef)
    const recencyAfter = index
      .search({ spaceId: health.id, terms: ['kilograms'], order: 'recency' })
      .map((row) => row.sourceRef)

    expect(relevanceAfter).toEqual(relevanceBefore)
    expect(recencyAfter).toEqual(recencyBefore)

    index.close()
  })
})

describe('MemoryIndex: log file anomalies (reconcile)', () => {
  it('fully reindexes a log file whose content changed at the same byte length', () => {
    const rootDir = tempRoot()
    const engine = new SpacesEngine({ rootDir, now })
    const health = engine.createSpace({ name: 'Health' })
    const day = '2026-07-09'
    engine.appendEvent(health.id, { type: 'note', text: 'apple', at: `${day}T08:00:00.000Z` })

    const index = new MemoryIndex({ rootDir, spacesEngine: engine, now })
    // A full `reconcile()` first (rather than `indexSpaceEvents`) so `schema_version`
    // is already stamped: otherwise the `reconcile()` below, seeing no stored version,
    // would take the "rebuild everything" branch and never exercise prefix-hash detection.
    index.reconcile()
    expect(index.search({ spaceId: health.id, terms: ['apple'] })).toHaveLength(1)

    const logFile = logFilePath(rootDir, health.slug, day)
    const originalLine = readFileSync(logFile, 'utf8').trimEnd()
    const parsedEvent = JSON.parse(originalLine) as { text: string }
    expect(parsedEvent.text).toBe('apple')
    const mutatedLine = JSON.stringify({ ...parsedEvent, text: 'mango' })
    expect(mutatedLine.length).toBe(originalLine.length) // same byte length, different content
    writeFileSync(logFile, `${mutatedLine}\n`)

    index.reconcile()
    expect(index.search({ spaceId: health.id, terms: ['apple'] })).toEqual([])
    const hits = index.search({ spaceId: health.id, terms: ['mango'] })
    expect(hits).toHaveLength(1)
    const event = eventFromDereference(index.dereference(hits[0]?.sourceRef ?? ''))
    expect(event.text).toBe('mango')

    index.close()
  })

  it('fully reindexes a log file that shrank below its cursor', () => {
    const rootDir = tempRoot()
    const engine = new SpacesEngine({ rootDir, now })
    const health = engine.createSpace({ name: 'Health' })
    const day = '2026-07-09'
    engine.appendEvent(health.id, {
      type: 'note',
      text: 'first-kept-line',
      at: `${day}T08:00:00.000Z`,
    })
    engine.appendEvent(health.id, {
      type: 'note',
      text: 'second-truncated-line',
      at: `${day}T09:00:00.000Z`,
    })

    const index = new MemoryIndex({ rootDir, spacesEngine: engine, now })
    // A full `reconcile()` first stamps `schema_version`, so the `reconcile()` below
    // exercises the shrink check instead of an unconditional rebuild.
    index.reconcile()
    expect(index.search({ spaceId: health.id, terms: ['truncated'] })).toHaveLength(1)

    const logFile = logFilePath(rootDir, health.slug, day)
    const firstLine = readFileSync(logFile, 'utf8').split('\n')[0]
    writeFileSync(logFile, `${firstLine}\n`)

    index.reconcile()
    expect(index.search({ spaceId: health.id, terms: ['truncated'] })).toEqual([])
    expect(index.search({ spaceId: health.id, terms: ['kept'] })).toHaveLength(1)

    index.close()
  })

  it('repairs an index holding rows for lines beyond the file current length', () => {
    const rootDir = tempRoot()
    const engine = new SpacesEngine({ rootDir, now })
    const health = engine.createSpace({ name: 'Health' })
    const day = '2026-07-09'
    engine.appendEvent(health.id, {
      type: 'note',
      text: 'only real line',
      at: `${day}T08:00:00.000Z`,
    })

    let index = new MemoryIndex({ rootDir, spacesEngine: engine, now })
    // A full `reconcile()` first stamps `schema_version`, so the `reconcile()` below
    // exercises the beyond-line-count prune instead of an unconditional rebuild.
    index.reconcile()
    index.close()

    const phantomRef = `event:${health.id}/${day}.jsonl#99`
    const raw = new DatabaseSync(memoryDbPath(rootDir))
    raw
      .prepare(
        `insert into memory_records (source_ref, space_id, kind, recorded_at, occurred_at, origin, hash)
         values (?, ?, 'event', ?, null, 'trusted:system', 'deadbeef')`,
      )
      .run(phantomRef, health.id, now().toISOString())
    raw
      .prepare('insert into memory_fts (text, source_ref) values (?, ?)')
      .run('phantom line beyond file length', phantomRef)
    raw.close()

    index = new MemoryIndex({ rootDir, spacesEngine: engine, now })
    expect(index.search({ spaceId: health.id, terms: ['phantom'] })).toHaveLength(1)
    index.reconcile()
    expect(index.search({ spaceId: health.id, terms: ['phantom'] })).toEqual([])
    expect(index.dereference(phantomRef)).toEqual({ ok: false, reason: 'missing' })

    index.close()
  })

  it('prunes records for a log file deleted from disk', () => {
    const rootDir = tempRoot()
    const engine = new SpacesEngine({ rootDir, now })
    const health = engine.createSpace({ name: 'Health' })
    engine.appendEvent(health.id, {
      type: 'note',
      text: 'day one marker',
      at: '2026-07-09T08:00:00.000Z',
    })
    engine.appendEvent(health.id, {
      type: 'note',
      text: 'day two marker',
      at: '2026-07-10T08:00:00.000Z',
    })

    let index = new MemoryIndex({ rootDir, spacesEngine: engine, now })
    // A full `reconcile()` first stamps `schema_version`, so the `reconcile()` below
    // exercises orphan pruning instead of an unconditional rebuild.
    index.reconcile()
    expect(index.search({ spaceId: health.id, terms: ['two'] })).toHaveLength(1)
    index.close()

    unlinkSync(logFilePath(rootDir, health.slug, '2026-07-10'))

    index = new MemoryIndex({ rootDir, spacesEngine: engine, now })
    index.reconcile()
    expect(index.search({ spaceId: health.id, terms: ['two'] })).toEqual([])
    expect(index.search({ spaceId: health.id, terms: ['one'] })).toHaveLength(1)

    index.close()
  })

  it('prunes records for an archived-then-deleted Space directory', () => {
    const rootDir = tempRoot()
    const engine = new SpacesEngine({ rootDir, now })
    const food = engine.createSpace({ name: 'Food' })
    engine.appendEvent(food.id, { type: 'note', text: 'grocery marker text' })
    engine.writeFact(food.id, 'I like barley soup')

    let index = new MemoryIndex({ rootDir, spacesEngine: engine, now })
    index.reconcile() // The event and fact above were written before the index existed.
    expect(index.recordCount(food.id)).toBeGreaterThan(0)
    index.close()

    engine.archiveSpace(food.id)
    rmSync(join(rootDir, 'spaces', food.slug), { recursive: true, force: true })

    index = new MemoryIndex({ rootDir, spacesEngine: engine, now })
    index.reconcile()
    expect(index.recordCount(food.id)).toBe(0)

    index.close()
  })
})

describe('MemoryIndex: hash validation', () => {
  it('reports stale rather than a wrong record when a stored hash is hand-corrupted', () => {
    const rootDir = tempRoot()
    const engine = new SpacesEngine({ rootDir, now })
    const health = engine.createSpace({ name: 'Health' })
    engine.appendEvent(health.id, { type: 'note', text: 'unique-corrupt-marker' })

    let index = new MemoryIndex({ rootDir, spacesEngine: engine, now })
    index.indexSpaceEvents(health.id) // The event above was appended before the index existed.
    const hits = index.search({ spaceId: health.id, terms: ['unique-corrupt-marker'] })
    expect(hits).toHaveLength(1)
    const sourceRef = hits[0]?.sourceRef ?? ''
    index.close()

    const raw = new DatabaseSync(memoryDbPath(rootDir))
    raw
      .prepare('update memory_records set hash = ? where source_ref = ?')
      .run('deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef', sourceRef)
    raw.close()

    index = new MemoryIndex({ rootDir, spacesEngine: engine, now })
    expect(index.dereference(sourceRef)).toEqual({ ok: false, reason: 'stale' })

    index.close()
  })
})

describe('MemoryIndex: schema version', () => {
  it('rebuilds fully on the next reconcile() when schema_version is bumped away', () => {
    const rootDir = tempRoot()
    const engine = new SpacesEngine({ rootDir, now })
    const health = engine.createSpace({ name: 'Health' })
    engine.appendEvent(health.id, { type: 'note', text: 'schema bump marker' })
    engine.writeFact(health.id, 'I keep a sleep log')

    let index = new MemoryIndex({ rootDir, spacesEngine: engine, now })
    index.reconcile() // The event and fact above were written before the index existed.
    const baselineCount = index.recordCount(health.id)
    expect(baselineCount).toBeGreaterThan(0)
    index.close()

    const raw = new DatabaseSync(memoryDbPath(rootDir))
    raw.prepare('update memory_meta set value = ? where key = ?').run('999', 'schema_version')
    raw.close()

    index = new MemoryIndex({ rootDir, spacesEngine: engine, now })
    index.reconcile()
    expect(index.status().schemaVersion).toBe(SCHEMA_VERSION)
    expect(index.recordCount(health.id)).toBe(baselineCount)

    index.close()
  })
})

describe('MemoryIndex: crash recovery', () => {
  it('closes a gap left by an append that happened while the index was not running', () => {
    const rootDir = tempRoot()
    const engine = new SpacesEngine({ rootDir, now })
    const health = engine.createSpace({ name: 'Health' })

    const index1 = new MemoryIndex({ rootDir, spacesEngine: engine, now })
    engine.appendEvent(health.id, { type: 'note', text: 'an earlier, unrelated note' })
    index1.close()

    // Simulates a crash between the log append and the index write: the
    // event below lands on disk with no MemoryIndex subscribed to notice it.
    engine.appendEvent(health.id, { type: 'note', text: 'after the crash marker' })

    const index2 = new MemoryIndex({ rootDir, spacesEngine: engine, now })
    expect(index2.search({ spaceId: health.id, terms: ['crash'] })).toEqual([])

    index2.reconcile()
    const hits = index2.search({ spaceId: health.id, terms: ['crash'] })
    expect(hits).toHaveLength(1)

    index2.close()
  })
})

describe('MemoryIndex: time-aware search', () => {
  it('matches by occurredAt under effective time basis and by at under recorded time basis', () => {
    const rootDir = tempRoot()
    const engine = new SpacesEngine({ rootDir, now })
    const health = engine.createSpace({ name: 'Health' })
    engine.appendEvent(health.id, {
      type: 'note',
      text: 'range marker event',
      at: '2026-07-20T10:00:00.000Z',
      occurredAt: '2026-06-01T09:00:00.000Z',
    })

    const index = new MemoryIndex({ rootDir, spacesEngine: engine, now })
    index.indexSpaceEvents(health.id) // The event above was appended before the index existed.

    const juneRange = { from: '2026-05-01T00:00:00.000Z', to: '2026-06-30T00:00:00.000Z' }
    const julyRange = { from: '2026-07-01T00:00:00.000Z', to: '2026-07-31T00:00:00.000Z' }

    expect(
      index.search({
        spaceId: health.id,
        terms: ['marker'],
        timeBasis: 'effective',
        ...juneRange,
      }),
    ).toHaveLength(1)
    expect(
      index.search({
        spaceId: health.id,
        terms: ['marker'],
        timeBasis: 'effective',
        ...julyRange,
      }),
    ).toEqual([])

    expect(
      index.search({
        spaceId: health.id,
        terms: ['marker'],
        timeBasis: 'recorded',
        ...julyRange,
      }),
    ).toHaveLength(1)
    expect(
      index.search({
        spaceId: health.id,
        terms: ['marker'],
        timeBasis: 'recorded',
        ...juneRange,
      }),
    ).toEqual([])

    index.close()
  })
})

describe('MemoryIndex: search robustness', () => {
  it('returns an empty array without throwing for empty terms', () => {
    const rootDir = tempRoot()
    const engine = new SpacesEngine({ rootDir, now })
    const health = engine.createSpace({ name: 'Health' })
    const index = new MemoryIndex({ rootDir, spacesEngine: engine, now })

    expect(index.search({ spaceId: health.id, terms: [] })).toEqual([])

    index.close()
  })

  it('does not throw for a term containing FTS5 query syntax', () => {
    const rootDir = tempRoot()
    const engine = new SpacesEngine({ rootDir, now })
    const health = engine.createSpace({ name: 'Health' })
    engine.appendEvent(health.id, { type: 'note', text: 'a normal entry about walking' })
    const index = new MemoryIndex({ rootDir, spacesEngine: engine, now })

    const trickyTerms = ['"unterminated', 'walk*', '-walking', 'NEAR(walking dog)', 'a" OR "b']
    for (const term of trickyTerms) {
      expect(() => index.search({ spaceId: health.id, terms: [term] })).not.toThrow()
    }

    index.close()
  })
})

describe('MemoryIndex.search: range bounds', () => {
  it('selects the same rows for every spelling of one instant, whatever offset the caller used', () => {
    const rootDir = tempRoot()
    const engine = new SpacesEngine({ rootDir, now })
    const health = engine.createSpace({ name: 'Health' })
    engine.appendEvent(health.id, {
      type: 'note',
      text: 'Weighed myself before breakfast',
      at: '2026-06-01T08:00:00.000Z',
    })

    const index = new MemoryIndex({ rootDir, spacesEngine: engine, now })
    index.reconcile()

    // Stored clocks are normalized to a `Z` offset and compared lexically, so
    // an offset-bearing bound used to select nothing at all even though the
    // Agent-facing schema accepts one.
    const spellings = [
      '2026-06-01T08:00:00.000Z',
      '2026-06-01T10:00:00+02:00',
      '2026-06-01T03:00:00-05:00',
      '2026-06-01T08:00:00Z',
    ]
    for (const from of spellings) {
      const hits = index.search({ spaceId: health.id, terms: ['weighed'], from })
      expect(hits.map((hit) => hit.sourceRef)).toHaveLength(1)
    }

    // And the exclusive upper bound still excludes, in every spelling.
    for (const to of spellings) {
      expect(index.search({ spaceId: health.id, terms: ['weighed'], to })).toEqual([])
    }

    index.close()
  })

  it('throws naming the value when a bound is not a parseable instant', () => {
    const rootDir = tempRoot()
    const engine = new SpacesEngine({ rootDir, now })
    const health = engine.createSpace({ name: 'Health' })
    const index = new MemoryIndex({ rootDir, spacesEngine: engine, now })

    expect(() => index.search({ spaceId: health.id, terms: ['x'], from: 'yesterday' })).toThrow(
      /yesterday/,
    )

    index.close()
  })
})

describe('MemoryIndex: incremental indexing cost', () => {
  it('reads only the log file a new event landed in, not every day of history', () => {
    const rootDir = tempRoot()
    const engine = new SpacesEngine({ rootDir, now })
    const health = engine.createSpace({ name: 'Health' })
    for (let day = 1; day <= 20; day++) {
      const at = `2026-06-${String(day).padStart(2, '0')}T09:00:00.000Z`
      engine.appendEvent(health.id, { type: 'note', text: `Day ${day} note`, at })
    }

    const seeded = new MemoryIndex({ rootDir, spacesEngine: engine, now })
    seeded.reconcile()
    const indexedBefore = seeded.recordCount(health.id)
    // Closed before the measurement: a second live index would service the
    // append through its own subscription and hide what this one does.
    seeded.close()

    // Every log file a write does not touch must be skipped on its cursor
    // rather than re-read. This used to read every daily file in full on every
    // append — linear in the Space's whole history, on the fast path for each
    // user interaction and each ingested event.
    let reads = 0
    const observed = new Proxy(engine, {
      get(target, property, receiver) {
        if (property === 'readLogEntriesFrom') {
          return (...args: Parameters<SpacesEngine['readLogEntriesFrom']>) => {
            reads += 1
            return target.readLogEntriesFrom(...args)
          }
        }
        return Reflect.get(target, property, receiver) as unknown
      },
    })
    const watched = new MemoryIndex({ rootDir, spacesEngine: observed, now })

    engine.appendEvent(health.id, {
      type: 'note',
      text: 'One more note',
      at: '2026-06-20T10:00:00.000Z',
    })

    expect(reads).toBe(1)
    expect(watched.recordCount(health.id)).toBe(indexedBefore + 1)

    watched.close()
  })
})
