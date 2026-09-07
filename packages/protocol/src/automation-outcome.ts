import { z } from 'zod'
import { JsonValueSchema } from './json.ts'
import { surfacePath } from './surface-route.ts'

export const MAX_AUTOMATION_OUTCOME_SUMMARY_LENGTH = 240
export const MAX_AUTOMATION_RUN_HISTORY = 20
/** Versioned Gateway-owned Surface-state namespace; ordinary Surface authors cannot write it. */
export const AUTOMATION_OUTCOMES_STATE_KEY = '__vedutaAutomationOutcomesV1'

const OutcomeSummarySchema = z.string().trim().min(1).max(MAX_AUTOMATION_OUTCOME_SUMMARY_LENGTH)
const CoalesceKeySchema = z.string().trim().min(1).max(128)
const DecisionIdSchema = z.string().trim().min(1).max(300)

export const AutomationOutcomeKindSchema = z.enum([
  'unchanged',
  'changed',
  'failed',
  'recovered',
  'decision-required',
])

const AutomationRecordedOutcomeKindSchema = z.enum([
  'changed',
  'failed',
  'recovered',
  'decision-required',
])

export const AutomationOutcomeErrorSchema = z
  .object({
    code: z
      .string()
      .trim()
      .min(1)
      .max(80)
      .regex(/^[a-z0-9_-]+$/),
    message: z.string().trim().min(1).max(MAX_AUTOMATION_OUTCOME_SUMMARY_LENGTH),
  })
  .strict()

const StateSetOperationSchema = z
  .object({
    target: z.literal('state'),
    op: z.enum(['add', 'replace']),
    path: z.string().regex(/^\/.*$/),
    value: JsonValueSchema,
  })
  .strict()

const StateRemoveOperationSchema = z
  .object({
    target: z.literal('state'),
    op: z.literal('remove'),
    path: z.string().regex(/^\/.*$/),
  })
  .strict()

export const AutomationOutcomeStateOperationSchema = z
  .union([StateSetOperationSchema, StateRemoveOperationSchema])
  .superRefine((operation, context) => {
    if (
      operation.path === `/${AUTOMATION_OUTCOMES_STATE_KEY}` ||
      operation.path.startsWith(`/${AUTOMATION_OUTCOMES_STATE_KEY}/`)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['path'],
        message: 'Automation outcome state is owned by the Gateway',
      })
    }
  })

const ChangedOutcomeFields = {
  summary: OutcomeSummarySchema,
  coalesceKey: CoalesceKeySchema,
  operations: z.array(AutomationOutcomeStateOperationSchema).max(100).default([]),
}

export const AutomationOutcomeInputSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('unchanged'), summary: OutcomeSummarySchema }).strict(),
  z.object({ kind: z.literal('changed'), ...ChangedOutcomeFields }).strict(),
  z
    .object({
      kind: z.literal('failed'),
      summary: OutcomeSummarySchema,
      coalesceKey: CoalesceKeySchema,
      error: AutomationOutcomeErrorSchema,
    })
    .strict(),
  z.object({ kind: z.literal('recovered'), ...ChangedOutcomeFields }).strict(),
  z
    .object({
      kind: z.literal('decision-required'),
      summary: OutcomeSummarySchema,
      decisionId: DecisionIdSchema,
    })
    .strict(),
])

export const AutomationOutcomeStatusSchema = z
  .object({
    automationId: z.number().int().positive(),
    latest: z
      .union([
        z
          .object({
            kind: AutomationRecordedOutcomeKindSchema.exclude(['decision-required']),
            summary: OutcomeSummarySchema,
          })
          .strict(),
        z
          .object({
            kind: z.literal('decision-required'),
            summary: OutcomeSummarySchema,
            decisionId: DecisionIdSchema,
          })
          .strict(),
      ])
      .optional(),
    lastCheckedAt: z.string().datetime(),
    lastSuccessfulAt: z.string().datetime().optional(),
    currentError: AutomationOutcomeErrorSchema.optional(),
  })
  .strict()

export const AutomationOutcomeStatusesSchema = z
  .record(AutomationOutcomeStatusSchema)
  .superRefine((statuses, context) => {
    for (const [key, status] of Object.entries(statuses)) {
      if (key !== String(status.automationId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key, 'automationId'],
          message: 'status key must match automationId',
        })
      }
    }
  })

export const AutomationRunHistoryEntrySchema = z
  .object({
    id: z.string().min(1).max(160),
    automationId: z.number().int().positive(),
    scheduledFor: z.string().datetime(),
    kind: z.enum(['changed', 'failed', 'recovered']),
    summary: OutcomeSummarySchema,
    at: z.string().datetime(),
  })
  .strict()

export const AutomationRunHistorySchema = z
  .array(AutomationRunHistoryEntrySchema)
  .max(MAX_AUTOMATION_RUN_HISTORY)

export const AutomationOutcomeNotificationStateSchema = z.enum([
  'unread',
  'opened',
  'dismissed',
  'settled',
])

const AutomationOutcomeNotificationObjectSchema = z
  .object({
    id: z.string().min(1).max(160),
    revision: z.number().int().nonnegative(),
    spaceId: z.string().min(1),
    spaceSlug: z.string().min(1),
    automationId: z.number().int().positive(),
    surfaceId: z.string().min(1),
    kind: z.enum(['changed', 'failed', 'recovered']),
    title: z.string().trim().min(1).max(120),
    summary: OutcomeSummarySchema,
    coalesceKey: CoalesceKeySchema,
    occurrenceCount: z.number().int().positive(),
    state: AutomationOutcomeNotificationStateSchema,
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    href: z.string().min(1),
  })
  .strict()

export const AutomationOutcomeNotificationSchema =
  AutomationOutcomeNotificationObjectSchema.superRefine((notification, context) => {
    const expected = surfacePath(notification.spaceSlug, notification.surfaceId)
    if (notification.href !== expected) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['href'],
        message: 'notification href must be derived from its Space and Surface',
      })
    }
  })

export const AutomationOutcomeNotificationSnapshotSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    notifications: z.array(AutomationOutcomeNotificationSchema),
  })
  .strict()
  .superRefine((snapshot, context) => {
    snapshot.notifications.forEach((notification, index) => {
      if (notification.revision > snapshot.revision) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['notifications', index, 'revision'],
          message: 'notification revision cannot exceed snapshot revision',
        })
      }
    })
  })

export const AutomationOutcomeNotificationActionResultSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    notification: AutomationOutcomeNotificationSchema,
  })
  .strict()
  .superRefine((result, context) => {
    if (result.revision !== result.notification.revision) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['notification', 'revision'],
        message: 'notification revision must match the action result revision',
      })
    }
  })

export type AutomationOutcomeKind = z.infer<typeof AutomationOutcomeKindSchema>
export type AutomationOutcomeError = z.infer<typeof AutomationOutcomeErrorSchema>
export type AutomationOutcomeStateOperation = z.infer<typeof AutomationOutcomeStateOperationSchema>
export type AutomationOutcomeInput = z.infer<typeof AutomationOutcomeInputSchema>
export type AutomationOutcomeStatus = z.infer<typeof AutomationOutcomeStatusSchema>
export type AutomationOutcomeStatuses = z.infer<typeof AutomationOutcomeStatusesSchema>
export type AutomationRunHistoryEntry = z.infer<typeof AutomationRunHistoryEntrySchema>
export type AutomationOutcomeNotificationState = z.infer<
  typeof AutomationOutcomeNotificationStateSchema
>
export type AutomationOutcomeNotification = z.infer<typeof AutomationOutcomeNotificationSchema>
export type AutomationOutcomeNotificationSnapshot = z.infer<
  typeof AutomationOutcomeNotificationSnapshotSchema
>
export type AutomationOutcomeNotificationActionResult = z.infer<
  typeof AutomationOutcomeNotificationActionResultSchema
>
