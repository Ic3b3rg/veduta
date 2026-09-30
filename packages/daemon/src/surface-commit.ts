import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { SpaceEvent, AppendSpaceEventInput } from './space-events.ts'
import { optionalString, requiredNumber, requiredString } from './sqlite-rows.ts'

export interface PreparedSurfaceCommitEvent {
  event: SpaceEvent
  destination: string
}

export interface SurfaceCommitTransport {
  prepareSurfaceCommitEvent(
    spaceId: string,
    input: AppendSpaceEventInput,
    commitId: string,
  ): PreparedSurfaceCommitEvent
  deliverSurfaceCommitEvent(prepared: PreparedSurfaceCommitEvent): void
  notifySurfaceCommitDelivered(spaceId: string): void
}

export interface SurfaceCommitRecord extends PreparedSurfaceCommitEvent {
  id: string
  sequence: number
  spaceId: string
  surfaceEventCursor?: number
  correlationId?: string
}

export class SurfaceCommitRecoveryPendingError extends Error {
  readonly outcome = 'recovery_pending' as const

  constructor(
    readonly commitId: string,
    readonly spaceId: string,
    cause?: unknown,
  ) {
    super(`Surface commit ${commitId} is pending Event recovery in Space ${spaceId}`, { cause })
    this.name = 'SurfaceCommitRecoveryPendingError'
  }
}

/** SQLite intent and ordered, idempotent delivery for ADR-0030. */
export class SurfaceCommitJournal {
  constructor(
    private readonly db: DatabaseSync,
    private readonly transport: SurfaceCommitTransport,
    private readonly now: () => Date,
  ) {}

  /** Must be called inside the transaction that writes the Surface mutation. */
  prepare(
    spaceId: string,
    input: AppendSpaceEventInput,
    surfaceEventCursor?: number,
  ): SurfaceCommitRecord {
    const older = this.pending(spaceId)[0]
    if (older) throw new SurfaceCommitRecoveryPendingError(older.id, spaceId)

    const id = `scm-${randomUUID()}`
    const prepared = this.transport.prepareSurfaceCommitEvent(spaceId, input, id)
    const correlationId = prepared.event.payload?.['correlationId']
    const result = this.db
      .prepare(
        `insert into surface_commits
          (id, space_id, surface_event_cursor, event_json, destination, correlation_id, state)
         values (?, ?, ?, ?, ?, ?, 'recovery_pending')`,
      )
      .run(
        id,
        spaceId,
        surfaceEventCursor ?? null,
        JSON.stringify(prepared.event),
        prepared.destination,
        typeof correlationId === 'string' ? correlationId : null,
      )
    return {
      ...prepared,
      id,
      sequence: Number(result.lastInsertRowid),
      spaceId,
      ...(surfaceEventCursor === undefined ? {} : { surfaceEventCursor }),
      ...(typeof correlationId === 'string' ? { correlationId } : {}),
    }
  }

  pending(spaceId?: string): SurfaceCommitRecord[] {
    const rows =
      spaceId === undefined
        ? this.db
            .prepare(
              "select * from surface_commits where state = 'recovery_pending' order by sequence",
            )
            .all()
        : this.db
            .prepare(
              "select * from surface_commits where state = 'recovery_pending' and space_id = ? order by sequence",
            )
            .all(spaceId)
    return rows.map(recordFromRow)
  }

  reconcileSpace(spaceId: string): SurfaceCommitRecord[] {
    const delivered: SurfaceCommitRecord[] = []
    for (const record of this.pending(spaceId)) {
      try {
        this.transport.deliverSurfaceCommitEvent(record)
        this.db
          .prepare(
            `update surface_commits set state = 'delivered', delivered_at = ?
             where id = ? and state = 'recovery_pending'`,
          )
          .run(this.now().toISOString(), record.id)
        delivered.push(record)
      } catch (cause) {
        throw new SurfaceCommitRecoveryPendingError(record.id, record.spaceId, cause)
      }
      try {
        this.transport.notifySurfaceCommitDelivered(record.spaceId)
      } catch (error) {
        console.error('Surface commit delivery observer failed', error)
      }
    }
    return delivered
  }
}

function recordFromRow(row: Record<string, unknown>): SurfaceCommitRecord {
  const event = JSON.parse(requiredString(row, 'event_json')) as SpaceEvent
  const surfaceEventCursor = row['surface_event_cursor']
  const correlationId = optionalString(row, 'correlation_id')
  return {
    id: requiredString(row, 'id'),
    sequence: requiredNumber(row, 'sequence'),
    spaceId: requiredString(row, 'space_id'),
    event,
    destination: requiredString(row, 'destination'),
    ...(typeof surfaceEventCursor === 'number' ? { surfaceEventCursor } : {}),
    ...(correlationId === undefined ? {} : { correlationId }),
  }
}
