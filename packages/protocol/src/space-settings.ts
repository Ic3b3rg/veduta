import { z } from 'zod'
import { SpaceSchema, SpacePresentationSchema } from './space.ts'
import { SurfaceSchema } from './surface.ts'
import { RenderableSurfaceSchema } from './surface-read.ts'
import { AutomationRunHistorySchema } from './automation-outcome.ts'

export const ReflectionSettingsSchema = z
  .object({
    enabled: z.boolean(),
    time: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
    timezone: z.string().min(1),
    revision: z.string(),
  })
  .strict()
export const SpaceSettingsListSchema = z
  .object({ spaces: z.array(SpaceSchema), reflection: ReflectionSettingsSchema })
  .strict()
export const SettingsAutomationSchema = z
  .object({
    id: z.number().int().positive(),
    kind: z.enum(['timer', 'job']),
    description: z.string(),
    enabled: z.boolean(),
    status: z.enum(['armed', 'completed', 'cancelled']),
    cron: z.string().optional(),
    fireAt: z.string().optional(),
    nextRunAt: z.string().optional(),
    lastOutcome: z.string().max(240).optional(),
    history: AutomationRunHistorySchema,
    timezone: z.string(),
    managed: z.boolean(),
    revision: z.string(),
  })
  .strict()
export const SpaceSettingsSchema = z
  .object({
    space: SpaceSchema,
    facts: z.array(
      z.object({
        text: z.string(),
        noted: z.string().optional(),
        status: z.enum(['active', 'dormant', 'superseded']),
      }),
    ),
    instructions: z.string().nullable(),
    automations: z.array(SettingsAutomationSchema),
    surfaces: z.array(SurfaceSchema),
  })
  .strict()

/** Client reads preserve future Atom metadata; canonical Gateway writes remain strict. */
export const RenderableSpaceSettingsSchema = SpaceSettingsSchema.extend({
  surfaces: z.array(RenderableSurfaceSchema),
})
export const AutomationSettingsChangeSchema = z
  .object({
    expectedRevision: z.string().min(1),
    enabled: z.boolean().optional(),
    description: z.string().trim().min(1).max(16000).optional(),
    cron: z.string().trim().min(1).max(100).optional(),
    fireAt: z.string().datetime({ offset: true }).optional(),
  })
  .strict()
export const SpaceSettingsCommandSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('archive') }).strict(),
  z.object({ action: z.literal('restore') }).strict(),
  z.object({ action: z.literal('presentation'), presentation: SpacePresentationSchema }).strict(),
  z
    .object({
      action: z.literal('fact'),
      text: z.string().trim().min(1).max(32000),
      supersedes: z.string().min(1).optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal('instructions'),
      text: z.string().max(16000),
      expectedText: z.string(),
    })
    .strict(),
  z
    .object({
      action: z.literal('automation'),
      automationId: z.number().int().positive(),
      change: AutomationSettingsChangeSchema,
    })
    .strict(),
])
export const ReflectionSettingsChangeSchema = z
  .object({
    enabled: z.boolean(),
    time: ReflectionSettingsSchema.shape.time,
    expectedRevision: z.string().min(1),
  })
  .strict()
export type SpaceSettings = z.infer<typeof SpaceSettingsSchema>
export type RenderableSpaceSettings = z.infer<typeof RenderableSpaceSettingsSchema>
export type SpaceSettingsList = z.infer<typeof SpaceSettingsListSchema>
export type SpaceSettingsCommand = z.infer<typeof SpaceSettingsCommandSchema>
export type SettingsAutomation = z.infer<typeof SettingsAutomationSchema>
export type AutomationSettingsChange = z.infer<typeof AutomationSettingsChangeSchema>
