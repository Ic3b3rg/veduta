import { z } from 'zod'

export const PendingDecisionKindSchema = z.enum([
  'approval',
  'tree-proposal',
  'space-proposal',
  'update-offer',
])

export const PendingDecisionResolutionSchema = z.enum(['approve', 'reject', 'accept', 'apply'])

export const PendingDecisionStateSchema = z.enum(['pending', 'resolving', 'terminal'])

export const PendingDecisionOutcomeSchema = z.enum([
  'executed',
  'accepted',
  'rejected',
  'expired',
  'failed',
  'stale',
  'indeterminate',
  'applied',
  'rolled-back',
  'refused',
])

export const PendingDecisionScopeSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('global') }).strict(),
  z.object({ type: z.literal('space'), spaceId: z.string().min(1) }).strict(),
])

const KIND_CONTRACT = {
  approval: { prefix: 'approval:', resolutions: ['approve', 'reject'] },
  'tree-proposal': { prefix: 'tree-proposal:', resolutions: ['accept', 'reject'] },
  'space-proposal': { prefix: 'space-proposal:', resolutions: ['accept', 'reject'] },
  'update-offer': { prefix: 'update-offer:', resolutions: ['apply'] },
} as const satisfies Record<
  z.infer<typeof PendingDecisionKindSchema>,
  { prefix: string; resolutions: readonly z.infer<typeof PendingDecisionResolutionSchema>[] }
>

export interface ParsedPendingDecisionId {
  kind: z.infer<typeof PendingDecisionKindSchema>
  nativeId: string
}

export function parsePendingDecisionId(id: string): ParsedPendingDecisionId | undefined {
  if (id.length > 300) return undefined
  for (const kind of PendingDecisionKindSchema.options) {
    const prefix = KIND_CONTRACT[kind].prefix
    if (id.startsWith(prefix) && id.length > prefix.length) {
      return { kind, nativeId: id.slice(prefix.length) }
    }
  }
  return undefined
}

export function pendingDecisionNativeId(
  id: string,
  expectedKind: z.infer<typeof PendingDecisionKindSchema>,
): string | undefined {
  const parsed = parsePendingDecisionId(id)
  return parsed?.kind === expectedKind ? parsed.nativeId : undefined
}

export function formatPendingDecisionId(
  kind: z.infer<typeof PendingDecisionKindSchema>,
  nativeId: string | number,
): string {
  const id = `${KIND_CONTRACT[kind].prefix}${nativeId}`
  if (parsePendingDecisionId(id)?.kind !== kind) {
    throw new Error(`invalid native id for ${kind} Pending decision`)
  }
  return id
}

export const PendingDecisionSchema = z
  .object({
    id: z.string().min(1).max(300),
    kind: PendingDecisionKindSchema,
    summary: z.string().min(1).max(500),
    scope: PendingDecisionScopeSchema,
    allowedResolutions: z.array(PendingDecisionResolutionSchema).min(1).max(4),
    state: PendingDecisionStateSchema,
    outcome: PendingDecisionOutcomeSchema.optional(),
    decisionSurfaceId: z.string().min(1).optional(),
    createdAt: z.string().datetime(),
    decisionAt: z.string().datetime().optional(),
    resolvedAt: z.string().datetime().optional(),
    resolvedBy: z.literal('trusted:user').optional(),
  })
  .strict()
  .superRefine((decision, context) => {
    const contract = KIND_CONTRACT[decision.kind]
    if (parsePendingDecisionId(decision.id)?.kind !== decision.kind) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['id'],
        message: `id must use the ${contract.prefix}<native-id> form`,
      })
    }

    if (
      decision.allowedResolutions.length !== contract.resolutions.length ||
      decision.allowedResolutions.some(
        (resolution, index) => resolution !== contract.resolutions[index],
      )
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['allowedResolutions'],
        message: `${decision.kind} decisions must expose ${contract.resolutions.join(', ')}`,
      })
    }

    if (decision.state === 'terminal') {
      if (decision.outcome === undefined) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['outcome'],
          message: 'terminal decisions require an authoritative outcome',
        })
      }
      if (decision.resolvedAt === undefined) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['resolvedAt'],
          message: 'terminal decisions require a resolution time',
        })
      }
      return
    }

    if (decision.outcome !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['outcome'],
        message: 'only terminal decisions may carry an outcome',
      })
    }
    if (decision.resolvedAt !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['resolvedAt'],
        message: 'only terminal decisions may have a resolution time',
      })
    }
    if (decision.state === 'pending' && decision.decisionAt !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['decisionAt'],
        message: 'pending decisions cannot have a decision time',
      })
    }
    if (decision.state === 'pending' && decision.resolvedBy !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['resolvedBy'],
        message: 'pending decisions cannot have a resolving actor',
      })
    }
    if (decision.state === 'resolving' && decision.decisionAt === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['decisionAt'],
        message: 'resolving decisions require a decision time',
      })
    }
    if (decision.state === 'resolving' && decision.resolvedBy === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['resolvedBy'],
        message: 'resolving decisions require the user actor',
      })
    }
  })

export const PendingDecisionListSchema = z
  .object({
    revision: z.number().int().nonnegative().optional(),
    decisions: z.array(PendingDecisionSchema),
  })
  .strict()
  .superRefine(({ decisions }, context) => {
    const seen = new Set<string>()
    decisions.forEach((decision, index) => {
      if (seen.has(decision.id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['decisions', index, 'id'],
          message: `duplicate Pending decision id: ${decision.id}`,
        })
      }
      seen.add(decision.id)
    })
  })

export const PendingDecisionResolveRequestSchema = z
  .object({ resolution: PendingDecisionResolutionSchema })
  .strict()

export const PendingDecisionResolveResultSchema = z
  .object({
    decision: PendingDecisionSchema,
    replayed: z.boolean(),
  })
  .strict()

export type PendingDecisionKind = z.infer<typeof PendingDecisionKindSchema>
export type PendingDecisionResolution = z.infer<typeof PendingDecisionResolutionSchema>
export type PendingDecisionState = z.infer<typeof PendingDecisionStateSchema>
export type PendingDecisionOutcome = z.infer<typeof PendingDecisionOutcomeSchema>
export type PendingDecisionScope = z.infer<typeof PendingDecisionScopeSchema>
export type PendingDecision = z.infer<typeof PendingDecisionSchema>
export type PendingDecisionList = z.infer<typeof PendingDecisionListSchema>
export type PendingDecisionResolveRequest = z.infer<typeof PendingDecisionResolveRequestSchema>
export type PendingDecisionResolveResult = z.infer<typeof PendingDecisionResolveResultSchema>
