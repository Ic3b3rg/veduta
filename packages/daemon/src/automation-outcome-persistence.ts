import type { DatabaseSync } from 'node:sqlite'
import {
  AutomationOutcomeInputSchema,
  AutomationOutcomeNotificationSchema,
  AutomationRunHistoryEntrySchema,
  type AutomationOutcomeInput,
  type AutomationOutcomeNotification,
  type AutomationRunHistoryEntry,
} from '@veduta/protocol'
import {
  ensureSqliteColumn,
  optionalNumber,
  optionalString,
  requiredNumber,
  requiredString,
} from './sqlite-rows.ts'
import { isValidOrigin, type Origin } from './taint.ts'

export interface StoredAutomationOutcomeDelivery {
  id: string
  automationId: number
  spaceId: string
  targetSurfaceId: string
  description: string
  scheduledFor: string
  checkedAt: string
  targetVersion?: number
  origin: Origin
  outcome: AutomationOutcomeInput
  completedAt?: string
}

export interface StoredAutomationOutcomeNotificationIntent {
  id: string
  spaceId: string
  eventType: string
  eventText: string
  origin: Origin
  notification: AutomationOutcomeNotification
  stateMarker: string
  completedAt?: string
}

export interface StoredAutomationRunHistoryEntry extends AutomationRunHistoryEntry {
  origin: Origin
}

export function initializeAutomationOutcomeSchema(db: DatabaseSync): void {
  db.exec(`
    pragma journal_mode = wal;
    create table if not exists automation_outcome_deliveries (
      id text primary key,
      automation_id integer not null,
      space_id text not null,
      target_surface_id text not null,
      description text not null,
      scheduled_for text not null,
      checked_at text,
      target_version integer,
      origin text not null,
      outcome_kind text,
      outcome_json text not null,
      completed_at text
    );

    create table if not exists automation_outcome_history (
      id text primary key,
      automation_id integer not null,
      scheduled_for text not null,
      kind text not null check (kind in ('changed', 'failed', 'recovered')),
      summary text not null,
      at text not null,
      origin text not null default 'trusted:system'
    );
    create index if not exists automation_outcome_history_by_automation
      on automation_outcome_history (automation_id, at desc, id desc);

    create table if not exists automation_outcome_delivery_tombstones (
      id text primary key,
      outcome_kind text not null check (
        outcome_kind in ('unchanged', 'changed', 'failed', 'recovered', 'decision-required')
      ),
      completed_at text not null,
      redirect_delivery_id text
    );

    create table if not exists automation_outcome_notifications (
      id text primary key,
      revision integer not null,
      space_id text not null,
      space_slug text not null,
      automation_id integer not null,
      surface_id text not null,
      kind text not null check (kind in ('changed', 'failed', 'recovered')),
      title text not null,
      summary text not null,
      coalesce_key text not null,
      occurrence_count integer not null,
      state text not null check (state in ('unread', 'opened', 'dismissed', 'settled')),
      created_at text not null,
      updated_at text not null,
      href text not null,
      last_delivery_id text not null
    );
    create index if not exists automation_outcome_notifications_by_space
      on automation_outcome_notifications (space_id, state, updated_at desc, id);
    create index if not exists automation_outcome_notifications_by_delivery
      on automation_outcome_notifications (last_delivery_id);
    create index if not exists automation_outcome_unread_coalescing
      on automation_outcome_notifications (
        space_id, automation_id, surface_id, kind, coalesce_key, updated_at desc
      ) where state = 'unread';
    create index if not exists automation_outcome_unread_failures
      on automation_outcome_notifications (
        space_id, automation_id, surface_id, updated_at, id
      ) where state = 'unread' and kind = 'failed';

    create table if not exists automation_outcome_notification_intents (
      id text primary key,
      space_id text not null,
      event_type text not null,
      event_text text not null,
      origin text not null,
      notification_json text not null,
      state_marker text not null,
      completed_at text
    );
    create index if not exists automation_outcome_pending_notification_intents
      on automation_outcome_notification_intents (id)
      where completed_at is null;

    create table if not exists automation_outcome_meta (
      singleton integer primary key check (singleton = 1),
      revision integer not null
    );
    insert or ignore into automation_outcome_meta (singleton, revision) values (1, 0);

    create table if not exists automation_outcome_event_watermarks (
      space_id text primary key,
      last_event_at text not null,
      last_event_fingerprint text not null
    );
    update automation_outcome_meta
      set revision = max(
        revision,
        coalesce((select max(revision) from automation_outcome_notifications), 0)
      )
      where singleton = 1;
  `)
  ensureSqliteColumn(db, 'automation_outcome_deliveries', 'outcome_kind', 'text')
  ensureSqliteColumn(db, 'automation_outcome_deliveries', 'checked_at', 'text')
  ensureSqliteColumn(db, 'automation_outcome_deliveries', 'target_version', 'integer')
  ensureSqliteColumn(
    db,
    'automation_outcome_history',
    'origin',
    "text not null default 'trusted:system'",
  )
  ensureSqliteColumn(db, 'automation_outcome_delivery_tombstones', 'redirect_delivery_id', 'text')
  db.exec(`
    update automation_outcome_deliveries
      set checked_at = scheduled_for
      where checked_at is null;
    update automation_outcome_deliveries
      set outcome_kind = json_extract(outcome_json, '$.kind')
      where outcome_kind is null and json_valid(outcome_json);
    create index if not exists automation_outcome_delivery_failure_state
      on automation_outcome_deliveries (
        automation_id, space_id, target_surface_id, scheduled_for desc, id desc
      )
      where completed_at is not null
        and outcome_kind in ('failed', 'recovered', 'decision-required');
    create index if not exists automation_outcome_delivery_targets
      on automation_outcome_deliveries (automation_id, space_id, target_surface_id);
    insert or ignore into automation_outcome_delivery_tombstones (id, outcome_kind, completed_at)
      select id, outcome_kind, completed_at
      from automation_outcome_deliveries
      where completed_at is not null and outcome_kind is not null;
  `)
}

export function notificationIntentFromRow(
  row: Record<string, unknown>,
): StoredAutomationOutcomeNotificationIntent {
  const origin = requiredString(row, 'origin')
  if (!isValidOrigin(origin)) {
    throw new Error(`invalid stored Automation notification intent origin: ${origin}`)
  }
  const completedAt = optionalString(row, 'completed_at')
  return {
    id: requiredString(row, 'id'),
    spaceId: requiredString(row, 'space_id'),
    eventType: requiredString(row, 'event_type'),
    eventText: requiredString(row, 'event_text'),
    origin,
    notification: AutomationOutcomeNotificationSchema.parse(
      JSON.parse(requiredString(row, 'notification_json')) as unknown,
    ),
    stateMarker: requiredString(row, 'state_marker'),
    ...(completedAt === undefined ? {} : { completedAt }),
  }
}

export function deliveryFromRow(row: Record<string, unknown>): StoredAutomationOutcomeDelivery {
  const origin = requiredString(row, 'origin')
  if (!isValidOrigin(origin)) throw new Error(`invalid stored Automation outcome origin: ${origin}`)
  const completedAt = optionalString(row, 'completed_at')
  const targetVersion = optionalNumber(row, 'target_version')
  return {
    id: requiredString(row, 'id'),
    automationId: requiredNumber(row, 'automation_id'),
    spaceId: requiredString(row, 'space_id'),
    targetSurfaceId: requiredString(row, 'target_surface_id'),
    description: requiredString(row, 'description'),
    scheduledFor: requiredString(row, 'scheduled_for'),
    checkedAt: optionalString(row, 'checked_at') ?? requiredString(row, 'scheduled_for'),
    ...(targetVersion === undefined ? {} : { targetVersion }),
    origin,
    outcome: AutomationOutcomeInputSchema.parse(
      JSON.parse(requiredString(row, 'outcome_json')) as unknown,
    ),
    ...(completedAt === undefined ? {} : { completedAt }),
  }
}

export function notificationFromRow(row: Record<string, unknown>): AutomationOutcomeNotification {
  return AutomationOutcomeNotificationSchema.parse({
    id: requiredString(row, 'id'),
    revision: requiredNumber(row, 'revision'),
    spaceId: requiredString(row, 'space_id'),
    spaceSlug: requiredString(row, 'space_slug'),
    automationId: requiredNumber(row, 'automation_id'),
    surfaceId: requiredString(row, 'surface_id'),
    kind: requiredString(row, 'kind'),
    title: requiredString(row, 'title'),
    summary: requiredString(row, 'summary'),
    coalesceKey: requiredString(row, 'coalesce_key'),
    occurrenceCount: requiredNumber(row, 'occurrence_count'),
    state: requiredString(row, 'state'),
    createdAt: requiredString(row, 'created_at'),
    updatedAt: requiredString(row, 'updated_at'),
    href: requiredString(row, 'href'),
  })
}

export function historyFromRow(row: Record<string, unknown>): StoredAutomationRunHistoryEntry {
  const origin = requiredString(row, 'origin')
  if (!isValidOrigin(origin)) throw new Error(`invalid stored Automation history origin: ${origin}`)
  return {
    ...AutomationRunHistoryEntrySchema.parse({
      id: requiredString(row, 'id'),
      automationId: requiredNumber(row, 'automation_id'),
      scheduledFor: requiredString(row, 'scheduled_for'),
      kind: requiredString(row, 'kind'),
      summary: requiredString(row, 'summary'),
      at: requiredString(row, 'at'),
    }),
    origin,
  }
}
