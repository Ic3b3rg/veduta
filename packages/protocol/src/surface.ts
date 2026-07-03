import { z } from 'zod'
import { AtomNodeSchema } from './atom.ts'

/**
 * A Surface is living state, not a response (CONTEXT.md): a declarative
 * tree of Atoms bound to typed state, owned by a Space. Freshness metadata
 * is mandatory — a stale Surface presented as current destroys trust.
 */
export const FreshnessSchema = z.object({
  updatedAt: z.string().datetime(),
  updatedBy: z.enum(['agent', 'user', 'job', 'seed']),
})

export const SurfaceSchema = z.object({
  id: z.string().min(1),
  spaceId: z.string().min(1),
  title: z.string().min(1),
  tree: AtomNodeSchema,
  state: z.record(z.unknown()),
  freshness: FreshnessSchema,
})

export type Surface = z.infer<typeof SurfaceSchema>
export type Freshness = z.infer<typeof FreshnessSchema>
