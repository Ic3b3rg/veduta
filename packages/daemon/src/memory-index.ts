import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { JsonValue } from '@veduta/protocol'
import { factIdentityLine, factRecordIds, type FactRecord, type FactsDocument } from './facts.ts'
import { parseSpaceEventLine, type SpaceEvent, type SpacesEngine } from './spaces-engine.ts'
import {
  optionalString,
  requiredNumber,
  requiredString,
  withImmediateTransaction,
} from './sqlite-rows.ts'
import { isValidOrigin, type Origin } from './taint.ts'
import { normalizeIsoInstant } from './timezone.ts'

/**
 * A disposable SQLite FTS5 index over one Space's Event log and FACTS
 * (issues/021-advanced-memory.md, ADR-0006): the files under
 * `SpacesEngine`'s root are the truth, this index only makes the long tail
 * findable. Deleting `memory.sqlite` (plus its `-wal`/`-shm` companions) and
 * calling `reconcile()` must be a fully supported recovery path that
 * reproduces the same search results — that is why the schema carries a
 * `schema_version` and per-file cursors instead of a migration framework:
 * a version bump or an unrecognized state just means "throw it away and
 * rebuild from the files", which is always correct because the files never
 * depend on the index for anything.
 *
 * Every hit stores a stable source reference (`formatSourceRef`/
 * `parseSourceRef`) and metadata only — `memory_records` never holds a copy
 * of the answer-bearing text, only `memory_fts.text` does, and that text
 * exists purely to be matched, never to be returned as the record itself.
 * `dereference` always re-reads the original file and validates a content
 * hash before handing anything back (ARCHITECTURE.md §7: extraction must
 * never become truth) — a stale or corrupted index must report that rather
 * than answer with the wrong record.
 *
 * A `reader.summary` event's payload carries the quarantined reader's
 * schema-validated extraction (`quarantined-reader.ts`'s `ReaderOutputSchema`)
 * under `payload.reader`. Indexing every string leaf of an event's payload
 * (see `buildEventSearchText`) is what makes those extracted fields —
 * subject, sender, entities, deadlines, urgency, intent, summary — findable
 * by search while `dereference` still resolves the hit back to the original
 * log line: the extraction indexes, the log line stays the record.
 *
 * A Space's stable identity is its id, not its slug, everywhere a source
 * reference is built: a slug can be reused after a Space is archived and
 * later a new one created with the same name, but an id never is.
 */

/** Bumping this forces `reconcile()` to discard and rebuild the whole index on next boot. */
export const SCHEMA_VERSION = 1

/**
 * Cap on the text indexed per record (an event's type, text, and every
 * string leaf of its payload; a fact's text): one outsized event or fact
 * must not be able to bloat the index without bound.
 */
export const MAX_INDEXED_TEXT_CHARS = 8000

const DEFAULT_SEARCH_LIMIT = 20
/** `search()` clamps any requested `limit` to this maximum. */
export const MAX_SEARCH_LIMIT = 200

export type MemoryRecordKind = 'event' | 'fact'
export type MemoryTimeBasis = 'effective' | 'recorded'
export type MemoryOrder = 'relevance' | 'recency'

/**
 * A stable identity for one indexed record (issues/021-advanced-memory.md):
 * an event is `event:<spaceId>/<file>#<line>` — the Event log is
 * append-only (ADR-0003), so a file plus its 1-based line number never
 * changes meaning. A fact is `fact:<spaceId>/<recordId>` — `FACTS.md` is
 * rewritten on every write, so a fact's identity cannot be its position and
 * instead comes from `factRecordIds` (`facts.ts`), which both this module
 * and `dereference` compute the same way so they can never disagree about
 * what an id means.
 */
export type MemorySourceRef =
  | { kind: 'event'; spaceId: string; file: string; line: number }
  | { kind: 'fact'; spaceId: string; recordId: string }

// The file component is constrained to the exact `log/` directory naming
// convention (`SpacesEngine.logPath`'s `${at.slice(0, 10)}.jsonl`), not the
// permissive `[^#]+` a broader pattern would need: only index-generated refs
// are ever dereferenced today (`reconcile()` also checks the source ref's
// space against its own window before trusting it), but a wider file group
// would make `event:spc-health/../../../../etc/passwd#1` parse successfully,
// and `readLogLine`/`readLogPrefixHash` join that component onto a path
// unvalidated (docs/SECURITY.md's threat model on untrusted input reaching a
// filesystem join).
const EVENT_REF_RE = /^event:([^/]+)\/(\d{4}-\d{2}-\d{2}\.jsonl)#(\d+)$/
const FACT_REF_RE = /^fact:([^/]+)\/(.+)$/

/** The one place the `event:.../...#...` / `fact:.../...` text format is written. */
export function formatSourceRef(ref: MemorySourceRef): string {
  return ref.kind === 'event'
    ? `event:${ref.spaceId}/${ref.file}#${ref.line}`
    : `fact:${ref.spaceId}/${ref.recordId}`
}

/** The one place the source-ref text format is parsed. `undefined` for anything malformed. */
export function parseSourceRef(sourceRef: string): MemorySourceRef | undefined {
  const eventMatch = EVENT_REF_RE.exec(sourceRef)
  if (eventMatch) {
    const spaceId = eventMatch[1]
    const file = eventMatch[2]
    const lineText = eventMatch[3]
    if (spaceId === undefined || file === undefined || lineText === undefined) return undefined
    const line = Number(lineText)
    return Number.isInteger(line) && line > 0 ? { kind: 'event', spaceId, file, line } : undefined
  }
  const factMatch = FACT_REF_RE.exec(sourceRef)
  if (factMatch) {
    const spaceId = factMatch[1]
    const recordId = factMatch[2]
    if (spaceId === undefined || recordId === undefined) return undefined
    return { kind: 'fact', spaceId, recordId }
  }
  return undefined
}

const DATABASE_FILE = 'memory.sqlite'
/** SQLite's write-ahead-log companions: part of the database, so they go together. */
const DATABASE_COMPANION_SUFFIXES = ['', '-wal', '-shm']

/** The index's file, so no caller has to spell the name itself. */
export function memoryDatabasePath(rootDir: string): string {
  return join(rootDir, DATABASE_FILE)
}

/**
 * Deletes the index's files — the database plus its `-wal`/`-shm` companions.
 * The caller must `close()` the index first: on Unix an unlinked-but-open
 * database keeps being used by the live connection, so deleting without
 * closing looks like it worked and changes nothing. Exported because both the
 * `memory-index` CLI's rebuild and the daemon's corrupt-file recovery need it,
 * and which files constitute the database is knowledge that belongs here
 * rather than in either caller. Safe by construction: the index is disposable
 * (`docs/adr/0011-disposable-hybrid-index.md`) and rebuilds from the files.
 */
export function removeMemoryDatabase(rootDir: string): void {
  for (const suffix of DATABASE_COMPANION_SUFFIXES) {
    const path = `${memoryDatabasePath(rootDir)}${suffix}`
    if (existsSync(path)) rmSync(path)
  }
}

export interface MemoryIndexOptions {
  rootDir: string
  spacesEngine: SpacesEngine
  now?: () => Date
}

export interface MemoryIndexRow {
  sourceRef: string
  spaceId: string
  kind: MemoryRecordKind
  recordedAt: string
  occurredAt?: string
  origin: Origin
  score: number
}

export interface MemorySearchParams {
  spaceId: string
  /** Already-tokenized, already-quoted FTS5 terms. The caller owns query parsing. */
  terms: string[]
  kind?: MemoryRecordKind
  from?: string
  to?: string
  timeBasis?: MemoryTimeBasis
  order?: MemoryOrder
  limit?: number
}

export type DereferenceResult =
  | { ok: true; kind: 'event'; sourceRef: string; event: SpaceEvent }
  | {
      ok: true
      kind: 'fact'
      sourceRef: string
      fact: FactRecord
      state: 'active' | 'dormant' | 'superseded'
    }
  | { ok: false; reason: 'stale' | 'missing' }

interface StoredCursor {
  indexedBytes: number
  indexedLines: number
  prefixHash: string
}

interface MemoryRecordInsert {
  sourceRef: string
  spaceId: string
  kind: MemoryRecordKind
  recordedAt: string
  occurredAt?: string
  origin: Origin
  hash: string
  text: string
}

export class MemoryIndex {
  private readonly db: DatabaseSync
  private readonly spacesEngine: SpacesEngine
  private readonly now: () => Date
  private readonly unsubscribe: () => void

  constructor(options: MemoryIndexOptions) {
    mkdirSync(options.rootDir, { recursive: true })
    this.db = new DatabaseSync(join(options.rootDir, 'memory.sqlite'))
    this.spacesEngine = options.spacesEngine
    this.now = options.now ?? (() => new Date())
    this.initializeSchema()
    // Keeps the index current without waiting for the next boot's
    // `reconcile()`: `onMemoryWrite` (spaces-engine.ts) fires only after an
    // append actually landed on disk, so indexing here can never run ahead
    // of the file it reads from.
    this.unsubscribe = this.spacesEngine.onMemoryWrite((notice) => {
      if (notice.kind === 'event') this.indexSpaceEvents(notice.spaceId)
      else this.indexSpaceFacts(notice.spaceId)
    })
  }

  /**
   * Boot-time (and on-demand) reconciliation against the files
   * (issues/021-advanced-memory.md): the hard part is that a record the
   * index never learned about simply never matches, so this walks the
   * complete inventory in both directions rather than relying on
   * per-hit validation to notice a gap.
   *
   * 1. A missing or stale `schema_version` throws the whole index away and
   *    rebuilds — the index is disposable by design, so this replaces a
   *    migration framework entirely.
   * 2. For every Space and every log file: no cursor indexes the whole file;
   *    a shrunk file (an append-only log cannot legitimately get smaller) or
   *    a changed prefix hash (a restored file with different content at the
   *    same length) deletes that file's records and reindexes from scratch;
   *    otherwise only the tail past the cursor is indexed.
   * 3. Every Space's FACTS is reindexed wholesale — bounded by design, so a
   *    whole-file reindex is cheaper and safer than cursor bookkeeping over
   *    a file that gets rewritten on every write.
   * 4. Orphans are pruned: records/cursors for a Space or log file that no
   *    longer exists, and records for a file whose highest indexed line
   *    exceeds the file's current line count (the index was restored ahead
   *    of the files it describes).
   */
  reconcile(): void {
    const storedVersion = this.readMeta('schema_version')
    if (storedVersion !== String(SCHEMA_VERSION)) {
      this.rebuild()
      return
    }

    const spaces = this.spacesEngine.listAllSpaces()

    for (const space of spaces) {
      for (const file of this.spacesEngine.listLogFiles(space.id)) {
        this.reconcileFile(space.id, file)
        const cursor = this.readCursor(space.id, file.file)
        if (cursor) this.pruneRecordsBeyondLineCount(space.id, file.file, cursor.indexedLines)
      }
    }

    for (const space of spaces) this.indexSpaceFacts(space.id)

    this.pruneOrphans(spaces)
  }

  /** Discards every row and reindexes every Space from scratch. The disposable index's only "migration". */
  rebuild(): void {
    withImmediateTransaction(this.db, () => {
      this.db.exec('delete from memory_fts')
      this.db.exec('delete from memory_records')
      this.db.exec('delete from memory_cursors')
      this.writeMeta('schema_version', String(SCHEMA_VERSION))
      this.writeMeta('built_at', this.now().toISOString())
    })
    for (const space of this.spacesEngine.listAllSpaces()) {
      this.indexSpaceEvents(space.id)
      this.indexSpaceFacts(space.id)
    }
  }

  /**
   * Indexes every log file's unindexed tail for one Space. Calling this
   * again with nothing new is a no-op — and, on the hot path, a cheap one:
   * `onMemoryWrite` (issues/021-advanced-memory.md) fires this after every
   * `appendEvent`, so a Space with many days of history must not pay for a
   * `readFileSync` of every untouched daily file on every single write. All
   * of this Space's cursors are read in one query, then a file whose current
   * `bytes` (from `listLogFiles`, already free — `statSync`, not a read) still
   * equals its cursor's `indexed_bytes` is skipped without ever touching the
   * file: nothing can have changed under a cursor that already accounts for
   * every byte on disk. This is the hot incremental-write-observer path, not
   * `reconcile()`'s paranoid one — it trusts that a cursor matching the
   * current size means nothing changed underneath, which is safe here
   * because the only writer of this Space's own log files is this same
   * process's `SpacesEngine.appendEvent`. `reconcile()` still re-verifies
   * `prefix_hash` on every boot to catch a file restored to a different
   * content at the same length (a backup restore, not a live append) —
   * that check is deliberately not duplicated here.
   */
  indexSpaceEvents(spaceId: string): void {
    const cursors = this.readCursorsForSpace(spaceId)
    for (const file of this.spacesEngine.listLogFiles(spaceId)) {
      const cursor = cursors.get(file.file)
      if (cursor !== undefined && cursor.indexedBytes === file.bytes) continue
      this.indexFileForward(spaceId, file.file, cursor)
    }
  }

  /**
   * Wholesale reindex of one Space's FACTS (issues/021-advanced-memory.md):
   * `FACTS.md` is rewritten on every write, so a cursor over it would be
   * meaningless — deleting and reinserting every `fact:` row for this Space
   * is what guarantees a supersede or a demotion leaves no orphaned row
   * pointing at an id that no longer exists.
   */
  indexSpaceFacts(spaceId: string): void {
    const document = this.spacesEngine.readFacts(spaceId)
    const fallbackDate = this.today()
    const recordIds = factRecordIds(document, fallbackDate)
    const rows: MemoryRecordInsert[] = []

    for (const facts of [document.active, document.dormant, document.superseded]) {
      for (const fact of facts) {
        const id = recordIds.get(fact)
        if (id === undefined) continue
        const recordedAt = normalizeIsoInstant(fact.noted ?? fallbackDate)
        if (recordedAt === undefined) continue
        rows.push({
          sourceRef: formatSourceRef({ kind: 'fact', spaceId, recordId: id }),
          spaceId,
          kind: 'fact',
          recordedAt,
          origin: fact.origin ?? 'trusted:system',
          hash: sha256(factIdentityLine(fact, fallbackDate)),
          text: fact.text.slice(0, MAX_INDEXED_TEXT_CHARS),
        })
      }
    }

    withImmediateTransaction(this.db, () => {
      this.deleteFactRecords(spaceId)
      for (const row of rows) this.insertRecord(row)
    })
  }

  /**
   * `terms` are already tokenized and owned by the caller; this only quotes
   * each one defensively before joining with ` OR ` so FTS5 syntax in a
   * term (`*`, `-`, `NEAR(`, a bare `"`) cannot change the query's meaning.
   * Empty `terms` returns `[]` without ever calling `MATCH ''`, which FTS5
   * rejects.
   */
  search(params: MemorySearchParams): MemoryIndexRow[] {
    if (params.terms.length === 0) return []

    const timeBasis = params.timeBasis ?? 'effective'
    const order = params.order ?? 'relevance'
    const limit = clampSearchLimit(params.limit)
    const clockExpr =
      timeBasis === 'effective' ? 'coalesce(mr.occurred_at, mr.recorded_at)' : 'mr.recorded_at'

    const hitConditions = ['memory_fts match ?', 'mr.space_id = ?']
    const hitBindings: (string | number)[] = [
      params.terms.map(quoteFtsTerm).join(' OR '),
      params.spaceId,
    ]
    if (params.kind !== undefined) {
      hitConditions.push('mr.kind = ?')
      hitBindings.push(params.kind)
    }

    // Stored clocks are always normalized to a single `Z`-offset instant
    // (see `insertEventEntry`/`indexSpaceFacts`) because the range filter and
    // the recency sort below compare them lexically
    // (docs/adr/0011-disposable-hybrid-index.md's "Determinism" section). An
    // explicit bound must go through the same normalization or a
    // same-instant-different-offset value (`+02:00` against a stored `Z`)
    // would compare as a different, wrong instant and silently drop matching
    // rows. A bound that fails to parse is a caller error, not something to
    // paper over: a silently-dropped filter would return too much, which is
    // worse than refusing the query outright.
    const rangeConditions: string[] = []
    const rangeBindings: string[] = []
    if (params.from !== undefined) {
      const from = normalizeIsoInstant(params.from)
      if (from === undefined) {
        throw new Error(`memory search: "from" is not a valid ISO instant: ${params.from}`)
      }
      rangeConditions.push('clock >= ?')
      rangeBindings.push(from)
    }
    if (params.to !== undefined) {
      const to = normalizeIsoInstant(params.to)
      if (to === undefined) {
        throw new Error(`memory search: "to" is not a valid ISO instant: ${params.to}`)
      }
      rangeConditions.push('clock < ?')
      rangeBindings.push(to)
    }

    // FTS5's bm25() scores a BETTER match MORE NEGATIVE, so ascending is
    // best-first — easy to get backwards. `recency` sorts on the same
    // `clock` expression the range filter above used, so "most recent"
    // cannot mean a different notion of time than what was just filtered
    // on. Never `order by rowid`: both orders end in `source_ref`, so the
    // ordering is total and a rebuilt index reproduces it exactly.
    const orderClause =
      order === 'relevance'
        ? 'score asc, clock desc, source_ref asc'
        : 'clock desc, score asc, source_ref asc'

    const sql = `
      with hits as (
        select
          mr.source_ref as source_ref,
          mr.space_id as space_id,
          mr.kind as kind,
          mr.recorded_at as recorded_at,
          mr.occurred_at as occurred_at,
          mr.origin as origin,
          bm25(memory_fts) as score,
          ${clockExpr} as clock
        from memory_fts
        join memory_records as mr on mr.source_ref = memory_fts.source_ref
        where ${hitConditions.join(' and ')}
      )
      select source_ref, space_id, kind, recorded_at, occurred_at, origin, score
      from hits
      ${rangeConditions.length > 0 ? `where ${rangeConditions.join(' and ')}` : ''}
      order by ${orderClause}
      limit ?
    `

    const rows = this.db.prepare(sql).all(...hitBindings, ...rangeBindings, limit)
    return rows.map(rowToMemoryIndexRow)
  }

  /**
   * Resolves a source reference back to the original record, never the
   * indexed text. An event re-reads its exact log line and refuses to
   * return anything whose sha256 no longer matches what was indexed — a
   * wrong record is worse than none. A fact recomputes `factRecordIds` over
   * the current `FACTS.md` and, since a byte-identical fact can legitimately
   * exist in more than one section (docs/adr/0006-file-based-memory.md:
   * demotion and superseding both preserve the record rather than deleting
   * it), prefers `active`, then `dormant`, then `superseded`.
   */
  dereference(sourceRef: string): DereferenceResult {
    const parsed = parseSourceRef(sourceRef)
    if (!parsed) return { ok: false, reason: 'missing' }
    if (!this.spacesEngine.getSpace(parsed.spaceId)) return { ok: false, reason: 'missing' }
    return parsed.kind === 'event'
      ? this.dereferenceEvent(parsed, sourceRef)
      : this.dereferenceFact(parsed, sourceRef)
  }

  recordCount(spaceId?: string): number {
    const row =
      spaceId === undefined
        ? this.db.prepare('select count(*) as n from memory_records').get()
        : this.db
            .prepare('select count(*) as n from memory_records where space_id = ?')
            .get(spaceId)
    return row ? requiredNumber(row, 'n') : 0
  }

  status(): {
    schemaVersion: number
    builtAt?: string
    records: { spaceId: string; events: number; facts: number }[]
  } {
    const storedVersion = this.readMeta('schema_version')
    const schemaVersion = storedVersion === undefined ? SCHEMA_VERSION : Number(storedVersion)
    const builtAt = this.readMeta('built_at')

    const rows = this.db
      .prepare('select space_id, kind, count(*) as n from memory_records group by space_id, kind')
      .all()
    const bySpace = new Map<string, { events: number; facts: number }>()
    for (const row of rows) {
      const spaceId = requiredString(row, 'space_id')
      const kind = requiredString(row, 'kind')
      const n = requiredNumber(row, 'n')
      const entry = bySpace.get(spaceId) ?? { events: 0, facts: 0 }
      if (kind === 'event') entry.events = n
      else if (kind === 'fact') entry.facts = n
      bySpace.set(spaceId, entry)
    }

    const records = [...bySpace.entries()]
      .map(([spaceId, counts]) => ({ spaceId, ...counts }))
      .sort((left, right) => left.spaceId.localeCompare(right.spaceId))

    return { schemaVersion, ...(builtAt === undefined ? {} : { builtAt }), records }
  }

  close(): void {
    this.unsubscribe()
    this.db.close()
  }

  // --- internals ---

  private reconcileFile(spaceId: string, file: { file: string; bytes: number }): void {
    const cursor = this.readCursor(spaceId, file.file)
    if (cursor) {
      const shrank = file.bytes < cursor.indexedBytes
      const prefixChanged =
        !shrank &&
        this.spacesEngine.readLogPrefixHash(spaceId, file.file, cursor.indexedBytes) !==
          cursor.prefixHash
      if (shrank || prefixChanged) this.deleteFileRecords(spaceId, file.file)
    }
    // Whether the cursor above was just deleted (fresh reindex from byte 0)
    // or left alone (a normal tail catch-up), `indexFileForward` reads
    // whatever cursor exists right now, so one call handles both cases.
    this.indexFileForward(spaceId, file.file)
  }

  /**
   * `knownCursor` lets `indexSpaceEvents` pass the cursor it already fetched
   * in its one bulk query instead of this method issuing a second lookup for
   * a file it has already decided needs reindexing; `reconcileFile` omits it
   * and gets a fresh read, which matters right after it may have just
   * deleted that same cursor's records.
   */
  private indexFileForward(spaceId: string, file: string, knownCursor?: StoredCursor): void {
    let cursor = knownCursor ?? this.readCursor(spaceId, file)
    // Before extending a cursor, confirm the bytes it already covers are still
    // the bytes it covered. Skipping this would let a mutated prefix be blessed
    // by the tail write below, which stores a hash of the *new* full file: from
    // then on `reconcile()` compares against that hash, agrees, and never
    // repairs the stale rows. Only the file actually being written is hashed
    // here, so untouched files still cost nothing.
    if (cursor !== undefined && cursor.indexedBytes > 0) {
      const currentPrefix = this.spacesEngine.readLogPrefixHash(spaceId, file, cursor.indexedBytes)
      if (currentPrefix !== cursor.prefixHash) {
        this.deleteFileRecords(spaceId, file)
        cursor = undefined
      }
    }

    const fromByte = cursor?.indexedBytes ?? 0
    const fromLine = cursor?.indexedLines ?? 0
    const { entries, bytes, lines } = this.spacesEngine.readLogEntriesFrom(
      spaceId,
      file,
      fromByte,
      fromLine,
    )
    if (bytes === fromByte) return // Nothing past the cursor to index.

    const prefixHash = this.spacesEngine.readLogPrefixHash(spaceId, file, bytes)
    // One transaction for the new records, their FTS rows, and the cursor
    // advance together: a cursor committed without its rows would make the
    // gap invisible to every later `reconcile()`, since nothing would ever
    // look at those bytes again.
    withImmediateTransaction(this.db, () => {
      for (const entry of entries) this.insertEventEntry(spaceId, file, entry)
      this.writeCursor(spaceId, file, { indexedBytes: bytes, indexedLines: lines, prefixHash })
    })
  }

  private insertEventEntry(
    spaceId: string,
    file: string,
    entry: { line: number; raw: string; event: SpaceEvent },
  ): void {
    const recordedAt = normalizeIsoInstant(entry.event.at)
    if (recordedAt === undefined) return // Unparseable timestamp: skip rather than store garbage.
    const occurredAt = normalizeIsoInstant(entry.event.occurredAt)
    this.insertRecord({
      sourceRef: formatSourceRef({ kind: 'event', spaceId, file, line: entry.line }),
      spaceId,
      kind: 'event',
      recordedAt,
      ...(occurredAt === undefined ? {} : { occurredAt }),
      origin: entry.event.origin,
      hash: sha256(entry.raw),
      text: buildEventSearchText(entry.event),
    })
  }

  private dereferenceEvent(
    parsed: { spaceId: string; file: string; line: number },
    sourceRef: string,
  ): DereferenceResult {
    const raw = this.spacesEngine.readLogLine(parsed.spaceId, parsed.file, parsed.line)
    if (raw === undefined) return { ok: false, reason: 'missing' }

    const storedRow = this.db
      .prepare('select hash from memory_records where source_ref = ?')
      .get(sourceRef)
    if (!storedRow) return { ok: false, reason: 'missing' }
    if (sha256(raw) !== requiredString(storedRow, 'hash')) return { ok: false, reason: 'stale' }

    const event = parseSpaceEventLine(raw)
    // Should not happen for a hash that just matched (the line was already
    // parseable when it was indexed) — kept as a defensive fallback rather
    // than a throw, since a wrong answer is worse than a refused one.
    if (!event) return { ok: false, reason: 'missing' }
    return { ok: true, kind: 'event', sourceRef, event }
  }

  private dereferenceFact(
    parsed: { spaceId: string; recordId: string },
    sourceRef: string,
  ): DereferenceResult {
    const document = this.spacesEngine.readFacts(parsed.spaceId)
    const found = findFactById(document, this.today(), parsed.recordId)
    if (!found) return { ok: false, reason: 'stale' }
    return { ok: true, kind: 'fact', sourceRef, fact: found.fact, state: found.state }
  }

  private pruneRecordsBeyondLineCount(spaceId: string, file: string, maxLine: number): void {
    const pattern = eventRefLikePattern(spaceId, file)
    const rows = this.db
      .prepare(
        `select source_ref from memory_records where space_id = ? and source_ref like ? escape '\\'`,
      )
      .all(spaceId, pattern)
    const stale = rows
      .map((row) => requiredString(row, 'source_ref'))
      .filter((sourceRef) => {
        const parsed = parseSourceRef(sourceRef)
        return parsed?.kind === 'event' && parsed.line > maxLine
      })
    if (stale.length === 0) return

    withImmediateTransaction(this.db, () => {
      const deleteFts = this.db.prepare('delete from memory_fts where source_ref = ?')
      const deleteRecord = this.db.prepare('delete from memory_records where source_ref = ?')
      for (const sourceRef of stale) {
        deleteFts.run(sourceRef)
        deleteRecord.run(sourceRef)
      }
    })
  }

  private pruneOrphans(spaces: { id: string }[]): void {
    const currentSpaceIds = new Set(spaces.map((space) => space.id))
    const filesBySpace = new Map(
      spaces.map((space) => [
        space.id,
        new Set(this.spacesEngine.listLogFiles(space.id).map((file) => file.file)),
      ]),
    )

    const recordRows = this.db.prepare('select space_id, source_ref from memory_records').all()
    const orphanSpaceIds = new Set<string>()
    const orphanFileKeys = new Set<string>()
    for (const row of recordRows) {
      const spaceId = requiredString(row, 'space_id')
      const sourceRef = requiredString(row, 'source_ref')
      if (!currentSpaceIds.has(spaceId)) {
        orphanSpaceIds.add(spaceId)
        continue
      }
      const parsed = parseSourceRef(sourceRef)
      if (parsed?.kind === 'event' && !(filesBySpace.get(spaceId)?.has(parsed.file) ?? false)) {
        orphanFileKeys.add(cursorKey(spaceId, parsed.file))
      }
    }
    for (const spaceId of orphanSpaceIds) this.deleteAllForSpace(spaceId)
    for (const key of orphanFileKeys) {
      const parsed = parseCursorKey(key)
      if (parsed) this.deleteFileRecords(parsed.spaceId, parsed.file)
    }

    const cursorRows = this.db.prepare('select source from memory_cursors').all()
    const staleCursorSources: string[] = []
    for (const row of cursorRows) {
      const source = requiredString(row, 'source')
      const parsed = parseCursorKey(source)
      const stillValid =
        parsed !== undefined &&
        currentSpaceIds.has(parsed.spaceId) &&
        (filesBySpace.get(parsed.spaceId)?.has(parsed.file) ?? false)
      if (!stillValid) staleCursorSources.push(source)
    }
    // One transaction for every stale cursor, rather than one per row: a
    // Space with many days of orphaned log-file cursors otherwise pays for a
    // transaction per file at every boot's reconcile().
    if (staleCursorSources.length > 0) {
      withImmediateTransaction(this.db, () => {
        const deleteCursor = this.db.prepare('delete from memory_cursors where source = ?')
        for (const source of staleCursorSources) deleteCursor.run(source)
      })
    }
  }

  private deleteAllForSpace(spaceId: string): void {
    withImmediateTransaction(this.db, () => {
      this.db
        .prepare(
          'delete from memory_fts where source_ref in (select source_ref from memory_records where space_id = ?)',
        )
        .run(spaceId)
      this.db.prepare('delete from memory_records where space_id = ?').run(spaceId)
    })
  }

  private deleteFileRecords(spaceId: string, file: string): void {
    const pattern = eventRefLikePattern(spaceId, file)
    withImmediateTransaction(this.db, () => {
      this.db
        .prepare(
          `delete from memory_fts where source_ref in (select source_ref from memory_records where space_id = ? and source_ref like ? escape '\\')`,
        )
        .run(spaceId, pattern)
      this.db
        .prepare(`delete from memory_records where space_id = ? and source_ref like ? escape '\\'`)
        .run(spaceId, pattern)
      this.db.prepare('delete from memory_cursors where source = ?').run(cursorKey(spaceId, file))
    })
  }

  private deleteFactRecords(spaceId: string): void {
    this.db
      .prepare(
        `delete from memory_fts where source_ref in (select source_ref from memory_records where space_id = ? and kind = 'fact')`,
      )
      .run(spaceId)
    this.db.prepare(`delete from memory_records where space_id = ? and kind = 'fact'`).run(spaceId)
  }

  private insertRecord(row: MemoryRecordInsert): void {
    // A source ref is re-inserted (never appended twice): `insert or
    // replace` handles the `memory_records` row's primary key, and the FTS
    // row is deleted first since FTS5 has no such upsert of its own.
    this.db.prepare('delete from memory_fts where source_ref = ?').run(row.sourceRef)
    this.db
      .prepare(
        `insert into memory_records (source_ref, space_id, kind, recorded_at, occurred_at, origin, hash)
         values (?, ?, ?, ?, ?, ?, ?)
         on conflict(source_ref) do update set
           space_id = excluded.space_id,
           kind = excluded.kind,
           recorded_at = excluded.recorded_at,
           occurred_at = excluded.occurred_at,
           origin = excluded.origin,
           hash = excluded.hash`,
      )
      .run(
        row.sourceRef,
        row.spaceId,
        row.kind,
        row.recordedAt,
        row.occurredAt ?? null,
        row.origin,
        row.hash,
      )
    this.db
      .prepare('insert into memory_fts (text, source_ref) values (?, ?)')
      .run(row.text, row.sourceRef)
  }

  /**
   * Every cursor for one Space, in a single query, keyed by file name — the
   * bulk read `indexSpaceEvents` uses to decide which files to skip without
   * a per-file round trip.
   */
  private readCursorsForSpace(spaceId: string): Map<string, StoredCursor> {
    const pattern = `${escapeLike(spaceId)}/%`
    const rows = this.db
      .prepare(`select * from memory_cursors where source like ? escape '\\'`)
      .all(pattern)
    const cursors = new Map<string, StoredCursor>()
    for (const row of rows) {
      const source = requiredString(row, 'source')
      const parsed = parseCursorKey(source)
      if (parsed === undefined || parsed.spaceId !== spaceId) continue
      cursors.set(parsed.file, {
        indexedBytes: requiredNumber(row, 'indexed_bytes'),
        indexedLines: requiredNumber(row, 'indexed_lines'),
        prefixHash: requiredString(row, 'prefix_hash'),
      })
    }
    return cursors
  }

  private readCursor(spaceId: string, file: string): StoredCursor | undefined {
    const row = this.db
      .prepare('select * from memory_cursors where source = ?')
      .get(cursorKey(spaceId, file))
    if (!row) return undefined
    return {
      indexedBytes: requiredNumber(row, 'indexed_bytes'),
      indexedLines: requiredNumber(row, 'indexed_lines'),
      prefixHash: requiredString(row, 'prefix_hash'),
    }
  }

  private writeCursor(spaceId: string, file: string, cursor: StoredCursor): void {
    this.db
      .prepare(
        `insert into memory_cursors (source, indexed_bytes, indexed_lines, prefix_hash) values (?, ?, ?, ?)
         on conflict(source) do update set
           indexed_bytes = excluded.indexed_bytes,
           indexed_lines = excluded.indexed_lines,
           prefix_hash = excluded.prefix_hash`,
      )
      .run(cursorKey(spaceId, file), cursor.indexedBytes, cursor.indexedLines, cursor.prefixHash)
  }

  private readMeta(key: string): string | undefined {
    const row = this.db.prepare('select value from memory_meta where key = ?').get(key)
    return row ? optionalString(row, 'value') : undefined
  }

  private writeMeta(key: string, value: string): void {
    this.db
      .prepare(
        `insert into memory_meta (key, value) values (?, ?)
         on conflict(key) do update set value = excluded.value`,
      )
      .run(key, value)
  }

  private today(): string {
    return this.now().toISOString().slice(0, 10)
  }

  private initializeSchema(): void {
    this.db.exec(`
      pragma journal_mode = wal;

      create table if not exists memory_meta (
        key text primary key,
        value text not null
      );

      create table if not exists memory_records (
        source_ref  text primary key,
        space_id    text not null,
        kind        text not null check (kind in ('event', 'fact')),
        recorded_at text not null,
        occurred_at text,
        origin      text not null,
        hash        text not null
      );
      create index if not exists memory_records_space_time on memory_records (space_id, recorded_at);

      create table if not exists memory_cursors (
        source        text primary key,
        indexed_bytes integer not null,
        indexed_lines integer not null,
        prefix_hash   text not null
      );

      create virtual table if not exists memory_fts using fts5(
        text,
        source_ref unindexed,
        tokenize = 'porter unicode61 remove_diacritics 2'
      );
    `)
  }
}

/**
 * The searchable text for one Event log entry: its `type`, its `text`, and
 * every string leaf of its `payload`, walking arrays and nested objects.
 * This is also the fact-augmentation layer named in
 * issues/021-advanced-memory.md and ADR-0006: a `reader.summary` event's
 * `payload.reader` object (`quarantined-reader.ts`'s `ReaderOutputSchema` —
 * subject, sender, entities, deadlines, urgency, intent, summary) is walked
 * by the same generic string-leaf traversal used for every other event, so
 * those extracted fields become searchable terms attributed to this event's
 * own source ref. The extraction indexes; the log line this ref points at
 * remains the record `dereference` returns.
 */
function buildEventSearchText(event: SpaceEvent): string {
  const parts = [event.type, event.text, ...collectStringLeaves(event.payload)]
  return parts.join(' ').slice(0, MAX_INDEXED_TEXT_CHARS)
}

function collectStringLeaves(value: JsonValue | undefined, out: string[] = []): string[] {
  if (value === undefined || value === null) return out
  if (typeof value === 'string') {
    out.push(value)
  } else if (Array.isArray(value)) {
    for (const item of value) collectStringLeaves(item, out)
  } else if (typeof value === 'object') {
    for (const item of Object.values(value)) collectStringLeaves(item, out)
  }
  return out
}

/**
 * Finds the record `id` (per `factRecordIds`, facts.ts) identifies, walking
 * `active` before `dormant` before `superseded`: a byte-identical record
 * can legitimately exist in more than one section, and this is the
 * documented tie-break — an active fact wins over a dormant or superseded
 * copy of the same text.
 */
function findFactById(
  document: FactsDocument,
  fallbackDate: string,
  id: string,
): { fact: FactRecord; state: 'active' | 'dormant' | 'superseded' } | undefined {
  const recordIds = factRecordIds(document, fallbackDate)
  const sections: { state: 'active' | 'dormant' | 'superseded'; facts: FactRecord[] }[] = [
    { state: 'active', facts: document.active },
    { state: 'dormant', facts: document.dormant },
    { state: 'superseded', facts: document.superseded },
  ]
  for (const { state, facts } of sections) {
    for (const fact of facts) {
      if (recordIds.get(fact) === id) return { fact, state }
    }
  }
  return undefined
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function cursorKey(spaceId: string, file: string): string {
  return `${spaceId}/${file}`
}

/** The inverse of `cursorKey`: splits `<spaceId>/<file>` back apart. `undefined` for a key with no separator. */
function parseCursorKey(key: string): { spaceId: string; file: string } | undefined {
  const slash = key.indexOf('/')
  if (slash === -1) return undefined
  return { spaceId: key.slice(0, slash), file: key.slice(slash + 1) }
}

/** Escapes `%`, `_`, and `\` for a `like ... escape '\'` pattern. */
function escapeLike(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')
}

/**
 * The `escape '\'` LIKE pattern matching every event source ref for one log
 * file: `formatSourceRef`'s `event:<spaceId>/<file>#<line>` format with the
 * line number wildcarded. The one place that pattern is written, shared by
 * `pruneRecordsBeyondLineCount` (finding stale rows past a file's current
 * line count) and `deleteFileRecords` (deleting every row for a file being
 * reindexed from scratch) instead of each hardcoding it separately.
 */
function eventRefLikePattern(spaceId: string, file: string): string {
  return `event:${escapeLike(spaceId)}/${escapeLike(file)}#%`
}

/**
 * Defensive quoting for a caller-supplied FTS5 term: doubling an embedded
 * `"` and wrapping the whole term in quotes makes FTS5 treat it as one
 * literal phrase, so a term containing FTS5 query syntax (`*`, `-`,
 * `NEAR(`) cannot change the query's meaning. `MemorySearchParams.terms` is
 * documented as already tokenized by the caller, but this module must not
 * rely on that alone.
 */
function quoteFtsTerm(term: string): string {
  return `"${term.replace(/"/g, '""')}"`
}

function clampSearchLimit(limit: number | undefined): number {
  const requested = limit === undefined ? DEFAULT_SEARCH_LIMIT : Math.trunc(limit)
  return Math.min(Math.max(1, requested), MAX_SEARCH_LIMIT)
}

function rowToMemoryIndexRow(row: Record<string, unknown>): MemoryIndexRow {
  const kind = requiredString(row, 'kind')
  if (kind !== 'event' && kind !== 'fact') throw new Error(`unexpected memory record kind: ${kind}`)
  const origin = requiredString(row, 'origin')
  if (!isValidOrigin(origin)) throw new Error(`unexpected memory record origin: ${origin}`)
  const occurredAt = optionalString(row, 'occurred_at')
  return {
    sourceRef: requiredString(row, 'source_ref'),
    spaceId: requiredString(row, 'space_id'),
    kind,
    recordedAt: requiredString(row, 'recorded_at'),
    ...(occurredAt === undefined ? {} : { occurredAt }),
    origin,
    score: requiredNumber(row, 'score'),
  }
}
