import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { TIME_OF_DAY_RE } from './cron.ts'
import { readJsonFile } from './json-file.ts'
import { assertTimeZone } from './timezone.ts'

export const DEFAULT_MEMORY_BUDGET = {
  low: 4000,
  high: 6000,
  hard: 8000,
} as const

export const MemoryBudgetSchema = z
  .object({
    /** UTF-16 code units of the rendered active FACTS projection. Reflection
     * must bring the active set back under this by demoting the
     * least-relevant still-valid facts to `dormant`. */
    low: z.number().int().positive().default(DEFAULT_MEMORY_BUDGET.low),
    /** Crossing this watermark marks the Space's next Reflection pending. */
    high: z.number().int().positive().default(DEFAULT_MEMORY_BUDGET.high),
    /** The largest rendered active projection an ordinary write may reach. */
    hard: z.number().int().positive().default(DEFAULT_MEMORY_BUDGET.hard),
  })
  .strict()
  .superRefine((budget, context) => {
    if (budget.low >= budget.high) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'memory budget low must be less than high',
        path: ['low'],
      })
    }
    if (budget.high >= budget.hard) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'memory budget high must be less than hard',
        path: ['high'],
      })
    }
  })

export type MemoryBudget = z.infer<typeof MemoryBudgetSchema>

/**
 * Memory configuration (issue #21): `<rootDir>/memory.json`.
 * `SpaceSchema` has no notion of a user timezone today, so this is where
 * one is established for the whole daemon: it anchors time-aware queries
 * ("start of June") and the nightly Reflection's firing time
 * (docs/adr/0006-file-based-memory.md) to the user's own clock rather than
 * wherever the daemon happens to be deployed. No config file (or an empty
 * override) means the defaults below apply.
 */
export const MemoryConfigSchema = z
  .object({
    /** IANA zone name. Every local-time interpretation in memory (Reflection's
     * firing time, "start of X" query ranges) resolves against this, never
     * the deployment host's own zone. */
    timezone: z
      .string()
      .default('UTC')
      .superRefine((zone, context) => {
        try {
          assertTimeZone(zone)
        } catch (error) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: error instanceof Error ? error.message : `invalid time zone "${zone}"`,
          })
        }
      }),
    reflection: z
      .object({
        enabled: z.boolean().default(true),
        /** HH:MM, interpreted in `timezone` (not UTC) — the nightly sweep that
         * distills the day's Event log and demotes stale facts to `dormant`. */
        time: z
          .string()
          .default('04:00')
          .superRefine((time, context) => {
            if (!TIME_OF_DAY_RE.test(time)) {
              context.addIssue({
                code: z.ZodIssueCode.custom,
                message: `reflection time "${time}" must match HH:MM (00:00-23:59)`,
              })
            }
          }),
      })
      .strict()
      .default({}),
    budget: MemoryBudgetSchema.default({}),
  })
  .strict()

export type MemoryConfig = z.infer<typeof MemoryConfigSchema>

export function loadMemoryConfig(rootDir: string): MemoryConfig {
  const path = join(rootDir, 'memory.json')
  if (!existsSync(path)) return MemoryConfigSchema.parse({})
  return MemoryConfigSchema.parse(readJsonFile(path, { description: 'memory config' }))
}
