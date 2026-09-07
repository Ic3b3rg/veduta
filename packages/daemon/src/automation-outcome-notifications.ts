import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import {
  AutomationOutcomeNotificationActionResultSchema,
  AutomationOutcomeNotificationSchema,
  AutomationOutcomeNotificationSnapshotSchema,
  JsonObjectSchema,
  surfacePath,
  type AutomationOutcomeNotification,
  type AutomationOutcomeNotificationActionResult,
  type AutomationOutcomeNotificationSnapshot,
  type Surface,
} from '@veduta/protocol'
import {
  notificationIntentFromRow,
  notificationFromRow,
  type StoredAutomationOutcomeDelivery,
  type StoredAutomationOutcomeNotificationIntent,
} from './automation-outcome-persistence.ts'
import { requiredNumber, withImmediateTransaction } from './sqlite-rows.ts'
import type { SpaceEvent } from './space-events.ts'
import type { AutomationOutcomeRecoveryLog } from './automation-outcome-service.ts'
import type { Store } from './store.ts'
import type { Origin } from './taint.ts'

export interface AutomationOutcomeLifecycleEvent {
  revision: number
  notification: AutomationOutcomeNotification
}

export class AutomationOutcomeUnavailableError extends Error {
  constructor() {
    super('Automation outcome is unavailable in this Space')
    this.name = 'AutomationOutcomeUnavailableError'
  }
}

/** Durable notification state and its crash/backup reconciliation boundary. */
export class AutomationOutcomeNotifications {
  private readonly listeners = new Set<(event: AutomationOutcomeLifecycleEvent) => void>()
  private readonly disposeSurfaceEventListener: () => void

  constructor(
    private readonly db: DatabaseSync,
    private readonly store: Store,
    private readonly now: () => Date,
  ) {
    this.disposeSurfaceEventListener = this.store.onSurfaceEvent((event) => {
      if (event.kind !== 'archived') return
      try {
        this.settleTarget(
          event.event.spaceId,
          event.event.surfaceId,
          undefined,
          event.event.at,
          'trusted:system',
          'surface-archived',
        )
      } catch (error) {
        console.error('Automation notification archival settlement failed', error)
      }
    })
  }

  close(): void {
    this.disposeSurfaceEventListener()
  }

  onLifecycle(listener: (event: AutomationOutcomeLifecycleEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  recover(recoveryLogs: ReadonlyMap<string, AutomationOutcomeRecoveryLog>): void {
    const knownEventRefs = this.reconcileIntentsWithEvents(recoveryLogs)
    this.recoverIntents(knownEventRefs)
    this.reconcileOutcomeEvents(recoveryLogs)
    this.settleUnavailable()
  }

  recoverPending(): void {
    this.recoverIntents()
  }

  list(spaceId: string): AutomationOutcomeNotificationSnapshot {
    this.requireSpace(spaceId)
    this.settleUnavailable(spaceId)
    return AutomationOutcomeNotificationSnapshotSchema.parse({
      revision: this.revision(),
      notifications: this.db
        .prepare(
          `select * from automation_outcome_notifications
           where space_id = ? and state = 'unread'
           order by updated_at desc, id`,
        )
        .all(spaceId)
        .map(notificationFromRow),
    })
  }

  all(spaceId: string): AutomationOutcomeNotification[] {
    this.requireSpace(spaceId)
    return this.db
      .prepare(
        `select * from automation_outcome_notifications
         where space_id = ? order by updated_at desc, id`,
      )
      .all(spaceId)
      .map(notificationFromRow)
  }

  open(
    spaceId: string,
    notificationId: string,
    actor: 'trusted:user',
  ): AutomationOutcomeNotificationActionResult {
    return this.transition(spaceId, notificationId, 'opened', actor)
  }

  dismiss(
    spaceId: string,
    notificationId: string,
    actor: 'trusted:user',
  ): AutomationOutcomeNotificationActionResult {
    return this.transition(spaceId, notificationId, 'dismissed', actor)
  }

  record(delivery: StoredAutomationOutcomeDelivery, spaceSlug: string): void {
    if (
      delivery.outcome.kind !== 'changed' &&
      delivery.outcome.kind !== 'failed' &&
      delivery.outcome.kind !== 'recovered'
    ) {
      return
    }
    const replay = this.db
      .prepare('select id from automation_outcome_notifications where last_delivery_id = ?')
      .get(delivery.id)
    if (replay) return

    const coalesceKey = notificationCoalesceKeyFor(delivery.outcome.coalesceKey)

    const existingRow = this.db
      .prepare(
        `select * from automation_outcome_notifications
         where automation_id = ? and surface_id = ? and kind = ? and coalesce_key = ?
           and space_id = ? and state = 'unread'
         order by updated_at desc limit 1`,
      )
      .get(
        delivery.automationId,
        delivery.targetSurfaceId,
        delivery.outcome.kind,
        coalesceKey,
        delivery.spaceId,
      )
    const existing = existingRow ? notificationFromRow(existingRow) : undefined
    const notification = AutomationOutcomeNotificationSchema.parse({
      id: existing?.id ?? notificationIdFor(delivery.id),
      revision: this.revision() + 1,
      spaceId: delivery.spaceId,
      spaceSlug,
      automationId: delivery.automationId,
      surfaceId: delivery.targetSurfaceId,
      kind: delivery.outcome.kind,
      title: notificationTitle(delivery.description, delivery.outcome.kind),
      summary: delivery.outcome.summary,
      coalesceKey,
      occurrenceCount: (existing?.occurrenceCount ?? 0) + 1,
      state: 'unread',
      createdAt: existing?.createdAt ?? delivery.checkedAt,
      updatedAt: delivery.checkedAt,
      href: surfacePath(spaceSlug, delivery.targetSurfaceId),
    })
    const eventType = existing
      ? 'automation.notification.coalesce'
      : 'automation.notification.create'
    const committed = this.commitMutation({
      id: `${delivery.id}:notify`,
      spaceId: delivery.spaceId,
      eventType,
      eventText: `${notification.title}: ${notification.summary}`,
      origin: delivery.origin,
      notification,
      stateMarker: delivery.id,
    })
    if (committed.changed) this.publish(committed.notification)
  }

  outcomeEventIntent(delivery: StoredAutomationOutcomeDelivery) {
    if (
      delivery.outcome.kind !== 'changed' &&
      delivery.outcome.kind !== 'failed' &&
      delivery.outcome.kind !== 'recovered'
    ) {
      return undefined
    }
    return JsonObjectSchema.parse({
      v: 1,
      deliveryId: delivery.id,
      automationId: delivery.automationId,
      surfaceRef: notificationSurfaceRef(delivery.targetSurfaceId),
      kind: delivery.outcome.kind,
      title: notificationTitle(delivery.description, delivery.outcome.kind),
      summary: delivery.outcome.summary,
      coalesceKey: notificationCoalesceKeyFor(delivery.outcome.coalesceKey),
      checkedAt: delivery.checkedAt,
    })
  }

  settleFailures(delivery: StoredAutomationOutcomeDelivery): void {
    const rows = this.db
      .prepare(
        `select * from automation_outcome_notifications
         where automation_id = ? and surface_id = ? and kind = 'failed'
           and state = 'unread' and space_id = ?
         order by updated_at, id`,
      )
      .all(delivery.automationId, delivery.targetSurfaceId, delivery.spaceId)
    for (const row of rows) {
      const current = notificationFromRow(row)
      const marker = `${delivery.id}:settle:${current.id}`
      const committed = this.commitMutation({
        id: marker,
        spaceId: delivery.spaceId,
        eventType: 'automation.notification.settle',
        eventText: 'Settled an Automation failure notification after a successful check',
        origin: delivery.origin,
        notification: {
          ...current,
          revision: this.revision() + 1,
          state: 'settled',
          updatedAt: delivery.checkedAt,
        },
        stateMarker: marker,
      })
      if (committed.changed) this.publish(committed.notification)
    }
  }

  settleTarget(
    spaceId: string,
    surfaceId: string,
    automationId: number | undefined,
    settledAt: string,
    origin: Origin,
    reason: string,
  ): void {
    const rows = this.db
      .prepare(
        `select * from automation_outcome_notifications
         where space_id = ? and surface_id = ? and state = 'unread'
           and (? is null or automation_id = ?)
         order by updated_at, id`,
      )
      .all(spaceId, surfaceId, automationId ?? null, automationId ?? null)
    for (const row of rows) {
      const current = notificationFromRow(row)
      const marker = `${reason}:${current.id}:${current.revision}`
      const committed = this.commitMutation({
        id: marker,
        spaceId,
        eventType: 'automation.notification.settle',
        eventText: 'Settled an Automation notification whose target is no longer active',
        origin,
        notification: {
          ...current,
          revision: this.revision() + 1,
          state: 'settled',
          updatedAt: settledAt,
        },
        stateMarker: marker,
      })
      if (committed.changed) this.publish(committed.notification)
    }
  }

  private settleUnavailable(spaceId?: string): void {
    const rows =
      spaceId === undefined
        ? this.db
            .prepare(
              `select * from automation_outcome_notifications
               where state = 'unread' order by space_id, surface_id, id`,
            )
            .all()
        : this.db
            .prepare(
              `select * from automation_outcome_notifications
               where state = 'unread' and space_id = ? order by surface_id, id`,
            )
            .all(spaceId)
    const settledTargets = new Set<string>()
    for (const row of rows) {
      const notification = notificationFromRow(row)
      const target = this.store.getStoredSurface(notification.surfaceId)
      if (target?.spaceId === notification.spaceId) continue
      const key = `${notification.spaceId}\0${notification.surfaceId}`
      if (settledTargets.has(key)) continue
      settledTargets.add(key)
      this.settleTarget(
        notification.spaceId,
        notification.surfaceId,
        undefined,
        this.nowIso(),
        'trusted:system',
        'surface-unavailable',
      )
    }
  }

  private transition(
    spaceId: string,
    notificationId: string,
    state: 'opened' | 'dismissed',
    actor: 'trusted:user',
  ): AutomationOutcomeNotificationActionResult {
    this.recoverIntents()
    this.requireSpace(spaceId)
    const row = this.db
      .prepare('select * from automation_outcome_notifications where id = ? and space_id = ?')
      .get(notificationId, spaceId)
    if (!row) throw new AutomationOutcomeUnavailableError()
    const current = notificationFromRow(row)
    if (state === 'opened') {
      const target = this.store.getStoredSurface(current.surfaceId)
      if (target?.spaceId !== current.spaceId) throw new AutomationOutcomeUnavailableError()
    }
    if (current.state !== 'unread') {
      return AutomationOutcomeNotificationActionResultSchema.parse({
        revision: current.revision,
        notification: current,
      })
    }
    const marker = `${notificationId}:${state}`
    const committed = this.commitMutation({
      id: marker,
      spaceId,
      eventType: `automation.notification.${state}`,
      eventText: `${state === 'opened' ? 'Opened' : 'Dismissed'} an Automation outcome notification`,
      origin: actor,
      notification: {
        ...current,
        revision: this.revision() + 1,
        state,
        updatedAt: this.nowIso(),
      },
      stateMarker: marker,
    })
    if (committed.changed) this.publish(committed.notification)
    return AutomationOutcomeNotificationActionResultSchema.parse({
      revision: committed.notification.revision,
      notification: committed.notification,
    })
  }

  private commitMutation(
    input: Omit<StoredAutomationOutcomeNotificationIntent, 'completedAt'>,
    knownEventAppended?: boolean,
  ): {
    notification: AutomationOutcomeNotification
    changed: boolean
  } {
    const validatedInput = {
      ...input,
      notification: AutomationOutcomeNotificationSchema.parse(input.notification),
    }
    const inserted = this.db
      .prepare(
        `insert or ignore into automation_outcome_notification_intents
           (id, space_id, event_type, event_text, origin, notification_json, state_marker)
         values (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        validatedInput.id,
        validatedInput.spaceId,
        validatedInput.eventType,
        validatedInput.eventText,
        validatedInput.origin,
        JSON.stringify(validatedInput.notification),
        validatedInput.stateMarker,
      )
    const intent = this.requireIntent(validatedInput.id)
    if (intent.completedAt !== undefined) {
      return { notification: intent.notification, changed: false }
    }

    const eventAlreadyAppended =
      knownEventAppended ??
      (Number(inserted.changes) === 0 &&
        this.store
          .eventLog(intent.spaceId)
          .some((event) => event.payload?.['notificationEventId'] === intent.id))
    if (!eventAlreadyAppended) this.appendIntentEvent(intent)
    withImmediateTransaction(this.db, () => {
      this.writeNotification(intent.notification, intent.stateMarker)
      this.setRevision(intent.notification.revision)
      this.db
        .prepare(
          `update automation_outcome_notification_intents
           set completed_at = ? where id = ? and completed_at is null`,
        )
        .run(this.nowIso(), intent.id)
    })
    const stored = this.db
      .prepare('select * from automation_outcome_notifications where id = ?')
      .get(intent.notification.id)
    if (!stored) throw new Error(`missing Automation notification ${intent.notification.id}`)
    const notification = notificationFromRow(stored)
    return {
      notification,
      changed: notification.revision === intent.notification.revision,
    }
  }

  private writeNotification(notification: AutomationOutcomeNotification, deliveryId: string): void {
    this.db
      .prepare(
        `insert into automation_outcome_notifications
           (id, revision, space_id, space_slug, automation_id, surface_id, kind, title, summary,
            coalesce_key, occurrence_count, state, created_at, updated_at, href, last_delivery_id)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         on conflict(id) do update set
           revision = excluded.revision,
           space_slug = excluded.space_slug,
           automation_id = excluded.automation_id,
           surface_id = excluded.surface_id,
           kind = excluded.kind,
           title = excluded.title,
           summary = excluded.summary,
           coalesce_key = excluded.coalesce_key,
           occurrence_count = excluded.occurrence_count,
           state = excluded.state,
           updated_at = excluded.updated_at,
           href = excluded.href,
           last_delivery_id = excluded.last_delivery_id
         where excluded.revision >= automation_outcome_notifications.revision`,
      )
      .run(
        notification.id,
        notification.revision,
        notification.spaceId,
        notification.spaceSlug,
        notification.automationId,
        notification.surfaceId,
        notification.kind,
        notification.title,
        notification.summary,
        notification.coalesceKey,
        notification.occurrenceCount,
        notification.state,
        notification.createdAt,
        notification.updatedAt,
        notification.href,
        deliveryId,
      )
  }

  private recoverIntents(knownEventRefs?: ReadonlySet<string>): void {
    const pending = this.db
      .prepare(
        `select * from automation_outcome_notification_intents
         where completed_at is null
         order by json_extract(notification_json, '$.revision'), id`,
      )
      .all()
      .map(notificationIntentFromRow)
    for (const intent of pending) {
      const committed = this.commitMutation(
        intent,
        knownEventRefs?.has(notificationEventRef(intent.id)),
      )
      if (committed.changed) this.publish(committed.notification)
    }
  }

  private reconcileIntentsWithEvents(
    recoveryLogs: ReadonlyMap<string, AutomationOutcomeRecoveryLog>,
  ): Set<string> {
    const eventIntentRefs = new Set<string>()
    for (const space of this.store.spacesEngine.listAllSpaces()) {
      const surfaceIds = this.store.listSurfaces(space.id).map((surface) => surface.id)
      for (const event of recoveryLogs.get(space.id)?.events ?? []) {
        if (!event.type.startsWith('automation.notification.')) continue
        const eventIntentRef = event.payload?.['notificationEventRef']
        if (typeof eventIntentRef === 'string') eventIntentRefs.add(eventIntentRef)
        const intent = notificationIntentFromEvent(event.payload?.['notificationIntent'], {
          spaceId: space.id,
          spaceSlug: space.slug,
          eventType: event.type,
          eventText: event.text,
          origin: event.origin,
          surfaceIds,
        })
        if (
          !intent ||
          event.payload?.['notificationEventRef'] !== notificationEventRef(intent.id)
        ) {
          continue
        }
        this.insertIntent(intent)
      }
    }
    const intents = this.db
      .prepare(
        `select * from automation_outcome_notification_intents
         order by json_extract(notification_json, '$.revision'), id`,
      )
      .all()
      .map(notificationIntentFromRow)
    for (const intent of intents) {
      const log = recoveryLogs.get(intent.spaceId)
      const isCoveredByScan =
        log?.full === true ||
        (log?.since !== undefined && intent.notification.updatedAt >= log.since)
      const eventRef = notificationEventRef(intent.id)
      if (isCoveredByScan && !eventIntentRefs.has(eventRef)) {
        this.appendIntentEvent(intent)
        eventIntentRefs.add(eventRef)
      }
    }
    return eventIntentRefs
  }

  private reconcileOutcomeEvents(
    recoveryLogs: ReadonlyMap<string, AutomationOutcomeRecoveryLog>,
  ): void {
    for (const space of this.store.spacesEngine.listAllSpaces()) {
      const surfaces = this.store.listSurfaces(space.id)
      for (const event of recoveryLogs.get(space.id)?.events ?? []) {
        if (event.type !== 'automation.outcome') continue
        const recovered = outcomeNotificationFromEvent(
          event,
          event.payload?.['notificationIntent'],
          surfaces,
        )
        if (!recovered) continue
        const replay = this.db
          .prepare('select id from automation_outcome_notifications where last_delivery_id = ?')
          .get(recovered.deliveryId)
        if (replay) continue
        const existingRow = this.db
          .prepare(
            `select * from automation_outcome_notifications
             where automation_id = ? and surface_id = ? and kind = ? and coalesce_key = ?
               and space_id = ? and state = 'unread'
             order by updated_at desc limit 1`,
          )
          .get(
            recovered.automationId,
            recovered.surfaceId,
            recovered.kind,
            recovered.coalesceKey,
            space.id,
          )
        const existing = existingRow ? notificationFromRow(existingRow) : undefined
        const notification = AutomationOutcomeNotificationSchema.safeParse({
          id: existing?.id ?? notificationIdFor(recovered.deliveryId),
          revision: this.revision() + 1,
          spaceId: space.id,
          spaceSlug: space.slug,
          automationId: recovered.automationId,
          surfaceId: recovered.surfaceId,
          kind: recovered.kind,
          title: recovered.title,
          summary: recovered.summary,
          coalesceKey: recovered.coalesceKey,
          occurrenceCount: (existing?.occurrenceCount ?? 0) + 1,
          state: 'unread',
          createdAt: existing?.createdAt ?? recovered.checkedAt,
          updatedAt: recovered.checkedAt,
          href: surfacePath(space.slug, recovered.surfaceId),
        })
        if (!notification.success) continue
        const committed = this.commitMutation({
          id: `${recovered.deliveryId}:notify`,
          spaceId: space.id,
          eventType: existing
            ? 'automation.notification.coalesce'
            : 'automation.notification.create',
          eventText: `${notification.data.title}: ${notification.data.summary}`,
          origin: event.origin,
          notification: notification.data,
          stateMarker: recovered.deliveryId,
        })
        if (committed.changed) this.publish(committed.notification)
      }
    }
  }

  private insertIntent(
    intent: Omit<StoredAutomationOutcomeNotificationIntent, 'completedAt'>,
  ): void {
    this.db
      .prepare(
        `insert or ignore into automation_outcome_notification_intents
           (id, space_id, event_type, event_text, origin, notification_json, state_marker)
         values (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        intent.id,
        intent.spaceId,
        intent.eventType,
        intent.eventText,
        intent.origin,
        JSON.stringify(intent.notification),
        intent.stateMarker,
      )
  }

  private appendIntentEvent(
    intent: Omit<StoredAutomationOutcomeNotificationIntent, 'completedAt'>,
  ): void {
    this.store.spacesEngine.appendEvent(intent.spaceId, {
      at: intent.notification.updatedAt,
      type: intent.eventType,
      text: intent.eventText,
      origin: intent.origin,
      payload: {
        notificationEventId: intent.id,
        notificationEventRef: notificationEventRef(intent.id),
        notificationId: intent.notification.id,
        automationId: intent.notification.automationId,
        surfaceId: intent.notification.surfaceId,
        state: intent.notification.state,
        occurrenceCount: intent.notification.occurrenceCount,
        notificationIntent: JsonObjectSchema.parse({
          v: 1,
          id: intent.id,
          stateMarker: intent.stateMarker,
          notification: {
            id: intent.notification.id,
            revision: intent.notification.revision,
            automationId: intent.notification.automationId,
            surfaceRef: notificationSurfaceRef(intent.notification.surfaceId),
            kind: intent.notification.kind,
            title: intent.notification.title,
            summary: intent.notification.summary,
            coalesceKey: intent.notification.coalesceKey,
            occurrenceCount: intent.notification.occurrenceCount,
            state: intent.notification.state,
            createdAt: intent.notification.createdAt,
            updatedAt: intent.notification.updatedAt,
          },
        }),
      },
    })
  }

  private requireIntent(id: string): StoredAutomationOutcomeNotificationIntent {
    const row = this.db
      .prepare('select * from automation_outcome_notification_intents where id = ?')
      .get(id)
    if (!row) throw new Error(`missing Automation notification intent ${id}`)
    return notificationIntentFromRow(row)
  }

  private requireSpace(spaceId: string): void {
    if (!this.store.getSpace(spaceId)) throw new AutomationOutcomeUnavailableError()
  }

  private revision(): number {
    const row = this.db
      .prepare('select revision from automation_outcome_meta where singleton = 1')
      .get()
    if (!row) throw new Error('missing Automation outcome revision')
    return requiredNumber(row, 'revision')
  }

  private setRevision(revision: number): void {
    this.db
      .prepare(
        `update automation_outcome_meta
         set revision = max(revision, ?) where singleton = 1`,
      )
      .run(revision)
  }

  private publish(notification: AutomationOutcomeNotification): void {
    const event = { revision: notification.revision, notification }
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch (error) {
        console.error('Automation outcome lifecycle observer failed', error)
      }
    }
  }

  private nowIso(): string {
    return this.now().toISOString()
  }
}

function notificationIdFor(deliveryId: string): string {
  return `aon-${createHash('sha256').update(deliveryId).digest('hex').slice(0, 24)}`
}

function notificationEventRef(intentId: string): string {
  return `aor-${createHash('sha256').update(intentId).digest('hex')}`
}

function notificationSurfaceRef(surfaceId: string): string {
  return `asr-${createHash('sha256').update(surfaceId).digest('hex')}`
}

function notificationCoalesceKeyFor(coalesceKey: string): string {
  return `ack-${createHash('sha256').update(coalesceKey).digest('hex')}`
}

function notificationTitle(description: string, kind: 'changed' | 'failed' | 'recovered'): string {
  const suffix = kind === 'changed' ? 'updated' : kind
  const title = `${description.trim()} ${suffix}`.trim()
  return title.length <= 120 ? title : `${title.slice(0, 119).trimEnd()}…`
}

function outcomeNotificationFromEvent(
  event: SpaceEvent,
  value: unknown,
  surfaces: readonly Surface[],
):
  | {
      deliveryId: string
      automationId: number
      surfaceId: string
      kind: 'changed' | 'failed' | 'recovered'
      title: string
      summary: string
      coalesceKey: string
      checkedAt: string
    }
  | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  if (record['v'] !== 1) return undefined
  const deliveryId = record['deliveryId']
  const automationId = record['automationId']
  const surfaceRef = record['surfaceRef']
  const kind = record['kind']
  const title = record['title']
  const summary = record['summary']
  const coalesceKey = record['coalesceKey']
  const checkedAt = record['checkedAt']
  if (
    typeof deliveryId !== 'string' ||
    typeof automationId !== 'number' ||
    !Number.isInteger(automationId) ||
    automationId <= 0 ||
    typeof surfaceRef !== 'string' ||
    (kind !== 'changed' && kind !== 'failed' && kind !== 'recovered') ||
    typeof title !== 'string' ||
    typeof summary !== 'string' ||
    typeof coalesceKey !== 'string' ||
    typeof checkedAt !== 'string' ||
    Number.isNaN(new Date(checkedAt).getTime())
  ) {
    return undefined
  }
  const surface = surfaces.find((candidate) => notificationSurfaceRef(candidate.id) === surfaceRef)
  if (!surface || surface.spaceId !== event.spaceId) return undefined
  return {
    deliveryId,
    automationId,
    surfaceId: surface.id,
    kind,
    title,
    summary,
    coalesceKey,
    checkedAt: new Date(checkedAt).toISOString(),
  }
}

function notificationIntentFromEvent(
  value: unknown,
  context: {
    spaceId: string
    spaceSlug: string
    eventType: string
    eventText: string
    origin: Origin
    surfaceIds: readonly string[]
  },
): Omit<StoredAutomationOutcomeNotificationIntent, 'completedAt'> | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  const id = record['id']
  const stateMarker = record['stateMarker']
  const notificationRecord = record['notification']
  if (
    record['v'] !== 1 ||
    typeof id !== 'string' ||
    id.length === 0 ||
    typeof stateMarker !== 'string' ||
    stateMarker.length === 0 ||
    typeof notificationRecord !== 'object' ||
    notificationRecord === null
  ) {
    return undefined
  }
  const notificationFields = notificationRecord as Record<string, unknown>
  const surfaceRef = notificationFields['surfaceRef']
  if (typeof surfaceRef !== 'string') return undefined
  const surfaceId = context.surfaceIds.find(
    (candidate) => notificationSurfaceRef(candidate) === surfaceRef,
  )
  if (surfaceId === undefined) return undefined
  const notification = AutomationOutcomeNotificationSchema.safeParse({
    id: notificationFields['id'],
    revision: notificationFields['revision'],
    spaceId: context.spaceId,
    spaceSlug: context.spaceSlug,
    automationId: notificationFields['automationId'],
    surfaceId,
    kind: notificationFields['kind'],
    title: notificationFields['title'],
    summary: notificationFields['summary'],
    coalesceKey: notificationFields['coalesceKey'],
    occurrenceCount: notificationFields['occurrenceCount'],
    state: notificationFields['state'],
    createdAt: notificationFields['createdAt'],
    updatedAt: notificationFields['updatedAt'],
    href: surfacePath(context.spaceSlug, surfaceId),
  })
  if (!notification.success) return undefined
  return {
    id,
    spaceId: context.spaceId,
    eventType: context.eventType,
    eventText: context.eventText,
    origin: context.origin,
    notification: notification.data,
    stateMarker,
  }
}
