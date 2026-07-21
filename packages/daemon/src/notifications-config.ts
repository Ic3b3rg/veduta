import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { z } from 'zod'

/**
 * Notification discipline configuration (issue #18): `<rootDir>/notifications.json`.
 * Governs per-Space push interruption budgets, the quiet-hours window (evaluated in
 * an IANA timezone), and the digest threshold used when quiet-hours-deferred pushes
 * are flushed. No config file (or an empty override) means the defaults below apply.
 */
const TIME_OF_DAY_RE = /^([01]\d|2[0-3]):[0-5]\d$/

const QuietHoursWindowSchema = z
  .object({
    start: z.string().regex(TIME_OF_DAY_RE, 'quiet hours start must match HH:MM (00:00-23:59)'),
    end: z.string().regex(TIME_OF_DAY_RE, 'quiet hours end must match HH:MM (00:00-23:59)'),
  })
  .strict()

export type QuietHoursWindow = z.infer<typeof QuietHoursWindowSchema>

export const NotificationsConfigSchema = z
  .object({
    defaultDailyPushBudget: z.number().int().min(0).max(50).default(3),
    spaceBudgets: z.record(z.number().int().min(0).max(50)).default({}),
    quietHours: QuietHoursWindowSchema.nullable().default({ start: '22:00', end: '08:00' }),
    digestThreshold: z.number().int().min(1).max(20).default(3),
    timezone: z.string().optional(),
  })
  .strict()
  .superRefine((config, context) => {
    if (config.timezone === undefined) return
    try {
      // Probing for a thrown RangeError is the only way to validate an IANA name.
      new Intl.DateTimeFormat('en-US', { timeZone: config.timezone })
    } catch {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['timezone'],
        message: `timezone "${config.timezone}" is not a valid IANA time zone name`,
      })
    }
  })

export type NotificationsConfig = z.infer<typeof NotificationsConfigSchema>

export function loadNotificationsConfig(rootDir: string): NotificationsConfig {
  const path = join(rootDir, 'notifications.json')
  if (!existsSync(path)) return NotificationsConfigSchema.parse({})
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new Error(
      `invalid JSON in notifications config ${path}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  return NotificationsConfigSchema.parse(raw)
}

export function saveNotificationsConfig(rootDir: string, config: NotificationsConfig): void {
  const path = join(rootDir, 'notifications.json')
  const validated = NotificationsConfigSchema.parse(config)
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  writeFileSync(tmp, `${JSON.stringify(validated, null, 2)}\n`, 'utf8')
  renameSync(tmp, path)
}

/** Per-Space override if configured, else the daemon-wide default. */
export function budgetFor(config: NotificationsConfig, spaceId: string): number {
  return config.spaceBudgets[spaceId] ?? config.defaultDailyPushBudget
}

/** Configured IANA timezone, else the daemon process's own resolved timezone. */
export function resolveTimezone(config: NotificationsConfig): string {
  return config.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone
}

interface ZonedParts {
  year: number
  month: number
  day: number
  hour: number
  minute: number
}

/** Wall-clock date/time of `date` as observed in `timeZone`. */
function zonedParts(date: Date, timeZone: string): ZonedParts {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  })
  const parts = formatter.formatToParts(date)
  const find = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((candidate) => candidate.type === type)
    if (!part) {
      throw new Error(`Intl.DateTimeFormat produced no "${type}" part for timeZone "${timeZone}"`)
    }
    return Number(part.value)
  }
  // `hourCycle: 'h23'` should never yield 24, but guard against ICU quirks anyway.
  return {
    year: find('year'),
    month: find('month'),
    day: find('day'),
    hour: find('hour') % 24,
    minute: find('minute'),
  }
}

function minutesOfDay(hhmm: string): number {
  const [hours, minutes] = hhmm.split(':')
  return Number(hours) * 60 + Number(minutes)
}

/**
 * Converts a wall-clock date/time in `timeZone` to the UTC instant it represents.
 * Iterative offset correction: an initial guess (treating the wall-clock fields as if
 * they were UTC) is refined by re-rendering that guess in `timeZone` and shifting by
 * the observed difference, repeating until stable. Converges in 1-2 passes and is
 * DST-safe because the final pass re-derives the offset from the corrected guess.
 */
function zonedTimeToUtc(parts: ZonedParts, timeZone: string): Date {
  const desiredMs = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute)
  let guessMs = desiredMs
  for (let attempt = 0; attempt < 3; attempt++) {
    const rendered = zonedParts(new Date(guessMs), timeZone)
    const renderedMs = Date.UTC(
      rendered.year,
      rendered.month - 1,
      rendered.day,
      rendered.hour,
      rendered.minute,
    )
    const delta = desiredMs - renderedMs
    if (delta === 0) break
    guessMs += delta
  }
  return new Date(guessMs)
}

/**
 * Whether `now` falls inside `window` (wall-clock `start`..`end`, exclusive of `end`)
 * as observed in `timeZone`. Handles the midnight wrap: a window such as
 * `{ start: '22:00', end: '08:00' }` spans midnight, while `{ start: '08:00', end:
 * '22:00' }` does not. `start === end` never matches (an empty window, not a
 * full-day one) — this is a deliberate degenerate case, not a bug.
 */
export function isWithinQuietHours(now: Date, window: QuietHoursWindow, timeZone: string): boolean {
  const start = minutesOfDay(window.start)
  const end = minutesOfDay(window.end)
  if (start === end) return false
  const { hour, minute } = zonedParts(now, timeZone)
  const current = hour * 60 + minute
  if (start < end) return current >= start && current < end
  return current >= start || current < end
}

/**
 * The instant the current/next quiet window ends: the next wall-clock occurrence of
 * `window.end` in `timeZone` strictly after `now`. Meaningful regardless of whether
 * `now` currently falls inside the window (a caller arming a flush timer wants "when
 * does the window next close", not "am I in it right now").
 */
export function quietWindowEnd(now: Date, window: QuietHoursWindow, timeZone: string): Date {
  const end = minutesOfDay(window.end)
  const endHour = Math.floor(end / 60)
  const endMinute = end % 60
  const today = zonedParts(now, timeZone)
  const candidate = zonedTimeToUtc({ ...today, hour: endHour, minute: endMinute }, timeZone)
  if (candidate.getTime() > now.getTime()) return candidate
  // today's occurrence of `end` has already passed (or is exactly now) — roll to tomorrow's.
  const tomorrow = new Date(Date.UTC(today.year, today.month - 1, today.day + 1))
  return zonedTimeToUtc(
    {
      year: tomorrow.getUTCFullYear(),
      month: tomorrow.getUTCMonth() + 1,
      day: tomorrow.getUTCDate(),
      hour: endHour,
      minute: endMinute,
    },
    timeZone,
  )
}
