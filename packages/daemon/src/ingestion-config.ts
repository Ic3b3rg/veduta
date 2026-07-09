import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { SecretRefSchema } from './model-routing.ts'
import { PreFilterRulesSchema } from './pre-filter.ts'

/**
 * Ingestion configuration (issue #12): `<dataDir>/ingestion.json`
 * declares every event source — its verification strategy, target Space,
 * rate quota and deterministic pre-filter rules. No sources are declared
 * by default: every ingress into the daemon is an explicit user decision
 * (every event source is a new perimeter, SECURITY.md §7).
 */
export const IngestionSourceSchema = z.object({
  /** How inbound pushes authenticate (webhook-verify.ts). */
  verification: z.enum(['hmac', 'query-token', 'channel-token']),
  /** Shared secret as a `secret://` reference, never plaintext. */
  secret: SecretRefSchema,
  /** The Space whose Event log records accepted-event notices. */
  spaceId: z.string().min(1),
  /** How the raw push becomes ExternalEvents. */
  adapter: z.enum(['webhook', 'gmail-push', 'calendar-push']).default('webhook'),
  ratePerMinute: z.number().int().positive().max(600).default(60),
  filters: PreFilterRulesSchema.default(PreFilterRulesSchema.parse({})),
  /** Required by the gmail-push adapter. */
  gmail: z
    .object({
      /** Pub/Sub topic passed to users.watch. */
      topicName: z.string().min(1),
      /** Full subscription name expected in the push envelope. */
      subscription: z.string().min(1),
    })
    .optional(),
  /** Required by the calendar-push adapter. */
  calendar: z
    .object({
      calendarId: z.string().min(1),
      /** Public HTTPS address Google pushes to (the daemon's ingest URL). */
      address: z.string().url(),
    })
    .optional(),
  /** OAuth material for the Google fetch stages, as secret refs. */
  google: z
    .object({
      clientIdRef: SecretRefSchema,
      clientSecretRef: SecretRefSchema,
      refreshTokenRef: SecretRefSchema,
    })
    .optional(),
})

export type IngestionSource = z.infer<typeof IngestionSourceSchema>

export const IngestionConfigSchema = z
  .object({
    sources: z.record(IngestionSourceSchema).default({}),
  })
  .superRefine((config, context) => {
    for (const [name, source] of Object.entries(config.sources)) {
      if (source.adapter === 'gmail-push' && (!source.gmail || !source.google)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['sources', name],
          message: 'gmail-push sources need both `gmail` and `google` settings',
        })
      }
      if (source.adapter === 'calendar-push' && (!source.calendar || !source.google)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['sources', name],
          message: 'calendar-push sources need both `calendar` and `google` settings',
        })
      }
    }
  })

export type IngestionConfig = z.infer<typeof IngestionConfigSchema>

export function loadIngestionConfig(rootDir: string): IngestionConfig {
  const path = join(rootDir, 'ingestion.json')
  if (!existsSync(path)) return IngestionConfigSchema.parse({})
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new Error(
      `invalid JSON in ingestion config ${path}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  return IngestionConfigSchema.parse(raw)
}
