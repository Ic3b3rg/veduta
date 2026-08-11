import type { DatabaseSync } from 'node:sqlite'
import { optionalString, requiredNumber, requiredString } from './sqlite-rows.ts'
import { isValidOrigin, type Origin } from './taint.ts'

export type MemoryRecordKind = 'event' | 'fact'

export interface MemoryIndexRow {
  sourceRef: string
  spaceId: string
  kind: MemoryRecordKind
  recordedAt: string
  occurredAt?: string
  origin: Origin
  score: number
}

export function initializeMemoryIndexSchema(db: DatabaseSync): void {
  db.exec(`
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

export function memoryIndexRowFromRow(row: Record<string, unknown>): MemoryIndexRow {
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
