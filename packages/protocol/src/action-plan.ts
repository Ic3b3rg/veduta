import { z } from 'zod'
import { JsonValueSchema, type JsonValue } from './json.ts'

export const ActionKeySchema = z
  .string()
  .min(1)
  .max(160)
  .refine(
    (key) => !['__proto__', 'prototype', 'constructor'].includes(key),
    'reserved object keys cannot be Action fields',
  )
export const ActionRevisionSchema = z.string().regex(/^acr-[A-Za-z0-9-]+$/)
export const ActionIntentIdSchema = z.string().uuid()
export const ActionScalarSpecSchema = z
  .object({
    type: z.enum(['string', 'number', 'boolean', 'null']),
    nullable: z.boolean().optional(),
    enum: z
      .array(z.union([z.string(), z.number().finite(), z.boolean(), z.null()]))
      .min(1)
      .optional(),
  })
  .strict()
  .superRefine((spec, ctx) => {
    if (spec.enum?.some((value) => !scalarMatchesType(spec, value))) {
      ctx.addIssue({
        code: 'custom',
        path: ['enum'],
        message: 'enum values must match the declared scalar type',
      })
    }
  })
export type ActionScalarSpec = z.infer<typeof ActionScalarSpecSchema>
export const ActionRecordSpecSchema = z
  .object({
    type: z.literal('object'),
    identityKey: ActionKeySchema,
    fields: z.record(ActionKeySchema, ActionScalarSpecSchema),
  })
  .strict()
  .superRefine((spec, ctx) => {
    const identity = spec.fields[spec.identityKey]
    if (!identity || !['string', 'number'].includes(identity.type) || identity.nullable === true) {
      ctx.addIssue({
        code: 'custom',
        path: ['identityKey'],
        message: 'record identity must name a non-null string or number field',
      })
    }
  })
export const ActionArraySpecSchema = z
  .object({
    type: z.literal('array'),
    items: z.union([ActionScalarSpecSchema, ActionRecordSpecSchema]),
  })
  .strict()
export const ActionValueSpecSchema = z.union([ActionScalarSpecSchema, ActionArraySpecSchema])
export type ActionValueSpec = z.infer<typeof ActionValueSpecSchema>
export const ActionScalarSourceSchema = z.discriminatedUnion('source', [
  z.object({ source: z.literal('input'), name: ActionKeySchema }).strict(),
  z.object({ source: z.literal('literal'), value: JsonValueSchema }).strict(),
  z.object({ source: z.literal('metadata'), name: z.enum(['recordId', 'now']) }).strict(),
])
export const ActionValueSourceSchema = z.union([
  ActionScalarSourceSchema,
  z
    .object({
      source: z.literal('object'),
      fields: z.record(ActionKeySchema, ActionScalarSourceSchema),
    })
    .strict(),
])
export type ActionValueSource = z.infer<typeof ActionValueSourceSchema>
export const ActionStepSchema = z.discriminatedUnion('op', [
  z
    .object({ op: z.literal('set'), target: ActionKeySchema, value: ActionValueSourceSchema })
    .strict(),
  z
    .object({ op: z.literal('append'), target: ActionKeySchema, value: ActionValueSourceSchema })
    .strict(),
  z
    .object({
      op: z.literal('update'),
      target: ActionKeySchema,
      selector: ActionScalarSourceSchema,
      fields: z
        .record(ActionKeySchema, ActionScalarSourceSchema)
        .refine((fields) => Object.keys(fields).length > 0, 'update must declare fields'),
      missing: z.enum(['reject', 'noop']),
    })
    .strict(),
  z
    .object({
      op: z.literal('remove'),
      target: ActionKeySchema,
      selector: ActionScalarSourceSchema,
      missing: z.enum(['reject', 'noop']),
    })
    .strict(),
  z.object({ op: z.literal('clear'), target: ActionKeySchema, value: JsonValueSchema }).strict(),
])
export const FastActionPlanSchema = z
  .object({
    inputs: z.record(ActionKeySchema, ActionScalarSpecSchema),
    targets: z.record(ActionKeySchema, ActionValueSpecSchema),
    steps: z.array(ActionStepSchema).min(1).max(64),
  })
  .strict()
  .superRefine((plan, ctx) => {
    const keys = Object.keys(plan.targets)
    const used = new Set(plan.steps.map((step) => step.target))
    if (
      keys.length === 0 ||
      keys.length > 64 ||
      Object.keys(plan.inputs).length > 64 ||
      keys.some((key) => !used.has(key)) ||
      [...used].some((key) => !Object.hasOwn(plan.targets, key))
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['targets'],
        message: 'targets must be the exact non-empty write set (at most 64 keys)',
      })
    }
  })
export type FastActionPlan = z.infer<typeof FastActionPlanSchema>
export type ActionStep = z.infer<typeof ActionStepSchema>
function scalarMatchesType(spec: ActionScalarSpec, value: JsonValue): boolean {
  return value === null
    ? spec.type === 'null' || spec.nullable === true
    : typeof value === spec.type
}
export function actionValueMatches(
  spec: ActionValueSpec | z.infer<typeof ActionRecordSpecSchema>,
  value: JsonValue,
): boolean {
  if (spec.type !== 'array' && spec.type !== 'object') {
    return (
      scalarMatchesType(spec, value) &&
      (spec.enum === undefined || spec.enum.includes(value as string | number | boolean | null))
    )
  }
  if (spec.type === 'array')
    return Array.isArray(value) && value.every((item) => actionValueMatches(spec.items, item))
  if (value === null || Array.isArray(value) || typeof value !== 'object') return false
  const keys = Object.keys(value)
  return (
    keys.length === Object.keys(spec.fields).length &&
    keys.every((key) => {
      const field = spec.fields[key]
      return field !== undefined && actionValueMatches(field, value[key]!)
    })
  )
}
export function isActionEmptyValue(value: JsonValue): boolean {
  return (
    value === null ||
    value === '' ||
    value === false ||
    value === 0 ||
    (Array.isArray(value) && value.length === 0)
  )
}
