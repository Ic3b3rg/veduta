import { z } from 'zod'
import { JsonObjectSchema } from './json.ts'

const StateKeysSchema = z
  .array(z.string().min(1))
  .min(1)
  .superRefine((stateKeys, ctx) => {
    const seen = new Set<string>()
    stateKeys.forEach((stateKey, index) => {
      if (seen.has(stateKey)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index],
          message: `duplicate state key "${stateKey}"`,
        })
      }
      seen.add(stateKey)
    })
  })

/**
 * An action an Atom can declare. `path` decides who handles it:
 * - "fast": the daemon mutates Surface state deterministically, no LLM (ADR-0003)
 * - "agent": the action is routed to the Agent as a turn
 * Defaults to "agent" — fail-safe: never silently skip the Agent.
 * Payload defaults to an empty object so the parsed protocol always has
 * a concrete JSON payload ready for the daemon or Agent path.
 * Fast actions declare either one state key or, for an atomic Form submit,
 * the complete set of state keys they mutate. A targetless fast action
 * would validate but be impossible to dispatch.
 */
export const ActionSchema = z
  .object({
    name: z.string().min(1),
    path: z.enum(['fast', 'agent']).default('agent'),
    payload: JsonObjectSchema.default(() => ({})),
    /** For fast actions: the state key this action mutates. */
    stateKey: z.string().min(1).optional(),
    /** For an atomic Form submit: every state key mutated by the payload. */
    stateKeys: StateKeysSchema.optional(),
  })
  .superRefine((action, ctx) => {
    if (action.path === 'fast' && action.stateKey === undefined && action.stateKeys === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['stateKey'],
        message: 'fast actions must declare the state key or state keys they mutate',
      })
    }
    if (action.stateKey !== undefined && action.stateKeys !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['stateKeys'],
        message: 'actions cannot declare both stateKey and stateKeys',
      })
    }
  })

export type Action = z.infer<typeof ActionSchema>
export type ActionInput = z.input<typeof ActionSchema>

/** The only action shape accepted on a v1 Form. */
export const FormSubmitActionSchema = z
  .object({
    name: z.literal('submit'),
    path: z.literal('fast'),
    payload: z
      .object({})
      .strict()
      .default(() => ({})),
    stateKeys: StateKeysSchema,
  })
  .strict()

export type FormSubmitAction = z.infer<typeof FormSubmitActionSchema>

/** The typed payload sent by a Form submit invocation. */
export const FormSubmitPayloadSchema = z.object({ value: z.record(z.string()) }).strict()

export type FormSubmitPayload = z.infer<typeof FormSubmitPayloadSchema>
