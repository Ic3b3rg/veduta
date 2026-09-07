import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  AUTOMATION_OUTCOMES_STATE_KEY,
  AutomationOutcomeInputSchema,
  AutomationOutcomeKindSchema,
  AutomationOutcomeStatusesSchema,
  AutomationRunHistoryEntrySchema,
  JsonValueSchema,
  MAX_AUTOMATION_RUN_HISTORY,
  type AutomationOutcomeInput,
  type AutomationOutcomeNotification,
  type AutomationOutcomeNotificationActionResult,
  type AutomationOutcomeNotificationSnapshot,
  type AutomationRunHistoryEntry,
  type PatchOperation,
  type Surface,
} from '@veduta/protocol'
import {
  deliveryFromRow,
  historyFromRow,
  initializeAutomationOutcomeSchema,
  type StoredAutomationRunHistoryEntry,
  type StoredAutomationOutcomeDelivery,
} from './automation-outcome-persistence.ts'
import {
  optionalString,
  requiredNumber,
  requiredString,
  withImmediateTransaction,
} from './sqlite-rows.ts'
import {
  AutomationOutcomeNotifications,
  AutomationOutcomeUnavailableError,
  type AutomationOutcomeLifecycleEvent,
} from './automation-outcome-notifications.ts'
import {
  nextAutomationOutcomeStatus,
  promoteAutomationRecovery,
  replayedAutomationOutcome,
  sanitizeAutomationOutcome,
} from './automation-outcome-policy.ts'
import { SurfaceVersionConflictError } from './surface-engine.ts'
import type { SpaceEvent } from './space-events.ts'
import type { Store } from './store.ts'
import type { Origin } from './taint.ts'

export { AutomationOutcomeUnavailableError } from './automation-outcome-notifications.ts'
export type { AutomationOutcomeLifecycleEvent } from './automation-outcome-notifications.ts'
export { sanitizeAutomationOutcome } from './automation-outcome-policy.ts'

const MAX_RETAINED_DELIVERIES_PER_TARGET = 64
const EMPTY_EVENT_WATERMARK = 'empty'
const EVENT_WATERMARK_EPOCH = '1970-01-01T00:00:00.000Z'

export interface AutomationOutcomeOccurrence {
  automationId: number
  spaceId: string
  targetSurfaceId: string
  description: string
  scheduledFor: string
  checkedAt: string
  expectedTargetVersion?: number
  origin: Origin
}

export interface AutomationOutcomeServiceOptions {
  rootDir: string
  store: Store
  now?: () => Date
}

export interface AutomationOutcomeRecoveryLog {
  events: SpaceEvent[]
  full: boolean
  since?: string
}

export class AutomationOutcomeService {
  private readonly db: DatabaseSync
  private readonly store: Store
  private readonly now: () => Date
  private readonly notifications: AutomationOutcomeNotifications
  private readonly terminalDecisionIds = new Set<string>()
  private deliveryTail: Promise<void> = Promise.resolve()

  constructor(options: AutomationOutcomeServiceOptions) {
    this.db = new DatabaseSync(join(options.rootDir, 'automation-outcomes.sqlite'))
    this.store = options.store
    this.now = options.now ?? (() => new Date())
    initializeAutomationOutcomeSchema(this.db)
    this.notifications = new AutomationOutcomeNotifications(this.db, this.store, this.now)
  }

  close(): void {
    this.notifications.close()
    this.db.close()
  }

  onLifecycle(listener: (event: AutomationOutcomeLifecycleEvent) => void): () => void {
    return this.notifications.onLifecycle(listener)
  }

  deliver(
    occurrence: AutomationOutcomeOccurrence,
    input: AutomationOutcomeInput,
  ): Promise<AutomationOutcomeInput> {
    const outcome = sanitizeAutomationOutcome(AutomationOutcomeInputSchema.parse(input))
    return this.enqueueDelivery(() => this.deliverNow(occurrence, outcome))
  }

  deliverIfCurrent(
    occurrence: AutomationOutcomeOccurrence,
    input: AutomationOutcomeInput,
    isCurrent: () => boolean,
  ): Promise<AutomationOutcomeInput | undefined> {
    const outcome = sanitizeAutomationOutcome(AutomationOutcomeInputSchema.parse(input))
    return this.enqueueDelivery(() =>
      isCurrent() ? this.deliverNow(occurrence, outcome) : undefined,
    )
  }

  deliverUnavailableFallback(
    original: AutomationOutcomeOccurrence,
    fallback: AutomationOutcomeOccurrence,
    input: AutomationOutcomeInput,
  ): Promise<AutomationOutcomeInput> {
    const outcome = sanitizeAutomationOutcome(AutomationOutcomeInputSchema.parse(input))
    return this.enqueueDelivery(() => {
      this.redirectUnavailableDelivery(original, fallback, outcome)
      return this.deliverNow(fallback, outcome)
    })
  }

  deliverUnavailableFallbackIfCurrent(
    original: AutomationOutcomeOccurrence,
    fallback: AutomationOutcomeOccurrence,
    input: AutomationOutcomeInput,
    isCurrent: () => boolean,
  ): Promise<AutomationOutcomeInput | undefined> {
    const outcome = sanitizeAutomationOutcome(AutomationOutcomeInputSchema.parse(input))
    return this.enqueueDelivery(() => {
      if (!isCurrent()) return undefined
      this.redirectUnavailableDelivery(original, fallback, outcome)
      return this.deliverNow(fallback, outcome)
    })
  }

  private enqueueDelivery<T>(workInput: () => T): Promise<T> {
    const work = this.deliveryTail.then(workInput)
    this.deliveryTail = work.then(
      () => undefined,
      () => undefined,
    )
    return work
  }

  recover(): Set<string> {
    const recoveredSpaceIds = new Set<string>()
    const recoveryLogs = this.recoveryLogs()
    this.notifications.recover(recoveryLogs)
    const pending = this.db
      .prepare('select * from automation_outcome_deliveries where completed_at is null order by id')
      .all()
      .map(deliveryFromRow)
    for (const delivery of pending) {
      try {
        this.deliverNow(
          {
            automationId: delivery.automationId,
            spaceId: delivery.spaceId,
            targetSurfaceId: delivery.targetSurfaceId,
            description: delivery.description,
            scheduledFor: delivery.scheduledFor,
            checkedAt: delivery.checkedAt,
            origin: delivery.origin,
          },
          delivery.outcome,
        )
        recoveredSpaceIds.add(delivery.spaceId)
      } catch (error) {
        if (!(error instanceof AutomationOutcomeUnavailableError)) throw error
        console.warn(
          `Automation outcome delivery ${delivery.id} remains pending: target unavailable`,
        )
      }
    }
    for (const spaceId of this.reconcileHistoryWithEvents(recoveryLogs)) {
      recoveredSpaceIds.add(spaceId)
    }
    this.storeRecoveryWatermarks(recoveryLogs)
    return recoveredSpaceIds
  }

  list(spaceId: string): AutomationOutcomeNotificationSnapshot {
    return this.notifications.list(spaceId)
  }

  allNotifications(spaceId: string): AutomationOutcomeNotification[] {
    return this.notifications.all(spaceId)
  }

  history(automationId: number): AutomationRunHistoryEntry[] {
    return this.historyWithOrigins(automationId).map(({ origin: _origin, ...entry }) => entry)
  }

  historyWithOrigins(automationId: number): StoredAutomationRunHistoryEntry[] {
    return this.db
      .prepare(
        `select * from automation_outcome_history where automation_id = ?
         order by at desc, id desc limit ?`,
      )
      .all(automationId, MAX_AUTOMATION_RUN_HISTORY)
      .map(historyFromRow)
  }

  open(
    spaceId: string,
    notificationId: string,
    actor: 'trusted:user',
  ): AutomationOutcomeNotificationActionResult {
    return this.notifications.open(spaceId, notificationId, actor)
  }

  dismiss(
    spaceId: string,
    notificationId: string,
    actor: 'trusted:user',
  ): AutomationOutcomeNotificationActionResult {
    return this.notifications.dismiss(spaceId, notificationId, actor)
  }

  settleDecision(
    decisionId: string,
    actor: Origin = 'trusted:system',
    settledAt = this.nowIso(),
  ): Promise<void> {
    this.terminalDecisionIds.add(decisionId)
    return this.enqueueDelivery(() => {
      const decisionScope = createHash('sha256').update(decisionId).digest('hex').slice(0, 16)
      for (const surface of this.store.listSurfaces()) {
        const parsed = AutomationOutcomeStatusesSchema.safeParse(
          surface.state[AUTOMATION_OUTCOMES_STATE_KEY],
        )
        if (!parsed.success) continue
        const statuses = { ...parsed.data }
        const matched = Object.entries(statuses).filter(
          ([, status]) =>
            status.latest?.kind === 'decision-required' && status.latest.decisionId === decisionId,
        )
        if (matched.length === 0) continue
        for (const [statusKey, status] of matched) {
          const nextStatus = { ...status }
          delete nextStatus.latest
          statuses[statusKey] = nextStatus
        }
        this.store.commitAutomationOutcome(
          surface.id,
          [
            {
              target: 'state',
              op: 'replace',
              path: `/${AUTOMATION_OUTCOMES_STATE_KEY}`,
              value: JsonValueSchema.parse(statuses),
            },
          ],
          {
            automationId: matched[0]![1].automationId,
            scheduledFor: settledAt,
            kind: 'unchanged',
            summary: 'Automation decision completed',
            idempotencyKey: `automation-decision-settled:${decisionScope}:${surface.id}:${matched.map(([, status]) => `${status.automationId}-${status.lastCheckedAt}`).join(',')}`,
            origin: actor,
          },
        )
      }
    })
  }

  clearAutomationTarget(
    automationId: number,
    spaceId: string,
    targetSurfaceId: string,
    origin: Origin = 'trusted:system',
    clearedAt = this.nowIso(),
  ): void {
    this.notifications.settleTarget(
      spaceId,
      targetSurfaceId,
      automationId,
      clearedAt,
      origin,
      'target-cleared',
    )
    const surface = this.store.getSurface(targetSurfaceId)
    if (!surface || surface.spaceId !== spaceId) return
    const parsed = AutomationOutcomeStatusesSchema.safeParse(
      surface.state[AUTOMATION_OUTCOMES_STATE_KEY],
    )
    const statusKey = String(automationId)
    const status = parsed.success ? parsed.data[statusKey] : undefined
    if (!status) return
    const statuses = { ...parsed.data }
    delete statuses[statusKey]
    this.store.commitAutomationOutcome(
      targetSurfaceId,
      [
        {
          target: 'state',
          op: 'replace',
          path: `/${AUTOMATION_OUTCOMES_STATE_KEY}`,
          value: JsonValueSchema.parse(statuses),
        },
      ],
      {
        automationId,
        scheduledFor: clearedAt,
        kind: 'unchanged',
        summary: 'Automation outcome target cleared',
        idempotencyKey: `automation-target-cleared:${automationId}:${targetSurfaceId}:${status.lastCheckedAt}`,
        origin,
      },
    )
  }

  reconcileAutomationTargets(
    activeTargets: readonly {
      automationId: number
      spaceId: string
      targetSurfaceIds: readonly string[]
    }[],
  ): void {
    const active = new Set(
      activeTargets.flatMap((entry) =>
        entry.targetSurfaceIds.map(
          (targetSurfaceId) => `${entry.automationId}\0${entry.spaceId}\0${targetSurfaceId}`,
        ),
      ),
    )
    const storedTargets = new Map<
      string,
      {
        automationId: number
        spaceId: string
        targetSurfaceId: string
      }
    >()
    const remember = (entry: {
      automationId: number
      spaceId: string
      targetSurfaceId: string
    }) => {
      storedTargets.set(`${entry.automationId}\0${entry.spaceId}\0${entry.targetSurfaceId}`, entry)
    }
    for (const row of this.db
      .prepare(
        `select distinct automation_id, space_id, target_surface_id
         from automation_outcome_deliveries`,
      )
      .all()) {
      remember({
        automationId: requiredNumber(row, 'automation_id'),
        spaceId: requiredString(row, 'space_id'),
        targetSurfaceId: requiredString(row, 'target_surface_id'),
      })
    }
    for (const space of this.store.spacesEngine.listAllSpaces()) {
      for (const surface of this.store.listSurfaces(space.id)) {
        const statuses = AutomationOutcomeStatusesSchema.safeParse(
          surface.state[AUTOMATION_OUTCOMES_STATE_KEY],
        )
        if (!statuses.success) continue
        for (const status of Object.values(statuses.data)) {
          remember({
            automationId: status.automationId,
            spaceId: space.id,
            targetSurfaceId: surface.id,
          })
        }
      }
      for (const notification of this.notifications.all(space.id)) {
        remember({
          automationId: notification.automationId,
          spaceId: space.id,
          targetSurfaceId: notification.surfaceId,
        })
      }
    }
    for (const { automationId, spaceId, targetSurfaceId } of storedTargets.values()) {
      if (active.has(`${automationId}\0${spaceId}\0${targetSurfaceId}`)) continue
      this.clearAutomationTarget(automationId, spaceId, targetSurfaceId)
    }
  }

  private redirectUnavailableDelivery(
    original: AutomationOutcomeOccurrence,
    fallback: AutomationOutcomeOccurrence,
    outcome: AutomationOutcomeInput,
  ): void {
    if (
      original.automationId !== fallback.automationId ||
      original.spaceId !== fallback.spaceId ||
      original.scheduledFor !== fallback.scheduledFor ||
      original.targetSurfaceId === fallback.targetSurfaceId
    ) {
      throw new Error('invalid Automation outcome fallback redirect')
    }
    const { targetVersion } = this.requireTarget(fallback)
    const originalId = deliveryIdFor(original)
    const fallbackId = deliveryIdFor(fallback)
    const completedAt = this.nowIso()
    withImmediateTransaction(this.db, () => {
      this.db
        .prepare(
          `insert or ignore into automation_outcome_delivery_tombstones
             (id, outcome_kind, completed_at, redirect_delivery_id)
           values (?, 'failed', ?, ?)
           on conflict(id) do update set redirect_delivery_id = excluded.redirect_delivery_id`,
        )
        .run(originalId, completedAt, fallbackId)
      const fallbackExists = this.db
        .prepare('select id from automation_outcome_deliveries where id = ?')
        .get(fallbackId)
      if (fallbackExists) {
        this.db
          .prepare(
            'delete from automation_outcome_deliveries where id = ? and completed_at is null',
          )
          .run(originalId)
        return
      }
      const redirected = this.db
        .prepare(
          `update automation_outcome_deliveries
           set id = ?, target_surface_id = ?, target_version = ?, description = ?,
               checked_at = ?, origin = ?, outcome_kind = ?, outcome_json = ?
           where id = ? and completed_at is null`,
        )
        .run(
          fallbackId,
          fallback.targetSurfaceId,
          targetVersion,
          fallback.description,
          fallback.checkedAt,
          fallback.origin,
          outcome.kind,
          JSON.stringify(outcome),
          originalId,
        )
      if (Number(redirected.changes) > 0) return
      this.db
        .prepare(
          `insert into automation_outcome_deliveries
             (id, automation_id, space_id, target_surface_id, description, scheduled_for,
              checked_at, target_version, origin, outcome_kind, outcome_json)
           values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          fallbackId,
          fallback.automationId,
          fallback.spaceId,
          fallback.targetSurfaceId,
          fallback.description,
          fallback.scheduledFor,
          fallback.checkedAt,
          targetVersion,
          fallback.origin,
          outcome.kind,
          JSON.stringify(outcome),
        )
    })
  }

  private deliverNow(
    occurrenceInput: AutomationOutcomeOccurrence,
    outcomeInput: AutomationOutcomeInput,
  ): AutomationOutcomeInput {
    this.notifications.recoverPending()
    const deliveryId = deliveryIdFor(occurrenceInput)
    const existingDelivery = this.db
      .prepare('select id from automation_outcome_deliveries where id = ?')
      .get(deliveryId)
    if (!existingDelivery) {
      const tombstone = this.db
        .prepare('select * from automation_outcome_delivery_tombstones where id = ?')
        .get(deliveryId)
      if (tombstone) {
        const redirectId = optionalString(tombstone, 'redirect_delivery_id')
        if (redirectId !== undefined) {
          const redirectedRow = this.db
            .prepare('select * from automation_outcome_deliveries where id = ?')
            .get(redirectId)
          if (redirectedRow) {
            const redirected = deliveryFromRow(redirectedRow)
            if (redirected.completedAt !== undefined) return redirected.outcome
            return this.deliverNow(occurrenceFromDelivery(redirected), redirected.outcome)
          }
        }
        return replayedAutomationOutcome(
          AutomationOutcomeKindSchema.parse(requiredString(tombstone, 'outcome_kind')),
          outcomeInput,
        )
      }
    }
    let outcome = outcomeInput
    let unavailableFallbacks: string[] | undefined
    let targetVersion: number | undefined
    if (!existingDelivery) {
      const currentTargetVersion = this.requireTarget(occurrenceInput).targetVersion
      targetVersion = occurrenceInput.expectedTargetVersion ?? currentTargetVersion
      unavailableFallbacks = this.unavailableFallbackTargets(occurrenceInput)
      outcome = promoteAutomationRecovery(
        this.hasUnrecoveredFailure(occurrenceInput) || unavailableFallbacks.length > 0,
        outcomeInput,
      )
      outcome = this.validateProducerOutcome(occurrenceInput.targetSurfaceId, outcome)
    }
    this.db
      .prepare(
        `insert or ignore into automation_outcome_deliveries
           (id, automation_id, space_id, target_surface_id, description, scheduled_for, checked_at, origin,
            target_version, outcome_kind, outcome_json)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        deliveryId,
        occurrenceInput.automationId,
        occurrenceInput.spaceId,
        occurrenceInput.targetSurfaceId,
        occurrenceInput.description,
        occurrenceInput.scheduledFor,
        occurrenceInput.checkedAt,
        occurrenceInput.origin,
        targetVersion ?? null,
        outcome.kind,
        JSON.stringify(outcome),
      )
    let delivery = this.requireDelivery(deliveryId)
    if (delivery.completedAt !== undefined) return delivery.outcome
    if (
      delivery.outcome.kind === 'decision-required' &&
      this.terminalDecisionIds.has(delivery.outcome.decisionId)
    ) {
      delivery = this.replacePendingOutcome(delivery, {
        kind: 'unchanged',
        summary: 'Automation decision is no longer pending',
      })
    }

    const { surface, space } = this.requireTarget(delivery)
    delivery = this.commitSurfaceOutcome(delivery, surface)

    for (const fallbackSurfaceId of unavailableFallbacks ??
      this.unavailableFallbackTargets(delivery)) {
      this.clearUnavailableFallback(delivery, fallbackSurfaceId)
    }

    if (delivery.outcome.kind === 'recovered' || delivery.outcome.kind === 'decision-required') {
      this.notifications.settleFailures(delivery)
    }
    if (
      delivery.outcome.kind === 'changed' ||
      delivery.outcome.kind === 'failed' ||
      delivery.outcome.kind === 'recovered'
    ) {
      this.notifications.record(delivery, space.slug)
      this.recordHistory(delivery)
    }
    const completedAt = this.nowIso()
    withImmediateTransaction(this.db, () => {
      this.db
        .prepare('update automation_outcome_deliveries set completed_at = ? where id = ?')
        .run(completedAt, delivery.id)
      this.db
        .prepare(
          `insert or ignore into automation_outcome_delivery_tombstones
             (id, outcome_kind, completed_at) values (?, ?, ?)`,
        )
        .run(delivery.id, delivery.outcome.kind, completedAt)
    })
    this.pruneCompletedDeliveries(delivery)
    return delivery.outcome
  }

  private commitSurfaceOutcome(
    delivery: StoredAutomationOutcomeDelivery,
    surface: Surface,
  ): StoredAutomationOutcomeDelivery {
    const hasStatuses = Object.prototype.hasOwnProperty.call(
      surface.state,
      AUTOMATION_OUTCOMES_STATE_KEY,
    )
    const previousStatuses = AutomationOutcomeStatusesSchema.safeParse(
      surface.state[AUTOMATION_OUTCOMES_STATE_KEY],
    )
    if (hasStatuses && !previousStatuses.success) {
      throw new AutomationOutcomeUnavailableError()
    }
    const statuses = previousStatuses.success ? previousStatuses.data : {}
    const statusKey = String(delivery.automationId)
    const status = nextAutomationOutcomeStatus(
      statuses[statusKey],
      delivery.outcome,
      delivery.checkedAt,
      delivery.automationId,
    )
    const statusOperation: PatchOperation = {
      target: 'state',
      op: hasStatuses ? 'replace' : 'add',
      path: `/${AUTOMATION_OUTCOMES_STATE_KEY}`,
      value: JsonValueSchema.parse({ ...statuses, [statusKey]: status }),
    }
    const contentOperations =
      delivery.outcome.kind === 'changed' || delivery.outcome.kind === 'recovered'
        ? delivery.outcome.operations
        : []
    const notificationIntent = this.notifications.outcomeEventIntent(delivery)
    try {
      this.store.commitAutomationOutcome(
        delivery.targetSurfaceId,
        [...contentOperations, statusOperation],
        {
          automationId: delivery.automationId,
          scheduledFor: delivery.scheduledFor,
          kind: delivery.outcome.kind,
          summary: delivery.outcome.summary,
          idempotencyKey: `automation-outcome:${delivery.id}`,
          ...(contentOperations.length === 0 || delivery.targetVersion === undefined
            ? {}
            : { expectedVersion: delivery.targetVersion }),
          origin: delivery.origin,
          checkedAt: delivery.checkedAt,
          historyId: delivery.id,
          ...(notificationIntent === undefined ? {} : { notificationIntent }),
        },
      )
      return delivery
    } catch (error) {
      if (!(error instanceof SurfaceVersionConflictError) || contentOperations.length === 0) {
        throw error
      }
      const staleOutcome: AutomationOutcomeInput = {
        kind: 'failed',
        summary: 'Automation outcome could not be applied',
        coalesceKey: 'stale-outcome',
        error: {
          code: 'stale_outcome',
          message: 'The linked Surface changed after this Automation checked it.',
        },
      }
      const revised = this.replacePendingOutcome(delivery, staleOutcome)
      const latest = this.requireTarget(revised).surface
      return this.commitSurfaceOutcome(revised, latest)
    }
  }

  private replacePendingOutcome(
    delivery: StoredAutomationOutcomeDelivery,
    outcome: AutomationOutcomeInput,
  ): StoredAutomationOutcomeDelivery {
    this.db
      .prepare(
        `update automation_outcome_deliveries
         set outcome_kind = ?, outcome_json = ?
         where id = ? and completed_at is null`,
      )
      .run(outcome.kind, JSON.stringify(outcome), delivery.id)
    return this.requireDelivery(delivery.id)
  }

  private hasUnrecoveredFailure(delivery: {
    automationId: number
    spaceId: string
    targetSurfaceId: string
  }): boolean {
    const surface = this.store.getStoredSurface(delivery.targetSurfaceId)
    const statuses = AutomationOutcomeStatusesSchema.safeParse(
      surface?.state[AUTOMATION_OUTCOMES_STATE_KEY],
    )
    if (statuses.success && statuses.data[String(delivery.automationId)]?.currentError) {
      return true
    }
    const row = this.db
      .prepare(
        `select * from automation_outcome_deliveries
         where automation_id = ? and space_id = ? and target_surface_id = ?
           and completed_at is not null
           and outcome_kind in ('failed', 'recovered', 'decision-required')
         order by scheduled_for desc, id desc
         limit 1`,
      )
      .get(delivery.automationId, delivery.spaceId, delivery.targetSurfaceId)
    const latestFailureState = row ? deliveryFromRow(row) : undefined
    return latestFailureState?.outcome.kind === 'failed'
  }

  private unavailableFallbackTargets(delivery: {
    automationId: number
    spaceId: string
    targetSurfaceId: string
  }): string[] {
    const targetIds = new Set(
      this.db
        .prepare(
          `select distinct target_surface_id from automation_outcome_deliveries
           where automation_id = ? and space_id = ? and target_surface_id != ?`,
        )
        .all(delivery.automationId, delivery.spaceId, delivery.targetSurfaceId)
        .map((row) => requiredString(row, 'target_surface_id')),
    )
    for (const surface of this.store.listSurfaces(delivery.spaceId)) {
      if (surface.id !== delivery.targetSurfaceId) targetIds.add(surface.id)
    }
    return [...targetIds].filter((targetSurfaceId) => {
      const surface = this.store.getStoredSurface(targetSurfaceId)
      if (!surface) return false
      const statuses = AutomationOutcomeStatusesSchema.safeParse(
        surface.state[AUTOMATION_OUTCOMES_STATE_KEY],
      )
      return (
        statuses.success &&
        statuses.data[String(delivery.automationId)]?.currentError?.code === 'target_unavailable'
      )
    })
  }

  private clearUnavailableFallback(
    delivery: StoredAutomationOutcomeDelivery,
    fallbackSurfaceId: string,
  ): void {
    const surface = this.store.getStoredSurface(fallbackSurfaceId)
    if (!surface) return
    const parsed = AutomationOutcomeStatusesSchema.safeParse(
      surface.state[AUTOMATION_OUTCOMES_STATE_KEY],
    )
    if (!parsed.success) return
    const statusKey = String(delivery.automationId)
    if (parsed.data[statusKey]?.currentError?.code !== 'target_unavailable') return
    const statuses = { ...parsed.data }
    delete statuses[statusKey]
    this.notifications.settleFailures({ ...delivery, targetSurfaceId: fallbackSurfaceId })
    this.store.commitAutomationOutcome(
      fallbackSurfaceId,
      [
        {
          target: 'state',
          op: 'replace',
          path: `/${AUTOMATION_OUTCOMES_STATE_KEY}`,
          value: JsonValueSchema.parse(statuses),
        },
      ],
      {
        automationId: delivery.automationId,
        scheduledFor: delivery.scheduledFor,
        kind: 'recovered',
        summary: 'Automation target is available again',
        idempotencyKey: `automation-outcome-target-recovered:${delivery.id}:${fallbackSurfaceId}`,
        origin: delivery.origin,
        checkedAt: delivery.checkedAt,
        recordInHistory: false,
      },
    )
  }

  private pruneCompletedDeliveries(delivery: StoredAutomationOutcomeDelivery): void {
    this.db
      .prepare(
        `delete from automation_outcome_deliveries
         where automation_id = ? and space_id = ? and target_surface_id = ?
           and completed_at is not null
           and id not in (
             select id from automation_outcome_deliveries
             where automation_id = ? and space_id = ? and target_surface_id = ?
               and completed_at is not null
             order by scheduled_for desc, id desc
             limit ?
           )`,
      )
      .run(
        delivery.automationId,
        delivery.spaceId,
        delivery.targetSurfaceId,
        delivery.automationId,
        delivery.spaceId,
        delivery.targetSurfaceId,
        MAX_RETAINED_DELIVERIES_PER_TARGET,
      )
  }

  private validateProducerOutcome(
    targetSurfaceId: string,
    outcome: AutomationOutcomeInput,
  ): AutomationOutcomeInput {
    if (
      (outcome.kind !== 'changed' && outcome.kind !== 'recovered') ||
      outcome.operations.length === 0
    ) {
      return outcome
    }
    try {
      this.store.validateAutomationOutcomeOperations(targetSurfaceId, outcome.operations)
      return outcome
    } catch {
      return {
        kind: 'failed',
        summary: 'Automation outcome could not be applied',
        coalesceKey: 'invalid-outcome',
        error: {
          code: 'invalid_outcome',
          message: 'The Automation outcome did not match its linked Surface.',
        },
      }
    }
  }

  private recordHistory(delivery: StoredAutomationOutcomeDelivery): void {
    if (
      delivery.outcome.kind !== 'changed' &&
      delivery.outcome.kind !== 'failed' &&
      delivery.outcome.kind !== 'recovered'
    ) {
      return
    }
    this.db
      .prepare(
        `insert or ignore into automation_outcome_history
           (id, automation_id, scheduled_for, kind, summary, at, origin)
         values (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        delivery.id,
        delivery.automationId,
        delivery.scheduledFor,
        delivery.outcome.kind,
        delivery.outcome.summary,
        delivery.checkedAt,
        delivery.origin,
      )
    this.pruneHistory(delivery.automationId)
  }

  private reconcileHistoryWithEvents(
    recoveryLogs: ReadonlyMap<string, AutomationOutcomeRecoveryLog>,
  ): Set<string> {
    const recoveredSpaceIds = new Set<string>()
    for (const space of this.store.spacesEngine.listAllSpaces()) {
      for (const event of recoveryLogs.get(space.id)?.events ?? []) {
        if (event.type !== 'automation.outcome' || event.payload?.['recordInHistory'] === false) {
          continue
        }
        const payload = event.payload
        const automationId = payload?.['automationId']
        const scheduledFor = payload?.['scheduledFor']
        const kind = payload?.['kind']
        const summary = payload?.['summary']
        const checkedAt = payload?.['checkedAt']
        if (
          typeof automationId !== 'number' ||
          typeof scheduledFor !== 'string' ||
          typeof kind !== 'string' ||
          typeof summary !== 'string'
        ) {
          continue
        }
        const suppliedId = payload?.['historyId']
        const id =
          typeof suppliedId === 'string'
            ? suppliedId
            : `event:${createHash('sha256')
                .update(
                  `${space.id}\0${automationId}\0${scheduledFor}\0${event.at}\0${kind}\0${summary}`,
                )
                .digest('hex')}`
        const parsed = AutomationRunHistoryEntrySchema.safeParse({
          id,
          automationId,
          scheduledFor,
          kind,
          summary,
          at: typeof checkedAt === 'string' ? checkedAt : event.at,
        })
        if (!parsed.success) continue
        this.db
          .prepare(
            `insert or ignore into automation_outcome_history
               (id, automation_id, scheduled_for, kind, summary, at, origin)
             values (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            parsed.data.id,
            parsed.data.automationId,
            parsed.data.scheduledFor,
            parsed.data.kind,
            parsed.data.summary,
            parsed.data.at,
            event.origin,
          )
        this.pruneHistory(parsed.data.automationId)
        recoveredSpaceIds.add(space.id)
      }
    }
    return recoveredSpaceIds
  }

  private recoveryLogs(): Map<string, AutomationOutcomeRecoveryLog> {
    const logs = new Map<string, AutomationOutcomeRecoveryLog>()
    for (const space of this.store.spacesEngine.listAllSpaces()) {
      const row = this.db
        .prepare(
          `select last_event_at, last_event_fingerprint
           from automation_outcome_event_watermarks where space_id = ?`,
        )
        .get(space.id)
      if (!row) {
        logs.set(space.id, { events: this.store.eventLog(space.id), full: true })
        continue
      }
      const since = requiredString(row, 'last_event_at')
      const expectedFingerprint = requiredString(row, 'last_event_fingerprint')
      const recent = this.store.eventLogSince(space.id, since)
      if (
        expectedFingerprint === EMPTY_EVENT_WATERMARK ||
        recent.some((event) => eventFingerprint(event) === expectedFingerprint)
      ) {
        logs.set(space.id, { events: recent, full: false, since })
      } else {
        logs.set(space.id, { events: this.store.eventLog(space.id), full: true })
      }
    }
    return logs
  }

  private storeRecoveryWatermarks(
    recoveryLogs: ReadonlyMap<string, AutomationOutcomeRecoveryLog>,
  ): void {
    for (const [spaceId, log] of recoveryLogs) {
      const lastScanned = log.events.at(-1)
      if (!lastScanned) {
        this.db
          .prepare(
            `insert into automation_outcome_event_watermarks
               (space_id, last_event_at, last_event_fingerprint)
             values (?, ?, ?)
             on conflict(space_id) do update set
               last_event_at = excluded.last_event_at,
               last_event_fingerprint = excluded.last_event_fingerprint`,
          )
          .run(spaceId, log.since ?? EVENT_WATERMARK_EPOCH, EMPTY_EVENT_WATERMARK)
        continue
      }
      const latest = this.store.eventLogSince(spaceId, lastScanned.at).at(-1) ?? lastScanned
      this.db
        .prepare(
          `insert into automation_outcome_event_watermarks
             (space_id, last_event_at, last_event_fingerprint)
           values (?, ?, ?)
           on conflict(space_id) do update set
             last_event_at = excluded.last_event_at,
             last_event_fingerprint = excluded.last_event_fingerprint`,
        )
        .run(spaceId, latest.at, eventFingerprint(latest))
    }
  }

  private pruneHistory(automationId: number): void {
    this.db
      .prepare(
        `delete from automation_outcome_history where automation_id = ? and id not in (
           select id from automation_outcome_history where automation_id = ?
           order by at desc, id desc limit ?
         )`,
      )
      .run(automationId, automationId, MAX_AUTOMATION_RUN_HISTORY)
  }

  private requireDelivery(id: string): StoredAutomationOutcomeDelivery {
    const row = this.db.prepare('select * from automation_outcome_deliveries where id = ?').get(id)
    if (!row) throw new Error(`missing Automation outcome delivery ${id}`)
    return deliveryFromRow(row)
  }

  private requireTarget(delivery: { spaceId: string; targetSurfaceId: string }) {
    const space = this.store.getSpace(delivery.spaceId)
    const surface = this.store.getStoredSurface(delivery.targetSurfaceId)
    if (!space || !surface || surface.spaceId !== space.id) {
      throw new AutomationOutcomeUnavailableError()
    }
    const targetVersion = this.store.getSurfaceVersion(surface.id)?.version
    if (targetVersion === undefined) throw new AutomationOutcomeUnavailableError()
    return { space, surface, targetVersion }
  }

  private nowIso(): string {
    return this.now().toISOString()
  }
}

function deliveryIdFor(occurrence: AutomationOutcomeOccurrence): string {
  const targetScope = createHash('sha256')
    .update(`${occurrence.spaceId}\0${occurrence.targetSurfaceId}`)
    .digest('hex')
    .slice(0, 16)
  return `${occurrence.automationId}:${occurrence.scheduledFor}:${targetScope}`
}

function eventFingerprint(event: SpaceEvent): string {
  return createHash('sha256').update(JSON.stringify(event)).digest('hex')
}

function occurrenceFromDelivery(
  delivery: StoredAutomationOutcomeDelivery,
): AutomationOutcomeOccurrence {
  return {
    automationId: delivery.automationId,
    spaceId: delivery.spaceId,
    targetSurfaceId: delivery.targetSurfaceId,
    description: delivery.description,
    scheduledFor: delivery.scheduledFor,
    checkedAt: delivery.checkedAt,
    origin: delivery.origin,
  }
}
