import type { PendingDecision, Surface } from '@veduta/protocol'
import type { SpaceWithSurfaces } from './api.ts'

export interface AssignedPendingDecision {
  decision: PendingDecision
  space: SpaceWithSurfaces
  surface: Surface
}

export interface PendingDecisionPlacement {
  pending: PendingDecision[]
  assigned: AssignedPendingDecision[]
  unassigned: PendingDecision[]
}

/** Places only relationships proven by the current validated Space snapshot. */
export function placePendingDecisions(
  decisions: readonly PendingDecision[],
  spaces: readonly SpaceWithSurfaces[],
): PendingDecisionPlacement {
  const pending = decisions.filter((decision) => decision.state === 'pending')
  const activeSpaces = new Map(
    spaces.filter((space) => !space.archived).map((space) => [space.id, space]),
  )
  const assigned: AssignedPendingDecision[] = []
  const unassigned: PendingDecision[] = []

  for (const decision of pending) {
    if (decision.scope.type !== 'space' || decision.decisionSurfaceId === undefined) {
      unassigned.push(decision)
      continue
    }

    const space = activeSpaces.get(decision.scope.spaceId)
    const surface = space?.surfaces.find((candidate) => candidate.id === decision.decisionSurfaceId)
    if (space === undefined || surface === undefined || surface.spaceId !== space.id) {
      unassigned.push(decision)
      continue
    }

    assigned.push({ decision, space, surface })
  }

  return { pending, assigned, unassigned }
}
