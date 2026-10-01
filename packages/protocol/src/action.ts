import { z } from 'zod'
import { ActionRevisionSchema, FastActionPlanSchema } from './action-plan.ts'
import { JsonObjectSchema } from './json.ts'

/** Gateway-owned deterministic state mutation, with no client-authored target or Patch. */
export const FastActionSchema = z
  .object({
    name: z.string().min(1),
    path: z.literal('fast'),
    revision: ActionRevisionSchema.optional().describe(
      'Gateway-owned Action contract revision. Authors omit it.',
    ),
    plan: FastActionPlanSchema.describe(
      'Closed ordered mutation plan. Declare exact typed inputs, complete existing top-level state targets, and set/append/update/remove/clear steps. Values come only from owning interaction inputs, validated literals, or Gateway recordId/now metadata.',
    ),
  })
  .strict()
/** Agent-path behavior and payload remain separate from deterministic state mutation. */
export const AgentActionSchema = z
  .object({
    name: z.string().min(1),
    path: z.literal('agent').default('agent'),
    payload: JsonObjectSchema.default(() => ({})),
  })
  .strict()
export const ActionSchema = z.union([FastActionSchema, AgentActionSchema])
export const FormSubmitActionSchema = FastActionSchema.extend({ name: z.literal('submit') })
export type Action = z.infer<typeof ActionSchema>
export type ActionInput = z.input<typeof ActionSchema>
export type FastAction = z.infer<typeof FastActionSchema>
export type FormSubmitAction = z.infer<typeof FormSubmitActionSchema>
