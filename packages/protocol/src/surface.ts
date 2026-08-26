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

export const RelativeTimeWindowSchema = z.enum(['day', 'week', 'month'])
const OccurrenceInstantSchema = z.string().datetime({ offset: true })

export const RelativeTimeValiditySchema = z
  .object({
    kind: z.literal('relative-time'),
    timeZone: z.string().min(1),
    window: RelativeTimeWindowSchema,
    startsAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
    source: z
      .object({
        stateKey: z.string().min(1),
        occurredAtKey: z.string().min(1).default('occurredAt'),
      })
      .strict(),
    projectionStateKeys: z.array(z.string().min(1)).min(1),
  })
  .strict()
  .superRefine((validity, ctx) => {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: validity.timeZone })
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['timeZone'],
        message: `invalid time zone "${validity.timeZone}"`,
      })
    }

    if (Date.parse(validity.startsAt) >= Date.parse(validity.expiresAt)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['expiresAt'],
        message: 'relative-time expiry must be after its start',
      })
    }

    const seen = new Set<string>()
    validity.projectionStateKeys.forEach((key, index) => {
      if (seen.has(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['projectionStateKeys', index],
          message: `duplicate projection state key "${key}"`,
        })
      }
      seen.add(key)
    })
  })

const SurfaceObjectSchema = z.object({
  id: z.string().min(1),
  spaceId: z.string().min(1),
  title: z.string().min(1),
  tree: AtomNodeSchema,
  state: JsonObjectSchema,
  freshness: FreshnessSchema,
  /** The user locked this Surface's tree; the Agent may still patch state. */
  pinned: z.boolean().default(false),
  /**
   * False for Surfaces whose ownership or projection makes pinning invalid.
   * Gateway-owned System Surfaces may still expose true because their Pin is
   * an ordinary presentation preference.
   */
  pinnable: z.boolean().default(true),
  /**
   * An optional, explicit contract for visible state derived from a user-local
   * calendar window. Source records remain separate from projected state so
   * crossing the boundary never requires deleting history.
   */
  validity: RelativeTimeValiditySchema.optional(),
})

export const SurfaceSchema = SurfaceObjectSchema.superRefine((surface, ctx) => {
  validateNodeBindings(surface.tree, surface.state, ['tree'], ctx)
  validateRelativeTimeContract(surface, ctx)
}).transform(normalizeRelativeTimeOccurrences)

export type Surface = z.infer<typeof SurfaceSchema>
export type Freshness = z.infer<typeof FreshnessSchema>
export type RelativeTimeWindow = z.infer<typeof RelativeTimeWindowSchema>
export type RelativeTimeValidity = z.infer<typeof RelativeTimeValiditySchema>

export interface SurfaceRelativeTimeStatus {
  status: 'current' | 'expired'
  undatedRecords: number
  caveat?: string
}

export function surfaceRelativeTimeStatus(
  surface: Surface,
  now = new Date(),
): SurfaceRelativeTimeStatus | undefined {
  const validity = surface.validity
  if (!validity) return undefined

  const records = surface.state[validity.source.stateKey]
  const undatedRecords = Array.isArray(records)
    ? records.filter(
        (record) =>
          isJsonObject(record) &&
          (!Object.prototype.hasOwnProperty.call(record, validity.source.occurredAtKey) ||
            record[validity.source.occurredAtKey] === null),
      ).length
    : 0
  const instant = now.getTime()
  const status =
    instant >= Date.parse(validity.startsAt) && instant < Date.parse(validity.expiresAt)
      ? 'current'
      : 'expired'

  return {
    status,
    undatedRecords,
    ...(undatedRecords === 0
      ? {}
      : {
          caveat:
            `${undatedRecords} source ${undatedRecords === 1 ? 'record has' : 'records have'} ` +
            'no occurrence date and ' +
            `${undatedRecords === 1 ? 'is' : 'are'} excluded from this relative-time view.`,
        }),
  }
}

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

function validateRelativeTimeContract(
  surface: z.infer<typeof SurfaceObjectSchema>,
  ctx: z.RefinementCtx,
): void {
  const validity = surface.validity
  if (!validity) return

  const source = surface.state[validity.source.stateKey]
  if (!Array.isArray(source)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['validity', 'source', 'stateKey'],
      message: `relative-time source "${validity.source.stateKey}" must be an array in Surface state`,
    })
    return
  }

  source.forEach((record, index) => {
    if (!isJsonObject(record)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['state', validity.source.stateKey, index],
        message: 'relative-time source records must be objects',
      })
      return
    }

    const occurredAt = record[validity.source.occurredAtKey]
    if (occurredAt === undefined || occurredAt === null) return
    if (OccurrenceInstantSchema.safeParse(occurredAt).success) return
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['state', validity.source.stateKey, index, validity.source.occurredAtKey],
      message: 'occurrence time must be an ISO timestamp with an offset',
    })
  })

  validity.projectionStateKeys.forEach((key, index) => {
    if (key === validity.source.stateKey) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['validity', 'projectionStateKeys', index],
        message: 'relative-time source state must remain separate from projected state',
      })
      return
    }
    if (hasStateKey(surface.state, key)) return
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['validity', 'projectionStateKeys', index],
      message: `projection state key "${key}" does not exist in Surface state`,
    })
  })

  const projections = new Set(validity.projectionStateKeys)
  for (const ref of collectNodeBindingRefs(surface.tree, ['tree'])) {
    if (ref.kind === 'binding' && !projections.has(ref.key)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ref.path,
        message: `relative-time binding "${ref.key}" must be declared as a projection state key`,
      })
      continue
    }
    if (
      ref.kind === 'fastAction' &&
      (ref.key === validity.source.stateKey || projections.has(ref.key))
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ref.path,
        message: 'fast actions cannot target relative-time source or projection state',
      })
    }
  }
}

function normalizeRelativeTimeOccurrences(
  surface: z.infer<typeof SurfaceObjectSchema>,
): z.infer<typeof SurfaceObjectSchema> {
  const validity = surface.validity
  if (!validity) return surface
  const source = surface.state[validity.source.stateKey]
  if (!Array.isArray(source)) return surface

  const records = source.map((record) => {
    if (!isJsonObject(record)) return record
    const occurredAt = record[validity.source.occurredAtKey]
    if (typeof occurredAt !== 'string') return record
    return { ...record, [validity.source.occurredAtKey]: new Date(occurredAt).toISOString() }
  })
  return { ...surface, state: { ...surface.state, [validity.source.stateKey]: records } }
}

function hasStateKey(state: JsonObject, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(state, key)
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
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
