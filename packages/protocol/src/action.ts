import { z } from 'zod'
import { JsonObjectSchema } from './json.ts'

/**
 * An action an Atom can declare. `path` decides who handles it:
 * - "fast": the daemon mutates Surface state deterministically, no LLM (ADR-0003)
 * - "agent": the action is routed to the Agent as a turn
 * Defaults to "agent" — fail-safe: never silently skip the Agent.
 * Payload defaults to an empty object so the parsed protocol always has
 * a concrete JSON payload ready for the daemon or Agent path.
 * Fast actions must declare the state key they mutate: a fast action
 * without a stateKey would validate but be impossible to dispatch.
 */
export const ActionSchema = z
  .object({
    name: z.string().min(1),
    path: z.enum(['fast', 'agent']).default('agent'),
    payload: JsonObjectSchema.default(() => ({})),
    /** For fast actions: the state key this action mutates. */
    stateKey: z.string().min(1).optional(),
  })
  .superRefine((action, ctx) => {
    if (action.path === 'fast' && !action.stateKey) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['stateKey'],
        message: 'fast actions must declare the stateKey they mutate',
      })
    }
  })

export type Action = z.infer<typeof ActionSchema>
export type ActionInput = z.input<typeof ActionSchema>
