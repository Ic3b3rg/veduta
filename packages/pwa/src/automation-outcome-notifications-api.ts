import {
  AutomationOutcomeNotificationActionResultSchema,
  AutomationOutcomeNotificationSnapshotSchema,
  type AutomationOutcomeNotificationActionResult,
  type AutomationOutcomeNotificationSnapshot,
} from '@veduta/protocol'
import { getJson, postJson } from './api-http.ts'

function notificationPath(spaceId: string): string {
  return `/api/spaces/${encodeURIComponent(spaceId)}/automation-outcome-notifications`
}

export async function fetchAutomationOutcomeNotifications(
  spaceId: string,
  token?: string,
): Promise<AutomationOutcomeNotificationSnapshot> {
  return AutomationOutcomeNotificationSnapshotSchema.parse(
    await getJson(notificationPath(spaceId), token),
  )
}

export function openAutomationOutcomeNotification(
  spaceId: string,
  notificationId: string,
  token?: string,
): Promise<AutomationOutcomeNotificationActionResult> {
  return mutateNotification(spaceId, notificationId, 'open', token)
}

export function dismissAutomationOutcomeNotification(
  spaceId: string,
  notificationId: string,
  token?: string,
): Promise<AutomationOutcomeNotificationActionResult> {
  return mutateNotification(spaceId, notificationId, 'dismiss', token)
}

async function mutateNotification(
  spaceId: string,
  notificationId: string,
  action: 'open' | 'dismiss',
  token?: string,
): Promise<AutomationOutcomeNotificationActionResult> {
  return AutomationOutcomeNotificationActionResultSchema.parse(
    await postJson(
      `${notificationPath(spaceId)}/${encodeURIComponent(notificationId)}/${action}`,
      {},
      token,
    ),
  )
}
