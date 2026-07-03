import { z } from 'zod'

/**
 * Minimal state patch: sets keys in a Surface's typed state.
 * Tree patches (restructuring) arrive with issue #7.
 */
export const StatePatchSchema = z.object({
  surfaceId: z.string().min(1),
  set: z.record(z.unknown()),
})

export type StatePatch = z.infer<typeof StatePatchSchema>

/** A fast-path action invocation sent by a client to the daemon. */
export const ActionInvocationSchema = z.object({
  nodeId: z.string().min(1),
  name: z.string().min(1),
  payload: z.record(z.unknown()).optional(),
})

export type ActionInvocation = z.infer<typeof ActionInvocationSchema>
