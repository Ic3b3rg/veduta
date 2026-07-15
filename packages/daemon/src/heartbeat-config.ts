import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'

/**
 * Heartbeat configuration (issue #16): `<rootDir>/heartbeat.json`.
 * `times` structurally caps the heartbeat at 1-2 sweeps per day: no config
 * file (or an empty override) means the daemon runs the deterministic
 * checklist + a single triage-tier call twice a day, at the given UTC times.
 */
const TIME_OF_DAY_RE = /^([01]\d|2[0-3]):[0-5]\d$/

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
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new Error(
      `invalid JSON in heartbeat config ${path}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  return HeartbeatConfigSchema.parse(raw)
}

/** `'06:30'` => `'30 6 * * *'` — the cron expression the Scheduler arms for a heartbeat time. */
export function timeToCron(hhmm: string): string {
  const match = TIME_OF_DAY_RE.exec(hhmm)
  if (!match) {
    throw new Error(`invalid time-of-day "${hhmm}": expected HH:MM (00:00-23:59)`)
  }
  const [hours, minutes] = hhmm.split(':')
  return `${Number(minutes)} ${Number(hours)} * * *`
}
