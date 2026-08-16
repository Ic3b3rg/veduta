import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { UpdateResult } from '@veduta/protocol'
import { z } from 'zod'
import { writeJsonAtomicDurable } from './atomic-file.ts'
import { isValidOrigin, type Origin } from './taint.ts'
import type { UpdateSurfaceAvailable } from './update-surface.ts'

export type UpdateDecisionStatus =
  'pending' | 'resolving' | 'applied' | 'rolled-back' | 'refused' | 'stale' | 'failed'

export interface UpdateDecisionRecord {
  version: string
  available: UpdateSurfaceAvailable
  status: UpdateDecisionStatus
  createdAt: string
  decisionAt?: string | undefined
  resolvedAt?: string | undefined
  resolvedBy?: 'trusted:user' | undefined
  outcomeDetail?: string | undefined
  outcomeOrigin?: Origin | undefined
}

const UpdateDecisionRecordSchema = z
  .object({
    version: z.string().min(1),
    available: z
      .object({
        version: z.string().min(1),
        notes: z.string(),
        migratesData: z.boolean(),
      })
      .strict(),
    status: z.enum([
      'pending',
      'resolving',
      'applied',
      'rolled-back',
      'refused',
      'stale',
      'failed',
    ]),
    createdAt: z.string().datetime(),
    decisionAt: z.string().datetime().optional(),
    resolvedAt: z.string().datetime().optional(),
    resolvedBy: z.literal('trusted:user').optional(),
    outcomeDetail: z.string().optional(),
    outcomeOrigin: z.custom<Origin>(isValidOrigin).optional(),
  })
  .strict()

const UpdateDecisionFileSchema = z
  .object({
    version: z.literal(1),
    decisions: z.array(UpdateDecisionRecordSchema),
  })
  .strict()

export interface UpdateDecisionStoreOptions {
  stateDir: string
  now: () => Date
}

/** Durable state machine for release offers verified by UpdateManager. */
export class UpdateDecisionStore {
  private readonly stateDir: string
  private readonly path: string
  private readonly now: () => Date
  private decisions = new Map<string, UpdateDecisionRecord>()

  constructor(options: UpdateDecisionStoreOptions) {
    this.stateDir = options.stateDir
    this.path = join(options.stateDir, 'update-decisions.json')
    this.now = options.now
    this.load()
    this.recoverOrphanedClaims()
  }

  list(): UpdateDecisionRecord[] {
    return [...this.decisions.values()].sort(
      (left, right) =>
        left.createdAt.localeCompare(right.createdAt) || left.version.localeCompare(right.version),
    )
  }

  latest(): UpdateDecisionRecord | undefined {
    return this.list().at(-1)
  }

  get(version: string): UpdateDecisionRecord | undefined {
    return this.decisions.get(version)
  }

  recordVerifiedOffer(available: UpdateSurfaceAvailable, createdAt: string): UpdateDecisionRecord {
    const next = new Map(this.decisions)
    let changed = false
    for (const decision of next.values()) {
      if (decision.version === available.version || decision.status !== 'pending') continue
      next.set(decision.version, {
        ...decision,
        status: 'stale',
        resolvedAt: createdAt,
        outcomeDetail: 'a different verified release is now offered',
      })
      changed = true
    }

    const current = next.get(available.version)
    if (!current) {
      next.set(available.version, {
        version: available.version,
        available,
        status: 'pending',
        createdAt,
      })
      changed = true
    } else if (current.status === 'pending') {
      next.set(available.version, { ...current, available })
      changed = true
    }

    if (changed) this.commit(next)
    return this.require(available.version)
  }

  markPendingOffersStale(resolvedAt: string): void {
    const next = new Map(this.decisions)
    let changed = false
    for (const decision of next.values()) {
      if (decision.status !== 'pending') continue
      next.set(decision.version, {
        ...decision,
        status: 'stale',
        resolvedAt,
        outcomeDetail: 'the verified release is no longer offered',
      })
      changed = true
    }
    if (changed) this.commit(next)
  }

  claim(version: string, actor: 'trusted:user', decisionAt: string): UpdateDecisionRecord {
    if (actor !== 'trusted:user') throw new Error('update resolution requires trusted:user')
    const current = this.require(version)
    if (current.status !== 'pending') return current
    return this.commitOne({
      ...current,
      status: 'resolving',
      decisionAt,
      resolvedBy: actor,
    })
  }

  refuse(
    version: string,
    actor: 'trusted:user',
    resolvedAt: string,
    outcomeDetail: string,
  ): UpdateDecisionRecord {
    if (actor !== 'trusted:user') throw new Error('update resolution requires trusted:user')
    const current = this.require(version)
    if (current.status !== 'pending') return current
    return this.commitOne({
      ...current,
      status: 'refused',
      decisionAt: resolvedAt,
      resolvedAt,
      resolvedBy: actor,
      outcomeDetail,
    })
  }

  attributeTerminal(
    version: string,
    actor: 'trusted:user',
    resolvedAt: string,
    pendingOutcomeDetail: string,
  ): UpdateDecisionRecord {
    if (actor !== 'trusted:user') throw new Error('update resolution requires trusted:user')
    const current = this.require(version)
    if (current.resolvedBy !== undefined) return current
    return this.commitOne(
      current.status === 'pending'
        ? {
            ...current,
            status: 'failed',
            resolvedAt,
            resolvedBy: actor,
            outcomeDetail: pendingOutcomeDetail,
          }
        : { ...current, resolvedBy: actor },
    )
  }

  recordResult(result: UpdateResult, outcomeOrigin: Origin): UpdateDecisionRecord {
    const existing = this.decisions.get(result.toVersion)
    return this.commitOne({
      version: result.toVersion,
      available: existing?.available ?? {
        version: result.toVersion,
        notes: '',
        migratesData: false,
      },
      status:
        result.outcome === 'success'
          ? 'applied'
          : result.outcome === 'rolled-back'
            ? 'rolled-back'
            : 'refused',
      createdAt: existing?.createdAt ?? result.finishedAt,
      decisionAt: existing?.decisionAt ?? result.finishedAt,
      resolvedAt: result.finishedAt,
      resolvedBy: existing?.resolvedBy ?? 'trusted:user',
      outcomeDetail: outcomeDetail(result),
      outcomeOrigin,
    })
  }

  private load(): void {
    if (!existsSync(this.path)) return
    const file = UpdateDecisionFileSchema.parse(JSON.parse(readFileSync(this.path, 'utf8')))
    for (const decision of file.decisions) {
      if (this.decisions.has(decision.version)) {
        throw new Error(`duplicate update decision version: ${decision.version}`)
      }
      this.decisions.set(decision.version, decision)
    }
  }

  private recoverOrphanedClaims(): void {
    if (
      existsSync(join(this.stateDir, 'marker.json')) ||
      existsSync(join(this.stateDir, 'update-state.json')) ||
      existsSync(join(this.stateDir, 'result.json'))
    ) {
      return
    }

    const next = new Map(this.decisions)
    let changed = false
    for (const decision of next.values()) {
      if (decision.status !== 'resolving') continue
      next.set(decision.version, {
        ...decision,
        status: 'failed',
        resolvedAt: decision.decisionAt ?? decision.createdAt,
        outcomeDetail: 'the update request did not reach the updater',
      })
      changed = true
    }
    if (changed) this.commit(next)
  }

  private commitOne(input: UpdateDecisionRecord): UpdateDecisionRecord {
    const decision = UpdateDecisionRecordSchema.parse(input)
    const next = new Map(this.decisions)
    next.set(decision.version, decision)
    this.commit(next)
    return decision
  }

  private commit(next: Map<string, UpdateDecisionRecord>): void {
    const decisions = [...next.values()]
      .map((decision) => UpdateDecisionRecordSchema.parse(decision))
      .sort(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) ||
          left.version.localeCompare(right.version),
      )
    writeJsonAtomicDurable(this.path, { version: 1, decisions })
    this.decisions = new Map(decisions.map((decision) => [decision.version, decision]))
  }

  private require(version: string): UpdateDecisionRecord {
    const decision = this.decisions.get(version)
    if (!decision) throw new Error(`unknown verified update offer: ${version}`)
    return decision
  }
}

function outcomeDetail(result: UpdateResult): string {
  if (result.outcome === 'success') return `Updated to ${result.toVersion}`
  return result.reason || result.failedStage || result.outcome
}
