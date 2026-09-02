import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { writeJsonAtomicDurable } from './atomic-file.ts'
import { readJsonFile } from './json-file.ts'
import { MemoryBudgetSchema, type MemoryBudget } from './memory-config.ts'

export const FactsWatermarkSchema = z.enum([
  'within-low',
  'between-low-high',
  'over-high',
  'over-hard',
])

export const SpaceMemoryHealthSchema = z
  .object({
    activeSize: z.number().int().nonnegative(),
    watermark: FactsWatermarkSchema,
    reflectionPending: z.boolean(),
    overHardRecovery: z.boolean(),
    updatedAt: z.string().datetime({ offset: true }),
  })
  .strict()

export const MemoryHealthStateSchema = z
  .object({
    version: z.literal(1),
    budget: MemoryBudgetSchema,
    spaces: z.record(z.string().min(1), SpaceMemoryHealthSchema),
  })
  .strict()

export type SpaceMemoryHealth = z.infer<typeof SpaceMemoryHealthSchema>
export type MemoryHealthState = z.infer<typeof MemoryHealthStateSchema>

export interface MemoryHealthStoreOptions {
  rootDir: string
  budget: MemoryBudget
  now?: () => Date
}

export interface SpaceActiveProjection {
  spaceId: string
  activeSize: number
}

export class MemoryHealthPersistenceError extends Error {
  constructor(cause: unknown) {
    super(`memory health state could not be persisted: ${errorText(cause)}`, { cause })
    this.name = 'MemoryHealthPersistenceError'
  }
}

/**
 * Durable, rebuildable health for the rendered active FACTS working set.
 *
 * `reflectionPending` is hysteretic: crossing `high` sets it, and it remains
 * set until a later audit observes the projection back at or below `low`.
 * Persisting that bit matters when a size-reducing write or a restart leaves
 * the projection between the two watermarks before the scheduled Reflection
 * runs. `overHardRecovery` describes the current recovery condition; the
 * dependent Memory health System Surface owns user-facing history and
 * notifications (issues/133-system-space-memory-health.md).
 */
export class MemoryHealthStore {
  private readonly path: string
  private readonly budget: MemoryBudget
  private readonly now: () => Date
  private state: MemoryHealthState

  constructor(options: MemoryHealthStoreOptions) {
    this.path = join(options.rootDir, 'memory-health.json')
    this.budget = MemoryBudgetSchema.parse(options.budget)
    this.now = options.now ?? (() => new Date())
    const loaded = this.load()
    this.state = { ...loaded, budget: this.budget }
  }

  snapshot(): MemoryHealthState {
    return MemoryHealthStateSchema.parse(structuredClone(this.state))
  }

  /** Replaces the inventory at boot, dropping state for Spaces no longer present. */
  reconcile(projections: SpaceActiveProjection[]): MemoryHealthState {
    const updatedAt = this.now().toISOString()
    const spaces: Record<string, SpaceMemoryHealth> = {}
    for (const projection of [...projections].sort((left, right) =>
      left.spaceId.localeCompare(right.spaceId),
    )) {
      spaces[projection.spaceId] = this.assess(
        projection.activeSize,
        this.state.spaces[projection.spaceId],
        updatedAt,
      )
    }
    this.state = { version: 1, budget: this.budget, spaces }
    this.persist()
    return this.snapshot()
  }

  /** Updates one Space after a FACTS rewrite or explicit restore audit. */
  update(spaceId: string, activeSize: number): SpaceMemoryHealth {
    const health = this.assess(activeSize, this.state.spaces[spaceId], this.now().toISOString())
    this.state = {
      version: 1,
      budget: this.budget,
      spaces: { ...this.state.spaces, [spaceId]: health },
    }
    this.persist()
    return structuredClone(health)
  }

  private assess(
    activeSize: number,
    previous: SpaceMemoryHealth | undefined,
    updatedAt: string,
  ): SpaceMemoryHealth {
    if (!Number.isInteger(activeSize) || activeSize < 0) {
      throw new Error('rendered active FACTS size must be a non-negative integer')
    }
    const watermark =
      activeSize > this.budget.hard
        ? 'over-hard'
        : activeSize > this.budget.high
          ? 'over-high'
          : activeSize > this.budget.low
            ? 'between-low-high'
            : 'within-low'
    const reflectionPending =
      activeSize > this.budget.high ||
      (previous?.reflectionPending === true && activeSize > this.budget.low)
    return SpaceMemoryHealthSchema.parse({
      activeSize,
      watermark,
      reflectionPending,
      overHardRecovery: activeSize > this.budget.hard,
      updatedAt,
    })
  }

  private load(): MemoryHealthState {
    if (!existsSync(this.path)) return { version: 1, budget: this.budget, spaces: {} }
    try {
      return MemoryHealthStateSchema.parse(
        readJsonFile(this.path, { description: 'memory health state' }),
      )
    } catch (error) {
      console.warn(`rebuilding invalid memory health state ${this.path}: ${errorText(error)}`)
      return { version: 1, budget: this.budget, spaces: {} }
    }
  }

  private persist(): void {
    try {
      writeJsonAtomicDurable(this.path, this.state)
    } catch (error) {
      throw new MemoryHealthPersistenceError(error)
    }
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
