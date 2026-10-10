import { z } from 'zod'

const shared = {
  timezone: z.string().trim().min(1).max(100).optional(),
  nextRunAt: z.string().datetime({ offset: true }).optional(),
  status: z.enum(['armed', 'completed', 'cancelled']).optional(),
  lastOutcome: z.string().max(240).optional(),
}

/** Canonical schedule inputs; the browser owns their localized presentation. */
export const AutomationScheduleSchema = z.discriminatedUnion('kind', [
  z.object({ ...shared, kind: z.literal('job'), cron: z.string().max(240).optional() }).strict(),
  z
    .object({
      ...shared,
      kind: z.literal('timer'),
      fireAt: z.string().datetime({ offset: true }).optional(),
    })
    .strict(),
])

export type AutomationSchedule = z.infer<typeof AutomationScheduleSchema>
