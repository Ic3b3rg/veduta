import { z } from 'zod'

/**
 * A Space is a life-area namespace (CONTEXT.md): memory, Surfaces and
 * Automations live under it. Spaces are archived, never deleted.
 */
export const SpaceSchema = z.object({
  id: z.string().min(1),
  slug: z
    .string()
    .min(1)
    .regex(/^[a-z0-9-]+$/),
  name: z.string().min(1),
  archived: z.boolean().default(false),
})

export type Space = z.infer<typeof SpaceSchema>
