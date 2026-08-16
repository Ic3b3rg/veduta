import { mkdtemp } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { GatewayServerMessageSchema, type GatewayServerMessage } from '@veduta/protocol'
import { describe, expect, it } from 'vitest'
import { parseSpaceEventLine } from '../spaces-engine.ts'
import { SurfaceEngine, type SurfaceEngineEvent } from '../surface-engine.ts'

/**
 * The append-only fixture corpus (issues/043-self-update.md AC5,
 * docs/adr/0013-signed-self-update.md's two-data-regimes rationale for
 * tolerant append-only readers): every historical raw shape ever written to
 * `surface_events` or a Space's Event log, frozen forever in
 * `fixtures/corpus/` (see its README). This test is the
 * mutation-proof for the row-reader tolerance in `surface-engine.ts`: strip
 * that tolerance and `surfaceEventsAfter` throws on the pre-freshness rows
 * below, this whole suite goes red, and the freshness-specific assertion
 * further down never runs.
 */
const corpusDir = fileURLToPath(new URL('./fixtures/corpus', import.meta.url))

interface SurfaceEventCorpusRow {
  cursor: number
  at: string
  spaceId: string
  surfaceId: string
  kind: 'patch' | 'created' | 'archived' | 'pinned' | 'moved'
  event: unknown
}

const SURFACE_EVENT_CORPUS_FILES = [
  'surface-event-patch-pre-freshness.json',
  'surface-event-pinned-pre-freshness.json',
  'surface-event-patch-current.json',
  'surface-event-pinned-current.json',
  'surface-event-created-current.json',
  'surface-event-archived-current.json',
  'surface-event-created-order-v1.json',
  'surface-event-pinned-order-v1.json',
  'surface-event-moved-order-v1.json',
  'surface-event-archived-order-v1.json',
] as const

function readCorpusJson(name: string): SurfaceEventCorpusRow {
  return JSON.parse(readFileSync(join(corpusDir, name), 'utf8')) as SurfaceEventCorpusRow
}

/**
 * The one place a `SurfaceEngineEvent` becomes a Gateway server frame,
 * replicated from `gateway.ts`'s private `surfaceEventFrame` (not exported —
 * it is an internal wiring detail of the Gateway hub, not a public seam)
 * so this test can prove every corpus row round-trips through the exact
 * wire schema (`GatewayServerMessageSchema`) a real hello replay sends it
 * through.
 */
function frameFor(event: SurfaceEngineEvent): GatewayServerMessage {
  if (event.kind === 'created') return { type: 'surface.created', event: event.event }
  if (event.kind === 'archived') return { type: 'surface.archived', event: event.event }
  if (event.kind === 'pinned') return { type: 'surface.pinned', event: event.event }
  if (event.kind === 'moved') return { type: 'surface.moved', event: event.event }
  return { type: 'surface.patch', event: event.event }
}

async function tempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'veduta-corpus-'))
}

/** Inserts a corpus row directly into `surface_events`, bypassing every write path the engine itself uses — this is what makes the row a faithful stand-in for data a past version actually persisted. */
function insertCorpusRow(db: DatabaseSync, row: SurfaceEventCorpusRow): void {
  db.prepare(
    `insert into surface_events (cursor, at, space_id, surface_id, kind, event_json)
     values (?, ?, ?, ?, ?, ?)`,
  ).run(row.cursor, row.at, row.spaceId, row.surfaceId, row.kind, JSON.stringify(row.event))
}

describe('fixture corpus — surface_events (AC5)', () => {
  it('replays every corpus row from cursor zero and round-trips it through the Gateway frame schema', async () => {
    const rootDir = await tempRoot()
    const engine = new SurfaceEngine({
      rootDir,
      now: () => new Date('2026-08-04T00:00:00.000Z'),
      hasSpace: () => true,
      appendSpaceEvent: () => undefined,
    })

    // A second connection to the same file (node:sqlite, WAL) is how a raw
    // historical row gets into the store without going through any writer
    // this engine version knows about — exactly the position a row written
    // by an old daemon binary is in.
    const rawDb = new DatabaseSync(join(rootDir, 'surfaces.sqlite'))
    for (const file of SURFACE_EVENT_CORPUS_FILES) insertCorpusRow(rawDb, readCorpusJson(file))
    rawDb.close()

    const replayed = engine.surfaceEventsAfter(0)
    expect(replayed).toHaveLength(SURFACE_EVENT_CORPUS_FILES.length)

    for (const event of replayed) {
      expect(() => GatewayServerMessageSchema.parse(frameFor(event))).not.toThrow()
    }
  })

  it('synthesizes freshness for the pre-freshness patch row with updatedBy "system"', async () => {
    const rootDir = await tempRoot()
    const engine = new SurfaceEngine({
      rootDir,
      now: () => new Date('2026-08-04T00:00:00.000Z'),
      hasSpace: () => true,
      appendSpaceEvent: () => undefined,
    })

    const rawDb = new DatabaseSync(join(rootDir, 'surfaces.sqlite'))
    insertCorpusRow(rawDb, readCorpusJson('surface-event-patch-pre-freshness.json'))
    rawDb.close()

    const [replayed] = engine.surfaceEventsAfter(0)
    if (!replayed || replayed.kind !== 'patch') throw new Error('expected a replayed patch event')
    // The mutation-proof (AC5): if the row-reader tolerance in
    // `surface-engine.ts` is stripped, `surfaceEventsAfter` above throws
    // before this line is ever reached, and the suite goes red.
    expect(replayed.event.freshness).toEqual({
      updatedAt: '2026-01-05T09:00:00.000Z',
      updatedBy: 'system',
    })
  })

  it('synthesizes freshness for the pre-freshness pinned row with updatedBy "system"', async () => {
    const rootDir = await tempRoot()
    const engine = new SurfaceEngine({
      rootDir,
      now: () => new Date('2026-08-04T00:00:00.000Z'),
      hasSpace: () => true,
      appendSpaceEvent: () => undefined,
    })

    const rawDb = new DatabaseSync(join(rootDir, 'surfaces.sqlite'))
    insertCorpusRow(rawDb, readCorpusJson('surface-event-pinned-pre-freshness.json'))
    rawDb.close()

    const [replayed] = engine.surfaceEventsAfter(0)
    if (!replayed || replayed.kind !== 'pinned') throw new Error('expected a replayed pinned event')
    expect(replayed.event.freshness).toEqual({
      updatedAt: '2026-01-06T09:00:00.000Z',
      updatedBy: 'system',
    })
  })
})

describe('fixture corpus — Space Event log (parseSpaceEventLine tolerance)', () => {
  it('parses the current and legacy-shaped lines, and drops the garbage line as undefined', () => {
    const lines = readFileSync(join(corpusDir, 'space-event-log.jsonl'), 'utf8').split('\n')
    const [current, legacy, garbage] = lines

    expect(parseSpaceEventLine(current ?? '')).toMatchObject({
      spaceId: 'spc-current',
      type: 'note.captured',
      text: 'Bought milk',
      origin: 'trusted:user',
    })

    expect(parseSpaceEventLine(legacy ?? '')).toMatchObject({
      spaceId: 'spc-legacy',
      type: 'note.captured',
      text: 'Legacy entry, no occurredAt or payload',
      origin: 'trusted:user',
    })

    // The Event log is append-only and never rewritten (ADR-0003/ADR-0006):
    // an unparseable line must disappear from the read, not throw and take
    // the rest of the file down with it.
    expect(parseSpaceEventLine(garbage ?? '')).toBeUndefined()
  })
})
