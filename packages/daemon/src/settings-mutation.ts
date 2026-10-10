import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { writeJsonAtomicDurable } from './atomic-file.ts'
import type { PreparedSpaceEvent } from './durable-space-event.ts'
import { parseSpaceEventLine, type AppendSpaceEventInput } from './space-events.ts'

const EventSchema = z.unknown().transform((value, context) => {
  const event = parseSpaceEventLine(JSON.stringify(value))
  if (event) return event
  context.addIssue({ code: 'custom', message: 'Invalid Settings Event intent' })
  return z.NEVER
})

export class SettingsRecoveryPendingError extends Error {
  readonly outcome = 'recovery_pending' as const

  constructor(
    readonly spaceId: string,
    cause: unknown,
  ) {
    super(
      `Settings change is pending Event recovery in Space ${spaceId}. Reload to retry recovery.`,
      {
        cause,
      },
    )
    this.name = 'SettingsRecoveryPendingError'
  }
}

interface SettingsIntent<T> extends PreparedSpaceEvent {
  spaceId: string
  operation: T
}

/** Forward recovery for approved Settings changes; domain owners still apply their own state. */
export class SettingsMutationJournal<T> {
  private readonly path: string
  private readonly pending = new Map<string, SettingsIntent<T>>()
  private readonly recovered = new Map<string, T>()
  private readonly recovering = new Set<string>()

  constructor(
    private readonly options: {
      rootDir: string
      name: 'spaces' | 'automations' | 'reflection'
      schema: z.ZodType<T, z.ZodTypeDef, unknown>
      prepare: (spaceId: string, input: AppendSpaceEventInput, id: string) => PreparedSpaceEvent
      apply: (operation: T) => void
      deliver: (event: PreparedSpaceEvent) => void
      committed: (operation: T, spaceId: string) => void
    },
  ) {
    this.path = join(options.rootDir, 'spaces', `.${options.name}-settings-pending.json`)
    if (!existsSync(this.path)) return
    const saved = z
      .object({
        pending: z.array(
          z
            .object({
              spaceId: z.string().min(1),
              operation: z.unknown(),
              event: EventSchema,
              destination: z.string().min(1),
            })
            .strict(),
        ),
        recovered: z.array(
          z.object({ spaceId: z.string().min(1), operation: z.unknown() }).strict(),
        ),
      })
      .strict()
      .parse(JSON.parse(readFileSync(this.path, 'utf8')))
    for (const record of saved.pending) {
      if (record.spaceId !== record.event.spaceId || this.pending.has(record.spaceId))
        throw new Error('Invalid Settings recovery scope')
      this.pending.set(record.spaceId, {
        ...record,
        operation: options.schema.parse(record.operation),
      })
    }
    for (const record of saved.recovered) {
      this.recovered.set(record.spaceId, options.schema.parse(record.operation))
    }
  }

  perform(spaceId: string, input: T, event: AppendSpaceEventInput): void {
    this.reconcile(spaceId)
    const operation = this.options.schema.parse(input)
    const prepared = this.options.prepare(spaceId, event, `stm-${randomUUID()}`)
    this.pending.set(spaceId, { ...prepared, spaceId, operation })
    this.recovered.delete(spaceId)
    this.deliverPending(spaceId, false)
  }

  /** Only a recovered request earns a receipt; ordinary stale repeated writes still conflict. */
  recoveredOperation(spaceId: string): T | undefined {
    return this.recovered.get(spaceId)
  }

  reconcile(spaceId?: string): void {
    this.deliverPending(spaceId, true)
  }

  private deliverPending(spaceId: string | undefined, recordRecovery: boolean): void {
    for (const record of this.pending.values()) {
      if (
        (spaceId !== undefined && record.spaceId !== spaceId) ||
        this.recovering.has(record.spaceId)
      )
        continue
      this.recovering.add(record.spaceId)
      try {
        // Persist before applying, including after a previous intent-write failure.
        this.persist()
        this.options.apply(record.operation)
        this.options.deliver(record)
        this.pending.delete(record.spaceId)
        if (recordRecovery) this.recovered.set(record.spaceId, record.operation)
        this.persist()
      } catch (cause) {
        this.pending.set(record.spaceId, record)
        throw new SettingsRecoveryPendingError(record.spaceId, cause)
      } finally {
        this.recovering.delete(record.spaceId)
      }
      try {
        this.options.committed(record.operation, record.spaceId)
      } catch (error) {
        console.error('Settings delivery observer failed', error)
      }
    }
  }

  recoverAtStartup(): void {
    for (const spaceId of this.pending.keys()) {
      try {
        this.reconcile(spaceId)
      } catch (error) {
        console.error('Settings boot recovery pending', error)
      }
    }
  }

  private persist(): void {
    writeJsonAtomicDurable(this.path, {
      pending: [...this.pending.values()],
      recovered: [...this.recovered].map(([spaceId, operation]) => ({ spaceId, operation })),
    })
  }
}
