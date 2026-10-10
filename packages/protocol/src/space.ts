import { z } from 'zod'

/** The one Gateway-owned System Space, classified only by this identity. */
export const SYSTEM_SPACE_ID = 'spc-system'

export const SpacePresentationSchema = z.enum(['auto', 'one-column', 'two-columns'])
export type SpacePresentation = z.infer<typeof SpacePresentationSchema>

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
  /** User-chosen responsive card arrangement; absent on older Spaces means automatic. */
  presentation: SpacePresentationSchema.optional(),
})

export type Space = z.infer<typeof SpaceSchema>
