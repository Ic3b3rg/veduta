import { z } from 'zod'

/**
 * An action an Atom can declare. `path` decides who handles it:
 * - "fast": the daemon mutates Surface state deterministically, no LLM (ADR-0003)
 * - "agent": the action is routed to the Agent as a turn
 * Defaults to "agent" — fail-safe: never silently skip the Agent.
 */
export const ActionSchema = z.object({
  name: z.string().min(1),
  path: z.enum(['fast', 'agent']).default('agent'),
  /** For fast actions: the state key this action mutates. */
  stateKey: z.string().optional(),
})

export type Action = z.infer<typeof ActionSchema>
