import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { backupFile, writeJsonAtomic } from './config-backup.ts'
import { readJsonFile } from './json-file.ts'
import { SecretRefSchema } from './model-routing.ts'
import { PreFilterRulesSchema } from './pre-filter.ts'
import { SOURCE_NAME_RE } from './taint.ts'

/**
 * Ingestion configuration (issue #12): `<dataDir>/ingestion.json`
 * declares every event source — its verification strategy, target Space,
 * rate quota and deterministic pre-filter rules. No sources are declared
 * by default: every ingress into the daemon is an explicit user decision
 * (every event source is a new perimeter, SECURITY.md §7).
 */
const CommonIngestionSourceShape = {
  /** The Space whose Event log records accepted-event notices. */
  spaceId: z.string().min(1),
  ratePerMinute: z.number().int().positive().max(600).default(60),
  filters: PreFilterRulesSchema.default(PreFilterRulesSchema.parse({})),
}

const PushIngestionSourceSchema = z.object({
  ...CommonIngestionSourceShape,
  /** How inbound pushes authenticate (webhook-verify.ts). */
  verification: z.enum(['hmac', 'query-token', 'channel-token']),
  /** Shared secret as a `secret://` reference, never plaintext. */
  secret: SecretRefSchema,
  /** How the raw push becomes ExternalEvents. */
  adapter: z.enum(['webhook', 'gmail-push', 'calendar-push']).default('webhook'),
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
  imap: z.undefined().optional(),
})

const ImapIdleSourceSchema = z.object({
  ...CommonIngestionSourceShape,
  adapter: z.literal('imap-idle'),
  imap: z.object({
    host: z.string().min(1),
    port: z.number().int().positive().max(65_535).default(993),
    authMethod: z.enum(['LOGIN', 'AUTH=LOGIN', 'AUTH=PLAIN']).default('AUTH=PLAIN'),
    usernameRef: SecretRefSchema,
    passwordRef: SecretRefSchema,
  }),
  verification: z.undefined().optional(),
  secret: z.undefined().optional(),
  gmail: z.undefined().optional(),
  calendar: z.undefined().optional(),
  google: z.undefined().optional(),
})

export const IngestionSourceSchema = z.union([PushIngestionSourceSchema, ImapIdleSourceSchema])

export type IngestionSource = z.infer<typeof IngestionSourceSchema>

export const IngestionConfigSchema = z
  .object({
    sources: z.record(IngestionSourceSchema).default({}),
  })
  .superRefine((config, context) => {
    for (const [name, source] of Object.entries(config.sources)) {
      if (!SOURCE_NAME_RE.test(name)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['sources', name],
          message: `source names must match ${SOURCE_NAME_RE.toString()} (they become untrusted Origins)`,
        })
      }
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
  return IngestionConfigSchema.parse(readJsonFile(path, { description: 'ingestion config' }))
}

/**
 * Validates `config`, backs up the existing `ingestion.json` (if any — issue #19 ingestion is a
 * wizard-driven config file), then writes the new state atomically. Ingestion sources are boot-time
 * wiring (`server.ts`): callers must restart the daemon for a saved config to take effect.
 */
export function saveIngestionConfig(rootDir: string, config: IngestionConfig): void {
  const validated = IngestionConfigSchema.parse(config)
  const path = join(rootDir, 'ingestion.json')
  backupFile(path)
  writeJsonAtomic(path, validated)
}
