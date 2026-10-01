import { z } from 'zod'
import { ActionIntentIdSchema, ActionRevisionSchema } from './action-plan.ts'
import { PatchSchema } from './patch.ts'
import { SurfaceSchema } from './surface.ts'

const Identity = {
  surfaceId: z.string().min(1),
  nodeId: z.string().min(1),
  actionName: z.string().min(1),
  actionRevision: ActionRevisionSchema,
  intentId: ActionIntentIdSchema,
}
const OutcomeActionSchema = z.object({
  name: z.string(),
  path: z.string(),
  revision: z.string().optional(),
})
type OutcomeAction = z.infer<typeof OutcomeActionSchema>
interface OutcomeNode {
  id: string
  actions?: unknown
  children?: readonly OutcomeNode[] | undefined
}
function outcomeAction(
  node: OutcomeNode,
  nodeId: string,
  actionName: string,
): OutcomeAction | undefined {
  if (node.id === nodeId) {
    if (!Array.isArray(node.actions)) return undefined
    for (const candidate of node.actions) {
      const action = OutcomeActionSchema.safeParse(candidate)
      if (action.success && action.data.name === actionName) return action.data
    }
    return undefined
  }
  for (const child of node.children ?? []) {
    const action = outcomeAction(child, nodeId, actionName)
    if (action) return action
  }
  return undefined
}
/** eventCursor identifies this Surface event; the matching Space Event carries surfaceCommitId. */
export const CommittedFastActionMetadataSchema = z
  .object({
    ...Identity,
    outcome: z.literal('committed'),
    surfaceVersion: z.number().int().positive(),
    treeVersion: z.number().int().positive(),
    surfaceCommitId: z.string().regex(/^scm-[A-Za-z0-9-]+$/),
    eventCursor: z.number().int().positive(),
    surfaceCursor: z.number().int().positive(),
    duplicate: z.boolean(),
  })
  .strict()
export const CommittedFastActionOutcomeObjectSchema = CommittedFastActionMetadataSchema.extend({
  patch: PatchSchema,
  surface: SurfaceSchema,
}).strict()
export function refineCommittedFastActionOutcome(
  value: {
    surfaceId: string
    nodeId: string
    actionName: string
    actionRevision: string
    surface: { id: string; tree: OutcomeNode }
    patch: { surfaceId: string }
    eventCursor: number
    surfaceCursor: number
  },
  ctx: z.RefinementCtx,
): void {
  if (value.surface.id !== value.surfaceId || value.patch.surfaceId !== value.surfaceId)
    ctx.addIssue({
      code: 'custom',
      message: 'committed Surface and Patch must match the resolved action identity',
    })
  if (value.eventCursor !== value.surfaceCursor)
    ctx.addIssue({
      code: 'custom',
      message: 'committed snapshot cursor must match its canonical Patch event cursor',
    })
  const action = outcomeAction(value.surface.tree, value.nodeId, value.actionName)
  if (action?.path !== 'fast' || action.revision !== value.actionRevision)
    ctx.addIssue({
      code: 'custom',
      message: 'committed snapshot must contain the resolved owning Action revision',
    })
}
export const CommittedFastActionOutcomeSchema = CommittedFastActionOutcomeObjectSchema.superRefine(
  refineCommittedFastActionOutcome,
)
export const NoopFastActionOutcomeSchema = z
  .object({
    ...Identity,
    outcome: z.literal('noop'),
    reason: z.enum(['unchanged', 'missing_target']),
    duplicate: z.boolean(),
  })
  .strict()
export const RecoveryPendingFastActionOutcomeSchema = z
  .object({
    ...Identity,
    outcome: z.literal('recovery_pending'),
    surfaceCommitId: z.string().regex(/^scm-[A-Za-z0-9-]+$/),
    spaceId: z.string().min(1),
    duplicate: z.boolean(),
  })
  .strict()
export const FastActionOutcomeSchema = z.union([
  CommittedFastActionOutcomeSchema,
  NoopFastActionOutcomeSchema,
  RecoveryPendingFastActionOutcomeSchema,
])
export type CommittedFastActionMetadata = z.infer<typeof CommittedFastActionMetadataSchema>
export type CommittedFastActionOutcome = z.infer<typeof CommittedFastActionOutcomeSchema>
export type FastActionOutcome = z.infer<typeof FastActionOutcomeSchema>
