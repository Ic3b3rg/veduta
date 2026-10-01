import {
  CommittedFastActionOutcomeSchema,
  FastActionInvocationSchema,
  type ActionInvocation,
  type CommittedFastActionOutcome,
  type Patch,
  type Surface,
} from '@veduta/protocol'

/** Fake Gateway responses keep request identity and independently declared canonical effects. */
export function committedActionOutcome(
  invocation: ActionInvocation,
  surface: Surface,
  patch: Patch,
  cursor: number,
): CommittedFastActionOutcome {
  const action = FastActionInvocationSchema.parse(invocation)
  return CommittedFastActionOutcomeSchema.parse({
    outcome: 'committed',
    surfaceId: surface.id,
    nodeId: action.nodeId,
    actionName: action.name,
    actionRevision: action.actionRevision,
    intentId: action.intentId,
    surfaceVersion: cursor + 1,
    treeVersion: 1,
    surfaceCommitId: `scm-test-${action.intentId}`,
    eventCursor: cursor,
    surfaceCursor: cursor,
    duplicate: false,
    patch,
    surface,
  })
}
