import { parseCron, type CronSchedule } from '@veduta/protocol'
import { assertTimeZone, zonedParts, zonedTimeToUtc } from './timezone.ts'

export { parseCron, type CronSchedule } from '@veduta/protocol'
/** How far nextCronOccurrence searches before declaring the expression unsatisfiable. */
const MAX_SEARCH_DAYS = 366 * 5

/** `HH:MM`, `00:00` through `23:59`. */
export const TIME_OF_DAY_RE = /^([01]\d|2[0-3]):[0-5]\d$/

/**
 * Converts a `"HH:MM"` time-of-day to the daily cron expression the
 * Scheduler arms for it (e.g. `'06:30'` => `'30 6 * * *'`). Lives here
 * rather than in the heartbeat config schema that merely validates the
 * string shape, because this function's output — a cron expression — is
 * exactly what `nextCronOccurrence` consumes; the nightly Reflection job
 * (issue #21) is a second caller reaching for the same conversion.
 */
export function timeToCron(hhmm: string): string {
  const match = TIME_OF_DAY_RE.exec(hhmm)
  if (!match) {
    throw new Error(`invalid time-of-day "${hhmm}": expected HH:MM (00:00-23:59)`)
  }
  const [hours, minutes] = hhmm.split(':')
  return `${Number(minutes)} ${Number(hours)} * * *`
}

/**
 * The first occurrence strictly after `after`.
 *
 * Without `timezone`, the five cron fields are UTC — the historical and
 * default interpretation, unchanged for every existing Automation (issue
 * #11) and for `create_job`'s tool description, which promises UTC.
 *
 * With `timezone`, the five cron fields are local wall-clock time in that
 * zone instead (issue #21: the nightly Reflection job fires at 04:00
 * user-local, not 04:00 wherever the daemon happens to be deployed, so a
 * fixed UTC cron would drift across DST transitions). Calendar days are
 * walked in the zone's own local calendar via `zonedParts`, and each
 * matching local (day, hour, minute) is converted to a UTC instant via
 * `zonedTimeToUtc`, which already resolves the two ways a local time can
 * fail to name exactly one instant, so this function does not reimplement
 * them:
 *
 * - Spring forward (the local time never occurs): the transition instant
 *   itself runs the job — slightly early rather than never.
 * - Fall back (the local time occurs twice): only the earlier of the two
 *   real instants runs the job, never both.
 *
 * Either way, the result is guaranteed strictly after `after`: a converted
 * instant that is not strictly after `after` is rejected and the search
 * keeps walking, so a nominal occurrence can never be returned twice.
 */
export function nextCronOccurrence(expression: string, after: Date, timezone?: string): Date {
  const schedule = parseCron(expression)

  if (timezone === undefined) {
    const start = new Date(after.getTime())
    start.setUTCSeconds(0, 0)
    start.setUTCMinutes(start.getUTCMinutes() + 1)
    return search(
      schedule,
      expression,
      start,
      (day, hour, minute) =>
        new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), hour, minute)),
    )
  }

  assertTimeZone(timezone)
  const local = zonedParts(timezone, after)
  // A naive calendar/clock scratchpad, exactly like the UTC branch's
  // `start`: `local`'s fields reinterpreted as if they were UTC, purely so
  // `setUTCMinutes`/`setUTCDate` can do calendar arithmetic on them. Real
  // instants only appear once `toInstant` calls `zonedTimeToUtc` below.
  const start = new Date(Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute))
  start.setUTCMinutes(start.getUTCMinutes() + 1)

  return search(schedule, expression, start, (day, hour, minute) => {
    const instant = zonedTimeToUtc(timezone, {
      year: day.getUTCFullYear(),
      month: day.getUTCMonth() + 1,
      day: day.getUTCDate(),
      hour,
      minute,
    })
    // Reject a candidate that does not land strictly after `after`: the
    // earlier side of a fall-back overlap could otherwise coincide with an
    // instant already passed, and a nominal occurrence must never repeat.
    return instant.getTime() > after.getTime() ? instant : undefined
  })
}

/**
 * Walks calendar days starting at `start` (a UTC-or-naive-local clock
 * scratchpad — see the two call sites in `nextCronOccurrence`), looking
 * for the first `(day, hour, minute)` the schedule matches. `toInstant`
 * turns a match into a real instant, or `undefined` to reject it and keep
 * walking (used by the zoned path's strictly-after guard).
 */
function search(
  schedule: CronSchedule,
  expression: string,
  start: Date,
  toInstant: (day: Date, hour: number, minute: number) => Date | undefined,
): Date {
  const sortedHours = [...schedule.hours].sort((a, b) => a - b)
  const sortedMinutes = [...schedule.minutes].sort((a, b) => a - b)

  const day = new Date(start.getTime())
  for (let steps = 0; steps < MAX_SEARCH_DAYS; steps += 1) {
    if (
      dayMatches(schedule, {
        month: day.getUTCMonth() + 1,
        day: day.getUTCDate(),
        dayOfWeek: day.getUTCDay(),
      })
    ) {
      const first = steps === 0
      for (const hour of sortedHours) {
        if (first && hour < day.getUTCHours()) continue
        for (const minute of sortedMinutes) {
          if (first && hour === day.getUTCHours() && minute < day.getUTCMinutes()) continue
          const instant = toInstant(day, hour, minute)
          if (instant) return instant
        }
      }
    }
    day.setUTCDate(day.getUTCDate() + 1)
    day.setUTCHours(0, 0, 0, 0)
  }
  throw new Error(`cron "${expression}" has no occurrence within ${MAX_SEARCH_DAYS} days`)
}

function dayMatches(
  schedule: CronSchedule,
  parts: { month: number; day: number; dayOfWeek: number },
): boolean {
  if (!schedule.months.has(parts.month)) return false
  const domMatch = schedule.daysOfMonth.has(parts.day)
  const dowMatch = schedule.daysOfWeek.has(parts.dayOfWeek)
  if (schedule.domRestricted && schedule.dowRestricted) return domMatch || dowMatch
  return domMatch && dowMatch
}
