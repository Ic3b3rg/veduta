import {
  RelativeTimeValiditySchema,
  RelativeTimeWindowSchema,
  type RelativeTimeValidity,
  type PatchOperation,
  type JsonObject,
} from '@veduta/protocol'
import { z } from 'zod'
import { relativeTimeWindowBounds } from './timezone.ts'

/** Model-authored semantics; the Gateway owns timezone and absolute bounds. */
export const RelativeTimeAuthoringSchema = z
  .object({
    window: RelativeTimeWindowSchema,
    source: z
      .object({
        stateKey: z.string().min(1),
        occurredAtKey: z.string().min(1).default('occurredAt'),
      })
      .strict(),
    projectionStateKeys: z.array(z.string().min(1)).min(1),
  })
  .strict()
  .superRefine((contract, ctx) => {
    const seen = new Set<string>()
    contract.projectionStateKeys.forEach((key, index) => {
      if (key === contract.source.stateKey) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['projectionStateKeys', index],
          message: 'relative-time source state must remain separate from projected state',
        })
      }
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

export type RelativeTimeAuthoring = z.infer<typeof RelativeTimeAuthoringSchema>

export function buildRelativeTimeValidity(
  contract: RelativeTimeAuthoring,
  timeZone: string,
  now: Date,
): RelativeTimeValidity {
  const bounds = relativeTimeWindowBounds(timeZone, now, contract.window)
  return RelativeTimeValiditySchema.parse({
    kind: 'relative-time',
    timeZone,
    window: contract.window,
    startsAt: bounds.startsAt.toISOString(),
    expiresAt: bounds.expiresAt.toISOString(),
    source: contract.source,
    projectionStateKeys: contract.projectionStateKeys,
  })
}

export function authoringContractFromValidity(
  validity: RelativeTimeValidity,
): RelativeTimeAuthoring {
  return RelativeTimeAuthoringSchema.parse({
    window: validity.window,
    source: validity.source,
    projectionStateKeys: validity.projectionStateKeys,
  })
}

export class RelativeTimeProjectionPatchError extends Error {
  constructor(readonly missingStateKeys: string[]) {
    super(
      `relative-time patch must update every projected state key; missing: ${missingStateKeys.join(', ')}`,
    )
    this.name = 'RelativeTimeProjectionPatchError'
  }
}

/**
 * Refreshes validity only when a state patch touches the relative source or
 * one of its projections. Such a patch must carry every projection key so a
 * partial visible update cannot claim a newly-current window.
 */
export function validityAfterStatePatch(options: {
  current: RelativeTimeValidity | undefined
  authored: RelativeTimeAuthoring | undefined
  operations: PatchOperation[]
  timeZone: string
  now: Date
}): RelativeTimeValidity | undefined {
  const contract =
    options.authored ??
    (options.current === undefined ? undefined : authoringContractFromValidity(options.current))
  if (contract === undefined) return undefined

  const touched = new Set(options.operations.map((operation) => topLevelStateKey(operation.path)))
  const touchesRelativeState =
    options.authored !== undefined ||
    touched.has(contract.source.stateKey) ||
    contract.projectionStateKeys.some((key) => touched.has(key))
  if (!touchesRelativeState) return options.current

  const missing = contract.projectionStateKeys.filter((key) => !touched.has(key))
  if (missing.length > 0) throw new RelativeTimeProjectionPatchError(missing)
  return buildRelativeTimeValidity(contract, options.timeZone, options.now)
}

function topLevelStateKey(pointer: string): string {
  const [first = ''] = pointer.slice(1).split('/')
  return first.replace(/~1/g, '/').replace(/~0/g, '~')
}

export function relativeTimeSourceRecords(
  state: JsonObject,
  validity: RelativeTimeValidity,
): { current: JsonObject[]; undated: JsonObject[] } {
  const source = state[validity.source.stateKey]
  if (!Array.isArray(source)) return { current: [], undated: [] }

  const startsAt = Date.parse(validity.startsAt)
  const expiresAt = Date.parse(validity.expiresAt)
  const current: JsonObject[] = []
  const undated: JsonObject[] = []
  for (const record of source) {
    if (!isJsonObject(record)) continue
    const occurredAt = record[validity.source.occurredAtKey]
    if (typeof occurredAt !== 'string') {
      undated.push(record)
      continue
    }
    const instant = Date.parse(occurredAt)
    if (instant >= startsAt && instant < expiresAt) current.push(record)
  }
  return { current, undated }
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
