import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { TIME_OF_DAY_RE, timeToCron } from './cron.ts'
import { readJsonFile } from './json-file.ts'

/**
 * Heartbeat configuration (issue #16): `<rootDir>/heartbeat.json`.
 * `times` structurally caps the heartbeat at 1-2 sweeps per day: no config
 * file (or an empty override) means the daemon runs the deterministic
 * checklist + a single triage-tier call twice a day, at the given UTC times.
 */
// Re-exported: `heartbeat.ts` and this file's own tests import `timeToCron`
// from here; the conversion itself now lives in `cron.ts`, next to the
// `nextCronOccurrence` function it feeds.
export { timeToCron }

export const HeartbeatConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    /** 1-2 UTC times-of-day, "HH:MM". */
    times: z
      .array(z.string())
      .min(1)
      .max(2)
      .default(['06:00', '18:00'])
      .superRefine((times, context) => {
        times.forEach((time, index) => {
          if (!TIME_OF_DAY_RE.test(time)) {
            context.addIssue({
              code: z.ZodIssueCode.custom,
              path: [index],
              message: `heartbeat time "${time}" must match HH:MM (00:00-23:59)`,
            })
          }
        })
        const seen = new Set<string>()
        for (const time of times) {
          if (seen.has(time)) {
            context.addIssue({
              code: z.ZodIssueCode.custom,
              path: [],
              message: `heartbeat times must be unique; "${time}" is duplicated`,
            })
            break
          }
          seen.add(time)
        }
      }),
    staleAfterHours: z.number().positive().max(720).default(24),
  })
  .strict()

export type HeartbeatConfig = z.infer<typeof HeartbeatConfigSchema>

export function loadHeartbeatConfig(rootDir: string): HeartbeatConfig {
  const path = join(rootDir, 'heartbeat.json')
  if (!existsSync(path)) return HeartbeatConfigSchema.parse({})
  return HeartbeatConfigSchema.parse(readJsonFile(path, { description: 'heartbeat config' }))
}
