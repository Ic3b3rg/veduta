import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import {
  ensureSqliteColumn,
  optionalString,
  requiredNumber,
  requiredString,
} from './sqlite-rows.ts'
import { isValidOrigin, type Origin } from './taint.ts'

export const ConditionSchema = z.union([
  z.object({
    kind: z.literal('event-logged'),
    textIncludes: z.string().trim().min(1),
    withinHours: z.number().positive().max(720).default(24),
  }),
  z.object({
    kind: z.literal('judgment'),
    question: z.string().trim().min(1),
  }),
])

export type Condition = z.infer<typeof ConditionSchema>

export interface Automation {
  id: number
  kind: 'timer' | 'job'
  spaceId: string
  description: string
  enabled: boolean
  fireAt?: string
  cron?: string
  condition?: Condition
  nextRunAt?: string
  status: 'armed' | 'completed' | 'cancelled'
  lastRunAt?: string
  lastOutcome?: string
  createdAt: string
  /** Origin of the creating turn. Missing legacy values are trusted system data. */
  origin?: Origin
  /** Registered internal handler; absent for ordinary user Automations. */
  handler?: string
  targetSurfaceId?: string
  /** IANA zone for daemon-managed cron jobs; absent means UTC. */
  timezone?: string
}

export function initializeSchedulerSchema(db: DatabaseSync): void {
  db.exec(`
    pragma journal_mode = wal;
    create table if not exists automations (
      id integer primary key autoincrement,
      kind text not null check (kind in ('timer', 'job')),
      space_id text not null,
      description text not null,
      enabled integer not null default 1,
      fire_at text,
      cron text,
      condition_json text,
      next_run_at text,
      status text not null default 'armed'
        check (status in ('armed', 'completed', 'cancelled')),
      last_run_at text,
      last_outcome text,
      created_at text not null,
      origin text,
      handler text,
      target_surface_id text,
      timezone text
    );
    create index if not exists automations_due
      on automations (status, next_run_at);

    create table if not exists automation_runs (
      automation_id integer not null references automations(id),
      scheduled_for text not null,
      started_at text not null,
      outcome text,
      finished_at text,
      primary key (automation_id, scheduled_for)
    );
  `)

  // `create table if not exists` does not migrate databases from older
  // versions, so additive columns are ensured explicitly.
  ensureSqliteColumn(db, 'automations', 'origin', 'text')
  ensureSqliteColumn(db, 'automations', 'handler', 'text')
  ensureSqliteColumn(db, 'automations', 'target_surface_id', 'text')
  ensureSqliteColumn(db, 'automations', 'timezone', 'text')
}

export function automationFromRow(row: Record<string, unknown>): Automation {
  const conditionJson = optionalString(row, 'condition_json')
  const fireAt = optionalString(row, 'fire_at')
  const cron = optionalString(row, 'cron')
  const nextRunAt = optionalString(row, 'next_run_at')
  const lastRunAt = optionalString(row, 'last_run_at')
  const lastOutcome = optionalString(row, 'last_outcome')
  const status = requiredString(row, 'status')
  const kind = requiredString(row, 'kind')
  const originValue = optionalString(row, 'origin')
  const origin = originValue !== undefined && isValidOrigin(originValue) ? originValue : undefined
  const handler = optionalString(row, 'handler')
  const targetSurfaceId = optionalString(row, 'target_surface_id')
  const timezone = optionalString(row, 'timezone')
  if (status !== 'armed' && status !== 'completed' && status !== 'cancelled') {
    throw new Error(`unexpected automation status: ${status}`)
  }
  if (kind !== 'timer' && kind !== 'job') throw new Error(`unexpected automation kind: ${kind}`)
  return {
    id: requiredNumber(row, 'id'),
    kind,
    spaceId: requiredString(row, 'space_id'),
    description: requiredString(row, 'description'),
    enabled: requiredNumber(row, 'enabled') === 1,
    status,
    createdAt: requiredString(row, 'created_at'),
    ...(fireAt === undefined ? {} : { fireAt }),
    ...(cron === undefined ? {} : { cron }),
    ...(nextRunAt === undefined ? {} : { nextRunAt }),
    ...(lastRunAt === undefined ? {} : { lastRunAt }),
    ...(lastOutcome === undefined ? {} : { lastOutcome }),
    ...(origin === undefined ? {} : { origin }),
    ...(handler === undefined ? {} : { handler }),
    ...(targetSurfaceId === undefined ? {} : { targetSurfaceId }),
    ...(timezone === undefined ? {} : { timezone }),
    ...(conditionJson === undefined
      ? {}
      : { condition: ConditionSchema.parse(JSON.parse(conditionJson)) }),
  }
}
