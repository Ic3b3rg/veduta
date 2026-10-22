import type { PendingDecision } from '@veduta/protocol'
import type { SpaceWithSurfaces } from './api.ts'
import { clientPath } from './client-router.tsx'
import { placePendingDecisions } from './pending-decision-placement.ts'

export interface PendingDecisionNotification {
  decision: PendingDecision
  reviewPath?: string
}

export interface PendingDecisionPresentation {
  globalNotifications: PendingDecisionNotification[]
  notificationsBySpaceId: ReadonlyMap<string, PendingDecisionNotification[]>
  reviewPaths: ReadonlyMap<string, string>
  countsBySpaceId: ReadonlyMap<string, number>
  updateNotice?: { version: string; reviewPath: string }
}

/** Builds the shared Home, Space, and chat projections from one placement pass. */
export function presentPendingDecisions(
  decisions: readonly PendingDecision[],
  spaces: readonly SpaceWithSurfaces[],
  dismissedDecisionIds?: ReadonlySet<string>,
): PendingDecisionPresentation {
  const placement = placePendingDecisions(decisions, spaces)
  const notificationByDecisionId = new Map<string, PendingDecisionNotification>(
    placement.unassigned
      .filter((decision) => !dismissedDecisionIds?.has(decision.id))
      .map((decision) => [decision.id, { decision }]),
  )
  const notificationsBySpaceId = new Map<string, PendingDecisionNotification[]>()
  const reviewPaths = new Map<string, string>()
  const countsBySpaceId = new Map<string, number>()
  let updateNotice: PendingDecisionPresentation['updateNotice']

  for (const { decision, space, surface } of placement.assigned) {
    const reviewPath = clientPath.surface(space.slug, surface.id)
    if (decision.kind === 'update-offer' && decision.updateVersion !== undefined) {
      updateNotice = { version: decision.updateVersion, reviewPath }
    }
    if (dismissedDecisionIds?.has(decision.id)) continue
    const notification = { decision, reviewPath }
    notificationByDecisionId.set(decision.id, notification)
    reviewPaths.set(decision.id, reviewPath)
    notificationsBySpaceId.set(space.id, [
      ...(notificationsBySpaceId.get(space.id) ?? []),
      notification,
    ])
    countsBySpaceId.set(space.id, (countsBySpaceId.get(space.id) ?? 0) + 1)
  }

  return {
    globalNotifications: placement.pending.flatMap((decision) => {
      const notification = notificationByDecisionId.get(decision.id)
      return notification === undefined ? [] : [notification]
    }),
    notificationsBySpaceId,
    reviewPaths,
    countsBySpaceId,
    ...(updateNotice === undefined ? {} : { updateNotice }),
  }
}
