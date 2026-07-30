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
    /** The user locked this Surface's tree; the Agent may still patch state. */
    pinned: z.boolean().default(false),
    /**
     * False for daemon-owned Surfaces (approval cards, admin Surfaces) and the
     * projected FACTS Surface, so no client renders a pin toggle the daemon
     * would refuse.
     */
    pinnable: z.boolean().default(true),
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

/**
 * A key an Atom node reaches into typed state for: either its own `binding`,
 * or a `path: 'fast'` action's `stateKey`. Shared by `SurfaceSchema` (checked
 * against `state`'s own keys) and `SurfaceTemplateSchema` in `template.ts`
 * (checked against the Template's `stateKeys` names) so both validate the
 * same tree shape without duplicating the traversal.
 */
export type NodeBindingRef =
  | { kind: 'binding'; key: string; path: (string | number)[] }
  | { kind: 'fastAction'; key: string; actionName: string; path: (string | number)[] }

export function collectNodeBindingRefs(
  node: AtomNode,
  path: (string | number)[],
): NodeBindingRef[] {
  const refs: NodeBindingRef[] = []

  if (node.binding) {
    refs.push({ kind: 'binding', key: node.binding, path: [...path, 'binding'] })
  }

  node.actions?.forEach((action, index) => {
    if (action.path !== 'fast' || action.stateKey === undefined) return
    refs.push({
      kind: 'fastAction',
      key: action.stateKey,
      actionName: action.name,
      path: [...path, 'actions', index, 'stateKey'],
    })
  })

  node.children?.forEach((child, index) => {
    refs.push(...collectNodeBindingRefs(child, [...path, 'children', index]))
  })

  return refs
}

function validateNodeBindings(
  node: AtomNode,
  state: JsonObject,
  path: (string | number)[],
  ctx: z.RefinementCtx,
): void {
  for (const ref of collectNodeBindingRefs(node, path)) {
    if (hasStateKey(state, ref.key)) continue

    const message =
      ref.kind === 'binding'
        ? `binding "${ref.key}" does not exist in Surface state`
        : `fast action "${ref.actionName}" targets missing state key "${ref.key}"`

    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ref.path, message })
  }
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
