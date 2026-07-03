import { z, type ZodIssue } from 'zod'
import { AtomNodeSchema, type AtomNode } from './atom.ts'
import { JsonObjectSchema, type JsonObject } from './json.ts'

/**
 * A Surface is living state, not a response (CONTEXT.md): a declarative
 * tree of Atoms bound to typed state, owned by a Space. Freshness metadata
 * is mandatory — a stale Surface presented as current destroys trust.
 */
export const FreshnessSchema = z.object({
  updatedAt: z.string().datetime(),
  updatedBy: z.enum(['agent', 'user', 'job', 'seed', 'system']),
})

export const SurfaceSchema = z
  .object({
    id: z.string().min(1),
    spaceId: z.string().min(1),
    title: z.string().min(1),
    tree: AtomNodeSchema,
    state: JsonObjectSchema,
    freshness: FreshnessSchema,
  })
  .superRefine((surface, ctx) => {
    validateNodeBindings(surface.tree, surface.state, ['tree'], ctx)
  })

export type Surface = z.infer<typeof SurfaceSchema>
export type Freshness = z.infer<typeof FreshnessSchema>

export class SurfaceValidationError extends Error {
  readonly issues: string[]

  constructor(issues: string[]) {
    super(`invalid Surface: ${issues.join('; ')}`)
    this.name = 'SurfaceValidationError'
    this.issues = issues
  }
}

export function parseSurface(input: unknown): Surface {
  const result = SurfaceSchema.safeParse(input)
  if (result.success) return result.data
  throw new SurfaceValidationError(formatSurfaceIssues(result.error.issues))
}

export function formatSurfaceIssues(issues: ZodIssue[]): string[] {
  return issues.map(formatSurfaceIssue)
}

function validateNodeBindings(
  node: AtomNode,
  state: JsonObject,
  path: (string | number)[],
  ctx: z.RefinementCtx,
): void {
  if (node.binding && !hasStateKey(state, node.binding)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [...path, 'binding'],
      message: `binding "${node.binding}" does not exist in Surface state`,
    })
  }

  node.actions?.forEach((action, index) => {
    if (action.path !== 'fast' || action.stateKey === undefined) return

    if (!hasStateKey(state, action.stateKey)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...path, 'actions', index, 'stateKey'],
        message: `fast action "${action.name}" targets missing state key "${action.stateKey}"`,
      })
    }
  })

  node.children?.forEach((child, index) => {
    validateNodeBindings(child, state, [...path, 'children', index], ctx)
  })
}

function hasStateKey(state: JsonObject, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(state, key)
}

function formatSurfaceIssue(issue: ZodIssue): string {
  const path = issue.path.length > 0 ? issue.path.join('.') : 'surface'
  if (
    issue.code === z.ZodIssueCode.invalid_enum_value &&
    issue.path[issue.path.length - 1] === 'type'
  ) {
    return `${path}: unknown Atom "${String(issue.received)}"; expected one of ${issue.options.join(', ')}`
  }
  return `${path}: ${issue.message}`
}
