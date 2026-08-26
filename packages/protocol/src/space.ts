import { z } from 'zod'

/** The one Gateway-owned System Space, classified only by this identity. */
export const SYSTEM_SPACE_ID = 'spc-system'

/**
 * A user-authored Space is a life-area namespace (CONTEXT.md): memory,
 * Surfaces and Automations live under it. The canonical System Space is the
 * one Gateway-owned exception. User-authored Spaces are archived, never deleted.
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
