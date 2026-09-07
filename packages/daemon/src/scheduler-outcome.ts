import type { DatabaseSync } from 'node:sqlite'
import {
  AutomationOutcomeInputSchema,
  type AutomationOutcomeInput,
  type JsonObject,
  type PendingDecision,
} from '@veduta/protocol'
import { automationsSurfaceIdForSpace } from './automations-surface.ts'
import {
  AutomationOutcomeUnavailableError,
  sanitizeAutomationOutcome,
  type AutomationOutcomeService,
  type AutomationOutcomeOccurrence,
} from './automation-outcome-service.ts'
import type { Automation } from './scheduler-persistence.ts'
import { optionalString, requiredNumber, requiredString } from './sqlite-rows.ts'
import type { Store } from './store.ts'
import { effectiveOrigin, isValidOrigin, neutralizeDelimiters, type Origin } from './taint.ts'

const OUTCOME_RETRY_DELAY_MS = 60 * 1000

export interface AutomationOutcomeProducerResult {
  outcome: AutomationOutcomeInput
  /** Additional provenance introduced while producing this occurrence. */
  origin?: Origin
}

export type AutomationOutcomeHandlerResult =
  AutomationOutcomeInput | AutomationOutcomeProducerResult

export type AutomationOutcomeHandler = (ctx: {
  automation: Automation
  scheduledFor: string
  targetSurfaceId: string
  targetVersion?: number
}) => Promise<AutomationOutcomeHandlerResult> | AutomationOutcomeHandlerResult

export type PendingDecisionLookup = (
  id: string,
) => Promise<PendingDecision | undefined> | PendingDecision | undefined

export interface ProducedAutomationOutcome {
  outcome: AutomationOutcomeInput
  origin?: Origin
  checkedAt?: string
  targetSurfaceId?: string
  targetVersion?: number
}

export interface RecurringOutcomeCheckpoint {
  outcome: AutomationOutcomeInput
  origin: Origin
  checkedAt: string
  targetSurfaceId: string
  targetVersion?: number
}

export type AutomationOutcomeDelivery =
  { status: 'delivered'; outcome: AutomationOutcomeInput } | { status: 'superseded' }

interface SchedulerOutcomeCoordinatorOptions {
  db: DatabaseSync
  store: Store
  service: AutomationOutcomeService
  now: () => Date
  requireAutomation: (automationId: number) => Automation
  appendEvent: (
    spaceId: string,
    type: string,
    text: string,
    payload: JsonObject,
    origin?: Origin,
  ) => void
}

class AutomationOccurrenceSupersededError extends Error {
  constructor() {
    super('Automation occurrence configuration changed before outcome delivery')
    this.name = 'AutomationOccurrenceSupersededError'
  }
}

/**
 * Owns the durable recurring-outcome protocol described by
 * `issues/091-automation-outcome-delivery.md`: producer checkpoints,
 * current-configuration guards, retry, fallback, and target cleanup.
 */
export class SchedulerOutcomeCoordinator {
  private readonly db: DatabaseSync
  private readonly store: Store
  private readonly service: AutomationOutcomeService
  private readonly now: () => Date
  private readonly requireAutomation: (automationId: number) => Automation
  private readonly appendEvent: SchedulerOutcomeCoordinatorOptions['appendEvent']
  private readonly handlers = new Map<string, AutomationOutcomeHandler>()
  private pendingDecisionLookup: PendingDecisionLookup | undefined

  constructor(options: SchedulerOutcomeCoordinatorOptions) {
    this.db = options.db
    this.store = options.store
    this.service = options.service
    this.now = options.now
    this.requireAutomation = options.requireAutomation
    this.appendEvent = options.appendEvent
  }

  registerHandler(name: string, handler: AutomationOutcomeHandler): void {
    this.handlers.set(name, handler)
  }

  setPendingDecisionLookup(lookup: PendingDecisionLookup): void {
    this.pendingDecisionLookup = lookup
  }

  async produce(
    automation: Automation,
    scheduledFor: string,
    targetSurfaceId: string,
  ): Promise<ProducedAutomationOutcome | undefined> {
    const handler =
      automation.handler === undefined ? undefined : this.handlers.get(automation.handler)
    if (handler === undefined) return undefined

    // Capture the generation before awaiting the producer. An in-flight
    // user edit must make the eventual patch conflict instead of overwriting it.
    const targetVersion = this.store.getSurfaceVersion(targetSurfaceId)?.version
    const handled = await handler({
      automation,
      scheduledFor,
      targetSurfaceId,
      ...(targetVersion === undefined ? {} : { targetVersion }),
    })
    return {
      ...parseProducerResult(handled),
      ...(targetVersion === undefined ? {} : { targetVersion }),
    }
  }

  checkpointRecurringOutcome(
    automation: Automation,
    scheduledFor: string,
    produced: ProducedAutomationOutcome | RecurringOutcomeCheckpoint,
    defaultTargetSurfaceId: string,
  ): RecurringOutcomeCheckpoint {
    const checkpoint: RecurringOutcomeCheckpoint = {
      outcome: sanitizeAutomationOutcome(produced.outcome),
      checkedAt: produced.checkedAt ?? this.nowIso(),
      origin: effectiveOrigin(
        [automation.origin, produced.origin],
        automation.origin ?? 'trusted:system',
      ),
      targetSurfaceId: produced.targetSurfaceId ?? defaultTargetSurfaceId,
      ...(produced.targetVersion === undefined ? {} : { targetVersion: produced.targetVersion }),
    }
    this.db
      .prepare(
        `update automation_runs set recurring_outcome_json = ?
         where automation_id = ? and scheduled_for = ? and finished_at is null`,
      )
      .run(JSON.stringify(checkpoint), automation.id, scheduledFor)
    return checkpoint
  }

  retryableClaimOutcome(
    automationId: number,
    scheduledFor: string,
    defaultTargetSurfaceId: string,
  ): RecurringOutcomeCheckpoint | undefined {
    const row = this.db
      .prepare(
        `select recurring_outcome_json from automation_runs
         where automation_id = ? and scheduled_for = ? and finished_at is null
           and retry_at <= ?`,
      )
      .get(automationId, scheduledFor, this.nowIso())
    const checkpointJson = row ? optionalString(row, 'recurring_outcome_json') : undefined
    return parseRecurringOutcomeCheckpoint(checkpointJson, scheduledFor, defaultTargetSurfaceId)
  }

  parkClaim(automationId: number, scheduledFor: string): void {
    const retryAt = new Date(this.now().getTime() + OUTCOME_RETRY_DELAY_MS).toISOString()
    this.db
      .prepare(
        `update automation_runs set retry_at = ?
         where automation_id = ? and scheduled_for = ? and finished_at is null`,
      )
      .run(retryAt, automationId, scheduledFor)
  }

  hasDeliveryFailureEvent(spaceId: string, automationId: number, scheduledFor: string): boolean {
    return this.store
      .eventLog(spaceId)
      .some(
        (event) =>
          event.type === 'automation.outcome.delivery-failed' &&
          event.payload?.['automationId'] === automationId &&
          event.payload?.['scheduledFor'] === scheduledFor,
      )
  }

  async deliver(
    started: Automation,
    scheduledFor: string,
    checkpoint: RecurringOutcomeCheckpoint,
    fallbackSurfaceId: string,
  ): Promise<AutomationOutcomeDelivery> {
    if (
      !this.canDeliverRecurringOutcome(
        started,
        this.requireAutomation(started.id),
        checkpoint.targetSurfaceId,
      )
    ) {
      return { status: 'superseded' }
    }

    const occurrence: AutomationOutcomeOccurrence = {
      automationId: started.id,
      spaceId: started.spaceId,
      targetSurfaceId: checkpoint.targetSurfaceId,
      description: started.description,
      scheduledFor,
      checkedAt: checkpoint.checkedAt,
      ...(checkpoint.targetVersion === undefined
        ? {}
        : { expectedTargetVersion: checkpoint.targetVersion }),
      origin: checkpoint.origin,
    }
    const requestedOutcome = await this.validateDecisionReference(
      started.spaceId,
      checkpoint.outcome,
    )
    const isCurrent = () =>
      this.canDeliverRecurringOutcome(
        started,
        this.requireAutomation(started.id),
        checkpoint.targetSurfaceId,
      )

    try {
      let delivered: AutomationOutcomeInput
      let deliveredTargetSurfaceId = occurrence.targetSurfaceId
      try {
        delivered = await this.deliverWithRetry(occurrence, requestedOutcome, isCurrent)
      } catch (error) {
        if (
          !(error instanceof AutomationOutcomeUnavailableError) ||
          occurrence.targetSurfaceId === fallbackSurfaceId
        ) {
          throw error
        }
        deliveredTargetSurfaceId = fallbackSurfaceId
        // The captured generation belongs to the unavailable target. The
        // fallback has its own generation and receives a status-only failure.
        const fallbackOccurrence: AutomationOutcomeOccurrence = {
          automationId: occurrence.automationId,
          spaceId: occurrence.spaceId,
          targetSurfaceId: fallbackSurfaceId,
          description: occurrence.description,
          scheduledFor: occurrence.scheduledFor,
          checkedAt: occurrence.checkedAt,
          origin: occurrence.origin,
        }
        delivered = await this.deliverUnavailableFallbackWithRetry(
          occurrence,
          fallbackOccurrence,
          automationOutcomeFailure(
            'Automation target is unavailable',
            'target_unavailable',
            'The linked Surface is no longer available.',
          ),
          isCurrent,
        )
      }

      const current = this.requireAutomation(started.id)
      if (
        current.status === 'cancelled' ||
        !this.outcomeTargetSurfaceIds(current).includes(deliveredTargetSurfaceId)
      ) {
        this.service.clearAutomationTarget(
          current.id,
          current.spaceId,
          deliveredTargetSurfaceId,
          checkpoint.origin,
          checkpoint.checkedAt,
        )
      }
      return { status: 'delivered', outcome: delivered }
    } catch (error) {
      if (error instanceof AutomationOccurrenceSupersededError) {
        return { status: 'superseded' }
      }
      throw error
    }
  }

  recoverInterruptedRuns(): void {
    const interrupted = this.db
      .prepare(
        `select runs.automation_id as automation_id, runs.scheduled_for as scheduled_for,
                automations.space_id as space_id, automations.description as description,
                automations.origin as origin, automations.kind as automation_kind,
                automations.target_surface_id as target_surface_id,
                runs.recurring_outcome_json as recurring_outcome_json
         from automation_runs runs
         join automations on automations.id = runs.automation_id
         where runs.finished_at is null`,
      )
      .all()
    for (const row of interrupted) {
      const automationId = requiredNumber(row, 'automation_id')
      const scheduledFor = requiredString(row, 'scheduled_for')
      const checkpointJson = optionalString(row, 'recurring_outcome_json')
      const spaceId = requiredString(row, 'space_id')
      const space = this.store.getSpace(spaceId)
      const targetSurfaceId =
        optionalString(row, 'target_surface_id') ??
        (space === undefined ? '' : automationsSurfaceIdForSpace(space))
      const checkpoint = parseRecurringOutcomeCheckpoint(
        checkpointJson,
        scheduledFor,
        targetSurfaceId,
      )
      if (checkpoint === undefined) {
        this.db
          .prepare('delete from automation_runs where automation_id = ? and scheduled_for = ?')
          .run(automationId, scheduledFor)
      } else {
        // Keep the producer result in SQLite until delivery succeeds. A
        // second crash during boot must not re-run the producer.
        this.db
          .prepare(
            `update automation_runs set retry_at = ?
             where automation_id = ? and scheduled_for = ? and finished_at is null`,
          )
          .run(this.nowIso(), automationId, scheduledFor)
      }
      try {
        const storedOrigin = optionalString(row, 'origin')
        if (!this.hasRecoveryEvent(spaceId, automationId, scheduledFor)) {
          this.appendEvent(
            spaceId,
            'automation.recover',
            `Recovered interrupted run of automation "${requiredString(row, 'description')}" — it will ${checkpoint === undefined ? 'run again' : 'resume outcome delivery'}`,
            {
              automationId,
              scheduledFor,
              automationKind: requiredString(row, 'automation_kind'),
            },
            isValidOrigin(storedOrigin) ? storedOrigin : 'trusted:system',
          )
        }
      } catch {
        // The Space may be gone; recovery must never block boot.
      }
    }
  }

  outcomeTargetSurfaceIds(automation: Automation): string[] {
    const space = this.store.getSpace(automation.spaceId)
    if (!space) return automation.targetSurfaceId === undefined ? [] : [automation.targetSurfaceId]
    const fallbackSurfaceId = automationsSurfaceIdForSpace(space)
    return [...new Set([automation.targetSurfaceId ?? fallbackSurfaceId, fallbackSurfaceId])]
  }

  reconcileOutcomeTargets(automations: readonly Automation[]): void {
    this.service.reconcileAutomationTargets(
      automations
        .filter((automation) => automation.kind === 'job' && automation.status !== 'cancelled')
        .map((automation) => ({
          automationId: automation.id,
          spaceId: automation.spaceId,
          targetSurfaceIds: this.outcomeTargetSurfaceIds(automation),
        })),
    )
  }

  /** Persist cleanup intent inside the caller's Automation transaction. */
  enqueueOutcomeTargetCleanups(
    automation: Automation,
    targetSurfaceIds: readonly string[],
    origin: Origin,
  ): void {
    const clearedAt = this.nowIso()
    const insert = this.db.prepare(
      `insert or replace into automation_outcome_target_cleanups
         (automation_id, space_id, surface_id, origin, cleared_at)
       values (?, ?, ?, ?, ?)`,
    )
    for (const surfaceId of targetSurfaceIds) {
      insert.run(automation.id, automation.spaceId, surfaceId, origin, clearedAt)
    }
  }

  flushOutcomeTargetCleanups(automationId?: number): void {
    const rows =
      automationId === undefined
        ? this.db.prepare('select * from automation_outcome_target_cleanups').all()
        : this.db
            .prepare('select * from automation_outcome_target_cleanups where automation_id = ?')
            .all(automationId)
    for (const row of rows) {
      const id = requiredNumber(row, 'automation_id')
      const spaceId = requiredString(row, 'space_id')
      const surfaceId = requiredString(row, 'surface_id')
      const origin = requiredString(row, 'origin')
      if (!isValidOrigin(origin)) throw new Error(`invalid Automation cleanup origin: ${origin}`)
      this.service.clearAutomationTarget(
        id,
        spaceId,
        surfaceId,
        origin,
        requiredString(row, 'cleared_at'),
      )
      this.db
        .prepare(
          `delete from automation_outcome_target_cleanups
           where automation_id = ? and space_id = ? and surface_id = ?`,
        )
        .run(id, spaceId, surfaceId)
    }
  }

  private canDeliverRecurringOutcome(
    started: Automation,
    current: Automation,
    outcomeTargetSurfaceId: string,
  ): boolean {
    const space = this.store.getSpace(current.spaceId)
    const currentTargetSurfaceId =
      current.targetSurfaceId ?? (space ? automationsSurfaceIdForSpace(space) : undefined)
    return (
      current.kind === 'job' &&
      current.status !== 'cancelled' &&
      current.enabled &&
      current.handler === started.handler &&
      current.targetSurfaceId === started.targetSurfaceId &&
      currentTargetSurfaceId === outcomeTargetSurfaceId
    )
  }

  private async validateDecisionReference(
    spaceId: string,
    outcome: AutomationOutcomeInput,
  ): Promise<AutomationOutcomeInput> {
    if (outcome.kind !== 'decision-required') return outcome
    try {
      const decision = await this.pendingDecisionLookup?.(outcome.decisionId)
      if (
        decision?.state === 'pending' &&
        decision.scope.type === 'space' &&
        decision.scope.spaceId === spaceId
      ) {
        return outcome
      }
    } catch {
      // A lookup failure is indistinguishable from a dangling reference at
      // this boundary; expose a safe Automation failure, never raw details.
    }
    return automationOutcomeFailure(
      'Automation decision is unavailable',
      'decision_unavailable',
      'The referenced Pending decision is not active in this Space.',
    )
  }

  private async deliverWithRetry(
    occurrence: AutomationOutcomeOccurrence,
    outcome: AutomationOutcomeInput,
    isCurrent: () => boolean,
  ): Promise<AutomationOutcomeInput> {
    try {
      const delivered = await this.service.deliverIfCurrent(occurrence, outcome, isCurrent)
      if (delivered === undefined) throw new AutomationOccurrenceSupersededError()
      return delivered
    } catch (error) {
      if (
        error instanceof AutomationOutcomeUnavailableError ||
        error instanceof AutomationOccurrenceSupersededError
      ) {
        throw error
      }
      const delivered = await this.service.deliverIfCurrent(occurrence, outcome, isCurrent)
      if (delivered === undefined) throw new AutomationOccurrenceSupersededError()
      return delivered
    }
  }

  private async deliverUnavailableFallbackWithRetry(
    original: AutomationOutcomeOccurrence,
    fallback: AutomationOutcomeOccurrence,
    outcome: AutomationOutcomeInput,
    isCurrent: () => boolean,
  ): Promise<AutomationOutcomeInput> {
    try {
      const delivered = await this.service.deliverUnavailableFallbackIfCurrent(
        original,
        fallback,
        outcome,
        isCurrent,
      )
      if (delivered === undefined) throw new AutomationOccurrenceSupersededError()
      return delivered
    } catch (error) {
      if (
        error instanceof AutomationOutcomeUnavailableError ||
        error instanceof AutomationOccurrenceSupersededError
      ) {
        throw error
      }
      const delivered = await this.service.deliverUnavailableFallbackIfCurrent(
        original,
        fallback,
        outcome,
        isCurrent,
      )
      if (delivered === undefined) throw new AutomationOccurrenceSupersededError()
      return delivered
    }
  }

  private hasRecoveryEvent(spaceId: string, automationId: number, scheduledFor: string): boolean {
    return this.store
      .eventLog(spaceId)
      .some(
        (event) =>
          event.type === 'automation.recover' &&
          event.payload?.['automationId'] === automationId &&
          event.payload?.['scheduledFor'] === scheduledFor,
      )
  }

  private nowIso(): string {
    return this.now().toISOString()
  }
}

function parseProducerResult(result: AutomationOutcomeHandlerResult): ProducedAutomationOutcome {
  if ('outcome' in result) {
    if (result.origin !== undefined && !isValidOrigin(result.origin)) {
      throw new Error(`invalid Automation outcome origin: ${String(result.origin)}`)
    }
    return {
      outcome: AutomationOutcomeInputSchema.parse(result.outcome),
      ...(result.origin === undefined ? {} : { origin: result.origin }),
    }
  }
  return { outcome: AutomationOutcomeInputSchema.parse(result) }
}

export function parseRecurringOutcomeCheckpoint(
  value: string | undefined,
  scheduledFor: string,
  defaultTargetSurfaceId = '',
): RecurringOutcomeCheckpoint | undefined {
  if (value === undefined) return undefined
  try {
    const decoded = JSON.parse(value) as unknown
    if (typeof decoded === 'object' && decoded !== null && 'outcome' in decoded) {
      const checkpoint = decoded as Record<string, unknown>
      const outcome = AutomationOutcomeInputSchema.safeParse(checkpoint['outcome'])
      const origin = checkpoint['origin']
      const checkedAt = checkpoint['checkedAt']
      const targetSurfaceId = checkpoint['targetSurfaceId']
      const targetVersion = checkpoint['targetVersion']
      if (
        outcome.success &&
        isValidOrigin(origin) &&
        typeof checkedAt === 'string' &&
        !Number.isNaN(new Date(checkedAt).getTime()) &&
        typeof targetSurfaceId === 'string' &&
        targetSurfaceId.length > 0 &&
        (targetVersion === undefined ||
          (typeof targetVersion === 'number' &&
            Number.isInteger(targetVersion) &&
            targetVersion > 0))
      ) {
        return {
          outcome: outcome.data,
          origin,
          checkedAt: new Date(checkedAt).toISOString(),
          targetSurfaceId,
          ...(targetVersion === undefined ? {} : { targetVersion }),
        }
      }
      return undefined
    }
    const legacy = AutomationOutcomeInputSchema.safeParse(decoded)
    return legacy.success
      ? {
          outcome: legacy.data,
          origin: 'trusted:system',
          checkedAt: scheduledFor,
          targetSurfaceId: defaultTargetSurfaceId,
        }
      : undefined
  } catch {
    return undefined
  }
}

export function automationOutcomeFailure(
  summary: string,
  code: string,
  error: unknown,
): AutomationOutcomeInput {
  const raw = error instanceof Error ? error.message : String(error)
  return {
    kind: 'failed',
    summary: safeOutcomeText(summary),
    coalesceKey: code,
    error: { code, message: safeOutcomeText(raw) },
  }
}

function safeOutcomeText(value: string): string {
  const safe = neutralizeDelimiters(value).replace(/\s+/g, ' ').trim()
  return (safe || 'Automation outcome unavailable').slice(0, 240)
}
